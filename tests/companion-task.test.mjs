import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { makeTempDir, makeTempRepo, run, PLUGIN_ROOT, REPO_ROOT } from "./helpers.mjs";

const COMPANION = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
const FAKE_AGY = path.join(REPO_ROOT, "tests", "fake-agy.mjs");
const SESSION = "session-task-tests";
const RESCUE_CONVERSATION = "71595a0a-9d65-49e4-8880-f2b134e1e349";

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
    GEMINI_BRIDGE_SESSION_ID: SESSION,
    FAKE_AGY_ARGS_FILE: argsFile,
    ...extra
  });
  return { env, argsFile, dataDir };
}

function companion(args, { cwd, env }) {
  return run(process.execPath, [COMPANION, ...args], { cwd, env });
}

function companionJson(args, options) {
  const result = companion([...args, "--json"], options);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function recordedArgv(argsFile) {
  return JSON.parse(fs.readFileSync(argsFile, "utf8")).argv;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function readJobs(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  const [dir] = fs.readdirSync(stateRoot);
  const file = path.join(stateRoot, dir, "state.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).jobs : [];
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

function killQuietly(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// An agy stand-in that blocks real runs (-p) until a release file exists, then replays fake-agy.
function makeGatedAgy(dir) {
  const releaseFile = path.join(dir, "release");
  const gated = path.join(dir, "gated-agy.mjs");
  fs.writeFileSync(
    gated,
    [
      'import fs from "node:fs";',
      `const release = ${JSON.stringify(releaseFile)};`,
      'if (process.argv.includes("-p")) {',
      "  while (!fs.existsSync(release)) {",
      "    await new Promise((resolve) => setTimeout(resolve, 50));",
      "  }",
      "}",
      `await import(${JSON.stringify(pathToFileURL(FAKE_AGY).href)});`
    ].join("\n")
  );
  return { gated, releaseFile };
}

test("task --json runs agy in accept-edits mode by default and records a completed job", () => {
  const repo = makeTempRepo({ "calc.py": "def add(a,b): return a-b\n" });
  const { env, argsFile, dataDir } = setupEnv({ FAKE_AGY_FIXTURE: "rescue-edit-ok" });
  const payload = companionJson(["task", "fix", "the", "add", "bug"], { cwd: repo, env });
  assert.equal(payload.state, "completed");
  assert.match(payload.jobId, /^task-/);
  assert.equal(payload.conversationId, RESCUE_CONVERSATION);
  assert.match(payload.rendered, /has been fixed/);
  assert.match(payload.rawOutput, /has been fixed/);

  const argv = recordedArgv(argsFile);
  assert.equal(valueAfter(argv, "--mode"), "accept-edits");
  assert.equal(valueAfter(argv, "-p"), "fix the add bug");
  assert.equal(valueAfter(argv, "--print-timeout"), "1800s");
  assert.ok(!argv.includes("--dangerously-skip-permissions"));

  const job = readJobs(dataDir).find((j) => j.id === payload.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.jobClass, "task");
  assert.equal(job.write, true);
  assert.equal(job.sessionId, SESSION);
  assert.equal(job.conversationId, RESCUE_CONVERSATION);
  assert.equal(job.agyState, "completed");
});

test("task --read-only passes no --mode", () => {
  const repo = makeTempRepo();
  const { env, argsFile, dataDir } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  const payload = companionJson(["task", "--read-only", "explain", "this"], { cwd: repo, env });
  assert.equal(payload.state, "completed");
  assert.ok(!recordedArgv(argsFile).includes("--mode"));
  assert.equal(readJobs(dataDir)[0].write, false);
});

test("task --auto passes --mode auto and reports when auto mode is unavailable", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  const payload = companionJson(["task", "--auto", "do", "it"], { cwd: repo, env });
  assert.equal(valueAfter(recordedArgv(argsFile), "--mode"), "auto");
  assert.equal(payload.autoModeUnavailable, false);
});

test("task rejects conflicting mode flags", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  const result = companion(["task", "--write", "--read-only", "x"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--read-only/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("task --allow adds command rules to the permission settings", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "rescue-edit-ok" });
  companionJson(["task", "--allow", "npm test", "--allow=python3", "run", "tests"], { cwd: repo, env });
  const argv = recordedArgv(argsFile);
  const settings = JSON.parse(valueAfter(argv, "--settings"));
  assert.ok(settings.permissions.allow.includes("command(npm test)"));
  assert.ok(settings.permissions.allow.includes("command(python3)"));
  assert.ok(settings.permissions.allow.includes("command(git)"));
  assert.equal(valueAfter(argv, "-p"), "run tests");
});

test("task passes --model, --effort and --timeout through", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  companionJson(["task", "--model", "gemini-3.8-flash-high", "--effort", "high", "--timeout", "60", "hi"], {
    cwd: repo,
    env
  });
  const argv = recordedArgv(argsFile);
  assert.equal(valueAfter(argv, "--model"), "gemini-3.8-flash-high");
  assert.equal(valueAfter(argv, "--effort"), "high");
  assert.equal(valueAfter(argv, "--print-timeout"), "60s");
});

test("task without a prompt or --resume-last fails", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "success" });
  const result = companion(["task"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt/i);
  assert.equal(fs.existsSync(argsFile), false);
});

test("task with a denied command is failed and never relays skip-permissions advice", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv({ FAKE_AGY_FIXTURE: "command-denied" });
  const jsonRun = companion(["task", "--json", "run", "the", "tests"], { cwd: repo, env });
  assert.equal(jsonRun.status, 1);
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.state, "failed");
  assert.match(payload.reason, /permission denied/);
  assert.match(payload.rendered, /Denied actions/);
  assert.match(payload.rendered, /--allow/);

  const textRun = companion(["task", "run", "the", "tests"], { cwd: repo, env });
  assert.equal(textRun.status, 1);
  assert.match(textRun.stdout, /--allow/);
  for (const output of [jsonRun.stdout, jsonRun.stderr, textRun.stdout, textRun.stderr]) {
    assert.doesNotMatch(output, /dangerously/);
  }
  const result = companion(["result"], { cwd: repo, env });
  assert.doesNotMatch(result.stdout, /dangerously/);
});

