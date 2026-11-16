#!/usr/bin/env node
// Single CLI entry point for the gemini plugin. Spawns the Antigravity CLI (`agy`) per review/task.

import { spawn } from "node:child_process";
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
  resolveAgyBinaryInfo,
  runAgy,
  TESTED_AGY_VERSION
} from "./lib/agy.mjs";
import { stripSkipPermissionsAdvice } from "./lib/agy-events.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile,
  readJobFile,
  resolveJobFile
} from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_REVIEW_TIMEOUT_SECONDS = 900;
const DEFAULT_TASK_TIMEOUT_SECONDS = 1800;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation state. Pick the next highest-value step and follow through until the task is resolved.";
const AUTO_MODE_UNAVAILABLE_MARKER = "--mode auto is not available";
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
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <id>] [--timeout <s>] [--json] [focus text]",
      "  node scripts/gemini-companion.mjs task [--background] [--write|--read-only] [--auto] [--allow <prefix>]... [--resume-last] [--model <id>] [--effort <lvl>] [--timeout <s>] [--json] [prompt]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]",
      "  node scripts/gemini-companion.mjs status [job-id] [--wait] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
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

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
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
  const resolution = resolveAgyBinaryInfo(env);
  const bin = resolution.bin;
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
    return { ...base, detail: resolution.detail ?? "not found", installCommand: installCommandFor() };
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
    printTimeoutSeconds: AUTH_PROBE_TIMEOUT_SECONDS,
    settingsJson: buildPermissionSettings({})
  });
  const result = await runAgy({
    bin,
    args,
    prompt: "Reply with OK",
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
    ok: usable && auth.ok,
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
    if (context.target.unbornHead) {
      return "git status --porcelain; git diff --cached; read untracked files listed by git status (do not use HEAD)";
    }
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
    progress?.({
      message: `Gemini conversation ${event.conversation_id} started.`,
      phase: job.jobClass === "task" ? "running" : "reviewing"
    });
    return;
  }
  const step = event.event === "step_update" ? event.step_update : null;
  if (step?.step_type === "tool" && step.state === "ACTIVE") {
    const name = step.tool_info?.name ?? step.tool_name ?? "tool";
    const command = step.tool_info?.parameters?.CommandLine;
    progress?.({ message: command ? `Running ${name}: ${command}` : `Running ${name}.`, phase: "investigating" });
  }
}

function forwardAgyStderr(line, onProgress) {
  const text = stripSkipPermissionsAdvice(line).trim();
  if (text) {
    onProgress?.({ message: `agy: ${text}`, stderrMessage: "" });
  }
}

async function executeReviewRun(request) {
  const { job, agyBin, prompt, context, reviewName, schema, timeoutSeconds, onProgress } = request;
  const args = buildAgyArgs({
    model: request.model,
    jsonSchemaPath: REVIEW_SCHEMA,
    printTimeoutSeconds: timeoutSeconds,
    settingsJson: buildPermissionSettings({})
  });

  onProgress?.({ message: `Starting Gemini ${reviewName} of ${context.target.label}.`, phase: "starting" });
  const result = await runAgy({
    bin: agyBin,
    args,
    prompt,
    cwd: context.repoRoot,
    timeoutMs: (timeoutSeconds + KILL_TIMER_MARGIN_SECONDS) * 1000,
    onEvent: (event) => forwardAgyEvent(event, { progress: onProgress, job }),
    onStderrLine: (line) => forwardAgyStderr(line, onProgress),
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

  const denied = state === "completed-with-denials";
  const ok = structuredOutput != null && !denied;
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
    parseError: ok ? null : (reason ?? (denied ? "one or more actions were denied" : null)),
    conversationId: run.conversationId,
    deniedActions: run.deniedActions,
    usage: run.usage,
    exitCode: result.exitCode
  };

  return {
    exitStatus: denied ? 2 : (ok ? 0 : 1),
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

// ---------------------------------------------------------------------------
// tasks

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return [];
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// Only finished task jobs (never reviews) that have a Gemini conversation can be resumed.
function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find((job) => job.jobClass === "task" && job.conversationId && !isActiveJobStatus(job.status) && job.status !== "cancelled") ?? null
  );
}

function resolveLatestTaskConversation(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }
  return findLatestResumableTaskJob(visibleJobs);
}

