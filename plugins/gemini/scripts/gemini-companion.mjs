#!/usr/bin/env node
// Single CLI entry point for the gemini plugin. Spawns the Antigravity CLI (`agy`) per review/task.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildAgyArgs,
  buildPermissionSettings,
  compareVersions,
  getAgyVersion,
  listAgyModels,
  MIN_AGY_VERSION,
  resolveAgyBinary,
  runAgy,
  TESTED_AGY_VERSION
} from "./lib/agy.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { generateJobId, getConfig, setConfig, upsertJob, writeJobFile, readJobFile, resolveJobFile } from "./lib/state.mjs";
import {
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { renderReviewResult, renderSetupReport, renderTaskResult } from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_REVIEW_TIMEOUT_SECONDS = 900;
const KILL_TIMER_MARGIN_SECONDS = 30;
const AUTH_PROBE_TIMEOUT_SECONDS = 60;
const DEFAULT_GATE_MODEL = "gemini-3.8-flash-low";
const MAX_PROMPT_CHARS = 100_000;
const SETUP_HINT = "Run `/gemini:setup` to check the Antigravity CLI (agy) installation and sign-in.";
const INSTALL_COMMANDS = {
  unix: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  win32: "irm https://antigravity.google/cli/install.ps1 | iex"
};

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [--timeout <s>] [--json] [focus text]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [--timeout <s>] [--json] [focus text]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function parseTimeoutSeconds(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Invalid --timeout "${value}": use a whole number of seconds greater than 0.`);
  }
  return seconds;
}

function installCommandFor(platform = process.platform) {
  return platform === "win32" ? INSTALL_COMMANDS.win32 : INSTALL_COMMANDS.unix;
}

// ---------------------------------------------------------------------------
// agy availability

function inspectAgy(env = process.env) {
  const bin = resolveAgyBinary(env);
  const base = {
    available: false,
    supported: false,
    path: bin,
    version: null,
    tested: false,
    minVersion: MIN_AGY_VERSION,
    testedVersion: TESTED_AGY_VERSION,
    detail: null,
    installCommand: null
  };
  if (!bin) {
    return { ...base, detail: "not found", installCommand: installCommandFor() };
  }
  const version = getAgyVersion(bin);
  if (!version.ok) {
    return { ...base, detail: `not found (${version.detail})`, installCommand: installCommandFor() };
  }
  const supported = compareVersions(version.version, MIN_AGY_VERSION) >= 0;
  const tested = version.version === TESTED_AGY_VERSION;
  let detail = `${bin} (version ${version.version})`;
  if (!supported) {
    detail += ` is older than the minimum supported version ${MIN_AGY_VERSION}`;
  }
  return { ...base, available: true, supported, version: version.version, tested, detail };
}

function agyUnavailableMessage(agy) {
  if (!agy.available) {
    return `The Antigravity CLI (agy) was not found. ${SETUP_HINT}`;
  }
  return `agy ${agy.version} is older than the minimum supported version ${MIN_AGY_VERSION}. ${SETUP_HINT}`;
}

// ---------------------------------------------------------------------------
// setup

async function probeAgyAuth(bin, cwd) {
  const args = buildAgyArgs({
    prompt: "Reply with OK",
    printTimeoutSeconds: AUTH_PROBE_TIMEOUT_SECONDS,
    settingsJson: buildPermissionSettings({})
  });
  const result = await runAgy({
    bin,
    args,
    cwd,
    timeoutMs: (AUTH_PROBE_TIMEOUT_SECONDS + KILL_TIMER_MARGIN_SECONDS) * 1000
  });
  const { state, reason } = result.classification;
  if (state === "completed" || state === "completed-with-denials") {
    return { ok: true, detail: "authenticated" };
  }
  return { ok: false, detail: `Run !agy to sign in${reason ? ` (agy check failed: ${reason})` : ""}` };
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const agy = inspectAgy();
  const usable = agy.available && agy.supported;
  const auth = usable ? await probeAgyAuth(agy.path, workspaceRoot) : { ok: false, detail: "not checked (agy unavailable)" };
  const models = agy.available ? listAgyModels(agy.path) : [];
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!agy.available) {
    nextSteps.push(`Install the Antigravity CLI with \`${agy.installCommand}\`, then run \`!agy\` to sign in.`);
  } else if (!agy.supported) {
    nextSteps.push(`Update agy to ${MIN_AGY_VERSION} or newer (tested with ${TESTED_AGY_VERSION}).`);
  } else if (!auth.ok) {
    nextSteps.push("Run `!agy` to sign in, then rerun `/gemini:setup`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: usable && auth.ok,
    agy,
    auth,
    models,
    reviewGate: {
      enabled: Boolean(config.stopReviewGate),
      model: config.gateModel ?? DEFAULT_GATE_MODEL
    },
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const report = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ---------------------------------------------------------------------------
// reviews

function readReviewSchema() {
  const text = fs.readFileSync(REVIEW_SCHEMA, "utf8");
  return { text: text.trim(), schema: JSON.parse(text) };
}

function buildDiffCommand(context) {
  if (context.target.mode === "working-tree") {
    return "git diff HEAD";
  }
  return `git diff ${context.comparison?.reviewRange ?? `${context.target.baseRef}...HEAD`}`;
}

function buildReviewPrompt(templateName, context, focusText, schemaText) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    TARGET_SUMMARY: context.summary,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    DIFF_COMMAND: buildDiffCommand(context),
    OUTPUT_SCHEMA: schemaText,
    REVIEW_INPUT: context.content
  });
}