test("task-resume-candidate is unavailable on a fresh state", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv();
  const payload = companionJson(["task-resume-candidate"], { cwd: repo, env });
  assert.equal(payload.available, false);
});

test("task --resume-last continues the latest finished task conversation of this session", () => {
  const repo = makeTempRepo();
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "rescue-edit-ok" });
  const first = companionJson(["task", "fix", "it"], { cwd: repo, env });

  const candidate = companionJson(["task-resume-candidate"], { cwd: repo, env });
  assert.equal(candidate.available, true);
  assert.equal(candidate.jobId, first.jobId);
  assert.equal(candidate.conversationId, RESCUE_CONVERSATION);

  const otherSession = companionJson(["task-resume-candidate"], {
    cwd: repo,
    env: { ...env, GEMINI_BRIDGE_SESSION_ID: "another-session" }
  });
  assert.equal(otherSession.available, false);

  const resumed = companionJson(["task", "--resume-last", "now", "add", "tests"], {
    cwd: repo,
    env: { ...env, FAKE_AGY_FIXTURE: "resume" }
  });
  assert.equal(resumed.state, "completed");
  const argv = recordedArgv(argsFile);
  assert.equal(valueAfter(argv, "--conversation"), RESCUE_CONVERSATION);
  assert.equal(valueAfter(argv, "-p"), "now add tests");
});