// `--allow` is repeatable, which parseArgs does not support, so collect it before parsing.
function extractAllowOptions(tokens) {
  const allow = [];
  const rest = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      rest.push(...tokens.slice(index));
      break;
    }
    if (token === "--allow") {
      const value = tokens[index + 1];
      if (value === undefined) {
        throw new Error("Missing value for --allow");
      }
      allow.push(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--allow=")) {
      allow.push(token.slice("--allow=".length));
      continue;
    }
    rest.push(token);
  }
  const cleaned = allow.map((value) => value.trim());
  if (cleaned.some((value) => !value)) {
    throw new Error("--allow needs a non-empty command prefix, for example --allow \"npm test\".");
  }
  return { allow: cleaned, rest };
}

function resolveTaskMode(options) {
  const chosen = ["write", "read-only", "auto"].filter((name) => options[name]);
  if (chosen.length > 1) {
    throw new Error(`Choose only one of --write, --read-only or --auto (got ${chosen.map((n) => `--${n}`).join(", ")}).`);
  }
  if (options["read-only"]) {
    return { mode: null, write: false };
  }
  if (options.auto) {
    return { mode: "auto", write: true };
  }
  // Default matches /gemini:rescue: let agy edit files.
  return { mode: "accept-edits", write: true };
}

async function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || (await readStdinIfPiped());
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt.trim() && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`The task prompt is ${prompt.length} characters, over the 100000-character limit. Shorten it.`);
  }
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  return {
    title: resumeLast ? "Gemini Resume" : "Gemini Task",
    summary: shorten(prompt || (resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task"))
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "rescue",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function appendAutoModeNote(rendered) {
  return `${rendered.trimEnd()}\n\nNote: --mode auto is not available for this account, so agy ran in its default permission mode.\n`;
}

async function executeTaskRun(request) {
  const { job, onProgress } = request;
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  const agy = inspectAgy();
  if (!agy.available || !agy.supported) {
    throw new Error(agyUnavailableMessage(agy));
  }

  let conversationId = null;
  if (request.resumeLast) {
    const latest = resolveLatestTaskConversation(workspaceRoot, { excludeJobId: job.id });
    if (!latest) {
      throw new Error("No previous Gemini task conversation was found for this Claude session.");
    }
    conversationId = latest.conversationId;
  }

  const prompt = request.prompt?.trim() ? request.prompt : DEFAULT_CONTINUE_PROMPT;
  const args = buildAgyArgs({
    model: request.model,
    effort: request.effort,
    mode: request.mode,
    conversationId,
    printTimeoutSeconds: request.timeoutSeconds,
    settingsJson: buildPermissionSettings({ extraAllow: request.allow ?? [] })
  });

  onProgress?.({
    message: conversationId ? `Resuming Gemini conversation ${conversationId}.` : "Starting Gemini task.",
    phase: "starting"
  });
  const result = await runAgy({
    bin: agy.path,
    args,
    prompt,
    cwd: workspaceRoot,
    timeoutMs: (request.timeoutSeconds + KILL_TIMER_MARGIN_SECONDS) * 1000,
    onEvent: (event) => forwardAgyEvent(event, { progress: onProgress, job }),
    onStderrLine: (line) => forwardAgyStderr(line, onProgress),
    onSpawn: (pid) => upsertJob(job.workspaceRoot, { id: job.id, agyPid: pid })
  });

  const { run, classification } = result;
  const response = run.response ?? "";
  const autoModeUnavailable = request.mode === "auto" && result.stderr.includes(AUTO_MODE_UNAVAILABLE_MARKER);
  let rendered = renderTaskResult(
    {
      response,
      classification,
      deniedActions: run.deniedActions,
      usage: run.usage,
      conversationId: run.conversationId
    },
    { jobId: job.id }
  );
  if (autoModeUnavailable) {
    rendered = appendAutoModeNote(rendered);
  }

  const state = classification.state;
  const denied = state === "completed-with-denials";
  const ok = state === "completed";
  const payload = {
    ok,
    state,
    reason: classification.reason,
    hint: classification.hint,
    jobId: job.id,
    mode: request.mode ?? "default",
    write: Boolean(request.write),
    autoModeUnavailable,
    rendered,
    rawOutput: response,
    conversationId: run.conversationId,
    resumedConversationId: conversationId,
    deniedActions: run.deniedActions,
    usage: run.usage,
    exitCode: result.exitCode
  };

  return {
    exitStatus: denied ? 2 : (ok ? 0 : 1),
    payload,
    rendered,
    summary: ok
      ? firstMeaningfulLine(response, `${job.title ?? "Gemini Task"} finished.`)
      : classification.reason ?? `${job.title ?? "Gemini Task"} failed.`,
    agy: {
      conversationId: run.conversationId,
      agyState: state,
      deniedActions: run.deniedActions,
      usage: run.usage
    }
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  appendLogLine(logFile, "Queued for background execution.");

  // Record the queued job before the worker starts so it always finds its request.
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: null, logFile, request };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  // The worker records its own pid once running; only fill it in while the job is still queued
  // so a queued job can be cancelled, and never rewrite the worker's job file.
  const current = listJobs(job.workspaceRoot).find((entry) => entry.id === job.id);
  if (current?.status === "queued" && child.pid) {
    upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    }
  };
}

async function handleTask(argv) {
  const { allow, rest } = extractAllowOptions(normalizeArgv(argv));
  const { options, positionals } = parseArgs(rest, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "timeout"],
    booleanOptions: ["json", "write", "read-only", "auto", "resume-last", "resume", "fresh", "background"],
    aliasMap: { C: "cwd", m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const { mode, write } = resolveTaskMode(options);
  const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_TASK_TIMEOUT_SECONDS);
  const prompt = await readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(prompt, resumeLast);

  const agy = inspectAgy();
  if (!agy.available || !agy.supported) {
    throw new Error(agyUnavailableMessage(agy));
  }

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = {
    cwd,
    model: options.model ?? null,
    effort: options.effort ?? null,
    prompt,
    mode,
    write,
    allow,
    resumeLast,
    timeoutSeconds
  };

  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, job, onProgress: progress }), {
    json: options.json
  });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  if (storedJob.status !== "queued") {
    // Cancelled (or otherwise settled) before the worker started.
    return;
  }
  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const job = { ...storedJob, workspaceRoot };
  const logFile = storedJob.logFile ?? createJobLogFile(workspaceRoot, job.id, job.title);
  const progress = createProgressReporter({
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, job.id)
  });
  const execution = await runTrackedJob({ ...job, logFile }, () => executeTaskRun({ ...request, job, onProgress: progress }), {
    logFile
  });
  patchJobWithAgyOutcome(job, execution.agy);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);
  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    ...(candidate ? { jobId: candidate.id, conversationId: candidate.conversationId } : {}),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          conversationId: candidate.conversationId,
          completedAt: candidate.completedAt ?? null,
          updatedAt: candidate.updatedAt ?? null
        }
      : null
  };
  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