function matchesRequiredKeys(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (schema.required ?? []).every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// Prefer agy's structured_output; fall back to the response text when it parses as matching JSON.
function extractReviewOutput(run, schema) {
  if (matchesRequiredKeys(run.structuredOutput, schema)) {
    return run.structuredOutput;
  }
  const parsed = tryParseJson(run.response);
  return matchesRequiredKeys(parsed, schema) ? parsed : null;
}

function appendDeniedActions(rendered, deniedActions) {
  if (!deniedActions?.length) {
    return rendered;
  }
  const lines = ["", "Denied actions:", ...deniedActions.map((d) => `- ${d.displayName || d.action || "unknown"}`)];
  return `${rendered.trimEnd()}\n${lines.join("\n")}\n`;
}

function renderReviewFailure(reviewLabel, targetLabel, result, jobId) {
  const header = `# Gemini ${reviewLabel}\n\nTarget: ${targetLabel}\n\n`;
  return header + renderTaskResult(result, { jobId });
}

function forwardAgyEvent(event, { progress, job }) {
  if (event.event === "init" && event.conversation_id) {
    upsertJob(job.workspaceRoot, { id: job.id, conversationId: event.conversation_id });
    progress?.({ message: `Gemini conversation ${event.conversation_id} started.`, phase: "reviewing" });
    return;
  }
  const step = event.event === "step_update" ? event.step_update : null;
  if (step?.step_type === "tool" && step.state === "ACTIVE") {
    const name = step.tool_info?.name ?? step.tool_name ?? "tool";
    const command = step.tool_info?.parameters?.CommandLine;
    progress?.({ message: command ? `Running ${name}: ${command}` : `Running ${name}.`, phase: "investigating" });
  }
}

async function executeReviewRun(request) {
  const { job, agyBin, prompt, context, reviewName, schema, timeoutSeconds, onProgress } = request;
  const args = buildAgyArgs({
    prompt,
    model: request.model,
    jsonSchemaPath: REVIEW_SCHEMA,
    printTimeoutSeconds: timeoutSeconds,
    settingsJson: buildPermissionSettings({})
  });

  onProgress?.({ message: `Starting Gemini ${reviewName} of ${context.target.label}.`, phase: "starting" });
  const result = await runAgy({
    bin: agyBin,
    args,
    cwd: context.repoRoot,
    timeoutMs: (timeoutSeconds + KILL_TIMER_MARGIN_SECONDS) * 1000,
    onEvent: (event) => forwardAgyEvent(event, { progress: onProgress, job }),
    onStderrLine: (line) => {
      if (line.trim()) {
        onProgress?.({ message: `agy: ${line.trim()}`, stderrMessage: "" });
      }
    },
    onSpawn: (pid) => upsertJob(job.workspaceRoot, { id: job.id, agyPid: pid })
  });

  const { run, classification } = result;
  const rawOutput = run.response ?? "";
  const meta = {
    reviewLabel: reviewName,
    targetLabel: context.target.label,
    usage: run.usage,
    conversationId: run.conversationId
  };

  let state = classification.state;
  let reason = classification.reason;
  let structuredOutput = null;
  let rendered;

  if (state === "completed" || state === "completed-with-denials") {
    structuredOutput = extractReviewOutput(run, schema);
    if (structuredOutput) {
      rendered = appendDeniedActions(renderReviewResult(structuredOutput, meta), run.deniedActions);
    } else {
      state = "failed";
      reason = "review output did not match schema";
      rendered = renderReviewResult(null, { ...meta, parseError: reason, rawOutput });
    }
  } else {
    rendered = renderReviewFailure(
      reviewName,
      context.target.label,
      {
        response: rawOutput,
        classification,
        deniedActions: run.deniedActions,
        usage: run.usage,
        conversationId: run.conversationId
      },
      job.id
    );
  }

  const ok = structuredOutput != null;
  const payload = {
    ok,
    state,
    reason,
    hint: classification.hint,
    jobId: job.id,
    review: reviewName,
    target: context.target,
    rendered,
    structuredOutput,
    rawOutput,
    parseError: ok ? null : reason,
    conversationId: run.conversationId,
    deniedActions: run.deniedActions,
    usage: run.usage,
    exitCode: result.exitCode
  };

  return {
    exitStatus: ok ? 0 : 1,
    payload,
    rendered,
    summary: structuredOutput?.summary ?? reason ?? firstMeaningfulLine(rawOutput, `${reviewName} finished.`),
    agy: {
      conversationId: run.conversationId,
      agyState: state,
      deniedActions: run.deniedActions,
      usage: run.usage
    }
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function createReviewJob(workspaceRoot, metadata) {
  return createJobRecord({
    id: generateJobId("review"),
    kind: metadata.kind,
    kindLabel: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
}

function patchJobWithAgyOutcome(job, agy) {
  if (!agy) {
    return;
  }
  const patch = { id: job.id, ...agy, agyPid: null };
  upsertJob(job.workspaceRoot, patch);
  const jobFile = resolveJobFile(job.workspaceRoot, job.id);
  if (fs.existsSync(jobFile)) {
    writeJobFile(job.workspaceRoot, job.id, { ...readJobFile(jobFile), ...patch });
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({
    stderr: !options.json,
    logFile,
    onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  patchJobWithAgyOutcome(job, execution.agy);
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function outputEarlyReviewResult({ state, rendered, ok }, asJson, exitCode = 0) {
  outputResult(asJson ? { ok, state, jobId: null, rendered, rawOutput: "" } : rendered, asJson);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "timeout"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const reviewName = config.reviewName;
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_REVIEW_TIMEOUT_SECONDS);

  const agy = inspectAgy();
  if (!agy.available || !agy.supported) {
    const rendered = `# Gemini ${reviewName}\n\n${agyUnavailableMessage(agy)}\n`;
    outputEarlyReviewResult({ ok: false, state: "unavailable", rendered }, options.json, 1);
    return;
  }

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target, { includeDiff: false });
  if (context.changedFiles.length === 0) {
    const rendered = `# Gemini ${reviewName}\n\nTarget: ${target.label}\n\nNothing to review: no changes found for ${target.label}.\n`;
    outputEarlyReviewResult({ ok: true, state: "nothing-to-review", rendered }, options.json);
    return;
  }

  const { text: schemaText, schema } = readReviewSchema();
  const prompt = buildReviewPrompt(config.templateName, context, focusText, schemaText);
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `The review prompt is ${prompt.length} characters, over the 100000-character limit. Narrow the review with --base <ref> or --scope, or shorten the focus text.`
    );
  }

  const job = createReviewJob(workspaceRoot, buildReviewJobMetadata(reviewName, target));
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        job,
        agyBin: agy.path,
        prompt,
        context,
        reviewName,
        schema,
        model: options.model,
        timeoutSeconds,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review", templateName: "review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review", templateName: "adversarial-review" });
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