test("task --resume-last ignores review jobs and fails when no task exists", () => {
  const repo = makeTempRepo({ "calc.py": "def add(a,b): return a+b\n" });
  fs.writeFileSync(path.join(repo, "calc.py"), "def add(a,b): return a-b\n");
  const { env, argsFile } = setupEnv({ FAKE_AGY_FIXTURE: "review-structured" });
  const review = companion(["review", "--wait", "--json"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  fs.rmSync(argsFile);

  assert.equal(companionJson(["task-resume-candidate"], { cwd: repo, env }).available, false);
  const result = companion(["task", "--resume-last"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous Gemini task/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("background task shows running in status, then completed, and result renders it", async () => {
  const repo = makeTempRepo();
  const tempDir = makeTempDir("gemini-bridge-gate-");
  const { gated, releaseFile } = makeGatedAgy(tempDir);
  const { env, dataDir } = setupEnv({ FAKE_AGY_FIXTURE: "rescue-edit-ok", GEMINI_BRIDGE_AGY_BIN: gated });

  const launch = companionJson(["task", "--background", "fix", "it"], { cwd: repo, env });
  assert.equal(launch.status, "queued");
  const jobId = launch.jobId;
  try {
    const textLaunch = launch;
    assert.match(textLaunch.jobId, /^task-/);

    await waitFor(() => readJobs(dataDir).find((j) => j.id === jobId && j.status === "running" && j.agyPid), {
      label: "running job"
    });
    const running = companionJson(["status"], { cwd: repo, env });
    assert.equal(running.running.length, 1);
    assert.equal(running.running[0].id, jobId);
    assert.equal(running.running[0].status, "running");
    const runningText = companion(["status"], { cwd: repo, env }).stdout;
    assert.match(runningText, /Active jobs/);
    assert.match(runningText, new RegExp(jobId));

    const notYet = companion(["result", jobId], { cwd: repo, env });
    assert.equal(notYet.status, 1);
    assert.match(notYet.stderr, /still running/);

    fs.writeFileSync(releaseFile, "");
    const waited = companionJson(["status", jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "100"], {
      cwd: repo,
      env
    });
    assert.equal(waited.job.status, "completed");
    assert.equal(waited.job.conversationId, RESCUE_CONVERSATION);

    const finished = companionJson(["status"], { cwd: repo, env });
    assert.equal(finished.running.length, 0);
    assert.equal(finished.latestFinished.id, jobId);

    const result = companion(["result", jobId], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /has been fixed/);
    assert.match(result.stdout, new RegExp(RESCUE_CONVERSATION));
    assert.equal(result.stdout.split(`Gemini conversation ID: ${RESCUE_CONVERSATION}`).length, 2);

    const resultJson = companionJson(["result", jobId], { cwd: repo, env });
    assert.equal(resultJson.job.id, jobId);
    assert.equal(resultJson.storedJob.status, "completed");
  } finally {
    fs.writeFileSync(releaseFile, "");
    const job = readJobs(dataDir).find((j) => j.id === jobId);
    for (const pid of [job?.pid, job?.agyPid]) {
      if (Number.isInteger(pid)) {
        killQuietly(pid);
      }
    }
  }
});

test("cancel kills worker and agy child", async () => {
  const repo = makeTempRepo();
  const { env, dataDir } = setupEnv({ FAKE_AGY_HANG: "1" });
  const launch = companionJson(["task", "--background", "hang"], { cwd: repo, env });
  const jobId = launch.jobId;
  let workerPid;
  let agyPid;
  try {
    const job = await waitFor(
      () => readJobs(dataDir).find((j) => j.id === jobId && j.status === "running" && j.pid && j.agyPid),
      { label: "running job with pids" }
    );
    workerPid = job.pid;
    agyPid = job.agyPid;
    assert.ok(isAlive(workerPid));
    assert.ok(isAlive(agyPid));

    const cancel = companionJson(["cancel", jobId], { cwd: repo, env });
    assert.equal(cancel.jobId, jobId);
    assert.equal(cancel.status, "cancelled");

    await waitFor(() => !isAlive(workerPid) && !isAlive(agyPid), { timeoutMs: 10_000, label: "pids to exit" });
    await sleep(300);
    const stored = readJobs(dataDir).find((j) => j.id === jobId);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.agyState, "cancelled");
    assert.equal(stored.pid, null);
    assert.equal(stored.agyPid, null);

    const status = companionJson(["status", jobId], { cwd: repo, env });
    assert.equal(status.job.status, "cancelled");
    const result = companion(["result", jobId], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /[Cc]ancelled/);
  } finally {
    for (const pid of [workerPid, agyPid]) {
      if (Number.isInteger(pid)) {
        killQuietly(pid);
      }
    }
  }
});

test("cancel without active jobs fails", () => {
  const repo = makeTempRepo();
  const { env } = setupEnv();
  const result = companion(["cancel"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No active Gemini jobs/);
});
