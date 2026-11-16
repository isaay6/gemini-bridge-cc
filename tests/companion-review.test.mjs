import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir, makeTempRepo, run, PLUGIN_ROOT, REPO_ROOT } from "./helpers.mjs";

const COMPANION = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
const FAKE_AGY = path.join(REPO_ROOT, "tests", "fake-agy.mjs");

function setupEnv(extra = {}) {
  const dataDir = makeTempDir("gemini-bridge-data-");
  const argsFile = path.join(dataDir, "agy-args.json");
  const env = { ...process.env };
  for (const key of ["FAKE_AGY_FIXTURE", "FAKE_AGY_HANG", "FAKE_AGY_VERSION", "GEMINI_BRIDGE_SESSION_ID"]) {
    delete env[key];
  }
  Object.assign(env, {
    CLAUDE_PLUGIN_DATA: dataDir,
    GEMINI_BRIDGE_AGY_BIN: FAKE_AGY,
    FAKE_AGY_ARGS_FILE: argsFile,
    ...extra
  });
  return { env, argsFile, dataDir };
}

function companion(args, { cwd, env, input }) {
  return run(process.execPath, [COMPANION, ...args], { cwd, env, input });
}

function dirtyRepo() {
  const repo = makeTempRepo({ "calc.py": "def add(a,b): return a+b\n" });
  fs.writeFileSync(path.join(repo, "calc.py"), "def add(a,b): return a-b\n");
  return repo;
}

function recordedArgv(argsFile) {
  return JSON.parse(fs.readFileSync(argsFile, "utf8")).argv;
}

function promptOf(record) {
  return record.prompt;
}

test("setup --json reports agy version and models", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv();
  const result = companion(["setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.agy.available, true);
  assert.equal(report.agy.version, "1.5.9");
  assert.equal(report.agy.tested, true);
  assert.equal(report.models.length, 2);
  assert.equal(report.auth.ok, true);
  assert.equal(report.reviewGate.enabled, false);
  assert.equal(report.reviewGate.model, "gemini-3.8-flash-low");
  assert.equal(report.ready, true);
  assert.equal(report.ok, true);
});

test("review completed with denied actions returns partial output with exit code 2", () => {
  const repo = dirtyRepo();
  const { env } = setupEnv({ FAKE_AGY_FIXTURE: "review-partial-denial" });
  const result = companion(["review", "--json"], { cwd: repo, env });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.state, "completed-with-denials");
  assert.match(payload.rendered, /Partial review/);
  assert.match(payload.rendered, /Denied actions/);
});

test("review handles an unborn HEAD without instructing agy to diff HEAD", () => {
  const repo = makeTempDir();
  const init = run("git", ["init", "-b", "main"], { cwd: repo });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(repo, "new.js"), "export default 1;\n");
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["review", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const prompt = promptOf(JSON.parse(fs.readFileSync(argsFile, "utf8")));
  assert.doesNotMatch(prompt, /git diff HEAD/);
  assert.match(prompt, /git status --porcelain/);
  assert.match(prompt, /git diff --cached/);
});

test("setup auth probe uses a read-only model-agnostic call", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv();
  const result = companion(["setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const argv = recordedArgv(argsFile);
  assert.equal(promptOf(JSON.parse(fs.readFileSync(argsFile, "utf8"))), "Reply with OK");
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], "60s");
  assert.ok(!argv.includes("--model"));
  assert.ok(!argv.includes("--mode"));
});

test("setup reports failed auth with the sign-in hint", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv({ FAKE_AGY_FIXTURE: "invalid-model" });
  const report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env }).stdout);
  assert.equal(report.auth.ok, false);
  assert.match(report.auth.detail, /Run !agy to sign in/);
  assert.equal(report.ready, false);
});

test("setup with missing bin gives available false and the install command", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv({ GEMINI_BRIDGE_AGY_BIN: path.join(makeTempDir(), "no-agy") });
  const result = companion(["setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.agy.available, false);
  const expected =
    process.platform === "win32"
      ? "irm https://antigravity.google/cli/install.ps1 | iex"
      : "curl -fsSL https://antigravity.google/cli/install.sh | bash";
  assert.equal(report.agy.installCommand, expected);
  assert.equal(report.ready, false);
  const text = companion(["setup"], { cwd: repo, env }).stdout;
  assert.match(text, /Install: /);
});

test("setup flags old agy versions as unsupported", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv({ FAKE_AGY_VERSION: "1.4.0" });
  const report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env }).stdout);
  assert.equal(report.agy.supported, false);
  assert.equal(report.ready, false);
});