// ---------------------------------------------------------------------------
// status, result, cancel

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputCommandResult(report, renderStatusReport(report), options.json);
}

// resolveResultJob only searches finished jobs when given an id; say so when the id is still active.
function resolveFinishedJob(cwd, reference) {
  try {
    return resolveResultJob(cwd, reference);
  } catch (error) {
    if (reference) {
      let active = null;
      try {
        active = buildSingleJobSnapshot(cwd, reference).job;
      } catch {
        // Unknown id: keep the original error.
      }
      if (active && isActiveJobStatus(active.status)) {
        throw new Error(`Job ${active.id} is still ${active.status}. Check /gemini:status and try again once it finishes.`);
      }
    }
    throw error;
  }
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveFinishedJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  // Task output is already fully rendered (denials, hint, conversation footer); show it as is.
  const rendered =
    job.jobClass === "task" && typeof storedJob?.rendered === "string" && storedJob.rendered
      ? storedJob.rendered
      : renderStoredJobResult(job, storedJob);
  const resultPayload = storedJob?.result;
  outputCommandResult(
    {
      job,
      storedJob,
      ...(resultPayload && typeof resultPayload === "object"
        ? { ok: resultPayload.ok, state: resultPayload.state, exitCode: resultPayload.state === "completed-with-denials" ? 2 : resultPayload.exitCode }
        : {})
    },
    rendered,
    options.json
  );
  if (resultPayload?.state === "completed-with-denials") {
    process.exitCode = 2;
  }
}

function killJobProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    if (terminateProcessTree(pid).delivered) {
      return true;
    }
  } catch {
    // Fall through to a direct signal.
  }
  // Not a process-group leader (e.g. a foreground companion): signal the process itself.
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const workerPid = job.pid ?? existing.pid ?? null;
  const agyPid = job.agyPid ?? existing.agyPid ?? null;

  // Stop the worker first so it cannot record a failure after its agy child dies.
  const workerKilled = killJobProcess(workerPid);
  const agyKilled = killJobProcess(agyPid);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const patch = {
    status: "cancelled",
    phase: "cancelled",
    agyState: "cancelled",
    pid: null,
    agyPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };
  const nextJob = { ...job, ...patch };
  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    rendered: renderTaskResult({ classification: { state: "cancelled" } }, { jobId: job.id }),
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, { id: job.id, ...patch });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    workerPid,
    agyPid,
    workerKilled,
    agyKilled
  };
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
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
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
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