test("setup toggles the review gate", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv();
  let report = JSON.parse(companion(["setup", "--json", "--enable-review-gate"], { cwd: repo, env }).stdout);
  assert.equal(report.reviewGate.enabled, true);
  report = JSON.parse(companion(["setup", "--json"], { cwd: repo, env }).stdout);
  assert.equal(report.reviewGate.enabled, true);
  report = JSON.parse(companion(["setup", "--json", "--disable-review-gate"], { cwd: repo, env }).stdout);
  assert.equal(report.reviewGate.enabled, false);
});

test("review --wait --json returns structured output and records a job", () => {
  const repo = dirtyRepo();
  const { env, argsFile, dataDir } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["review", "--wait", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.state, "completed");
  assert.equal(payload.structuredOutput.verdict, "needs-attention");
  assert.match(payload.rendered, /Incorrect addition implementation/);
  assert.match(payload.jobId, /^review-/);

  const argv = recordedArgv(argsFile);
  assert.ok(argv.includes("--json-schema"));
  const schemaPath = argv[argv.indexOf("--json-schema") + 1];
  assert.ok(fs.existsSync(schemaPath));
  assert.ok(!argv.includes("--mode"));
  assert.ok(argv.includes("--settings"));
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], "900s");
  const prompt = promptOf(JSON.parse(fs.readFileSync(argsFile, "utf8")));
  assert.match(prompt, /calc\.py/);
  assert.match(prompt, /git diff HEAD/);
  assert.match(prompt, /1 file changed/);
  assert.match(prompt, /[Dd]o not modify/);
  assert.match(prompt, /"next_steps"/);

  const stateDirs = fs.readdirSync(path.join(dataDir, "state"));
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state", stateDirs[0], "state.json"), "utf8"));
  const job = state.jobs.find((j) => j.id === payload.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.conversationId, "93cf1fa2-6c74-4b61-845d-127ae2404c32");
  assert.equal(job.agyState, "completed");
  assert.ok(job.usage);
  assert.deepEqual(job.deniedActions, []);
});

test("review --timeout overrides the print timeout", () => {
  const repo = dirtyRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["review", "--json", "--timeout", "120", "--model", "gemini-3.8-flash-high"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = recordedArgv(argsFile);
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], "120s");
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.8-flash-high");
});

test("review on clean tree says nothing to review", () => {
  const repo = makeTempRepo({ "calc.py": "x = 1\n" });
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["review", "--wait"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /[Nn]othing to review/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("review without agy prints setup hint", () => {
  const repo = dirtyRepo();
  const { env, argsFile } = setupEnv({ GEMINI_BRIDGE_AGY_BIN: path.join(makeTempDir(), "no-agy") });
  const result = companion(["review", "--wait"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\/gemini:setup/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("review with denied write is failed with permission denied", () => {
  const repo = dirtyRepo();
  const { env } = setupEnv({ FAKE_AGY_FIXTURE: "review-write-denied" });
  const result = companion(["review", "--wait", "--json"], { cwd: repo, env });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.state, "failed");
  assert.match(payload.reason, /permission denied/);
  assert.match(payload.rendered, /Denied actions/);
});

test("review output that does not match the schema fails and shows raw text", () => {
  const repo = dirtyRepo();
  const { env } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  const result = companion(["review", "--json"], { cwd: repo, env });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, "failed");
  assert.match(payload.reason, /review output did not match schema/);
  assert.match(payload.rawOutput, /How can I help/);
  assert.match(payload.rendered, /How can I help/);
});

test("adversarial-review passes the focus text into the prompt", () => {
  const repo = dirtyRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["adversarial-review", "--wait", "--json", "look", "at", "rounding"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.match(payload.jobId, /^review-/);
  const prompt = promptOf(JSON.parse(fs.readFileSync(argsFile, "utf8")));
  assert.match(prompt, /look at rounding/);
  assert.match(prompt, /adversarial/i);
});

test("a prompt over 100000 characters is rejected before spawning", () => {
  const repo = dirtyRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const result = companion(["task", "--json"], { cwd: repo, env, input: "x".repeat(100_001) });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /100[ ,]?000/);
  assert.equal(fs.existsSync(argsFile), false);
});
