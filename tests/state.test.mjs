import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState , upsertJob, listJobs, writeJobFile, readJobFile } from "../plugins/gemini/scripts/lib/state.mjs";

const inheritedPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;

test.after(() => {
  if (inheritedPluginDataDir == null) {
    delete process.env.CLAUDE_PLUGIN_DATA;
  } else {
    process.env.CLAUDE_PLUGIN_DATA = inheritedPluginDataDir;
  }
});

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("job-specific Gemini fields round-trip through state and job files", () => {
  const workspace = makeTempDir();
  const job = {
    id: "job-gemini-fields",
    status: "running",
    conversationId: "conversation-123",
    agyState: "awaiting-approval",
    deniedActions: [{ action: "write", reason: "policy" }],
    usage: { inputTokens: 12, outputTokens: 34 }
  };
  upsertJob(workspace, job);
  writeJobFile(workspace, job.id, job);
  const savedJob = listJobs(workspace).find((entry) => entry.id === job.id);
  assert.deepEqual(
    { conversationId: savedJob.conversationId, agyState: savedJob.agyState, deniedActions: savedJob.deniedActions, usage: savedJob.usage },
    { conversationId: job.conversationId, agyState: job.agyState, deniedActions: job.deniedActions, usage: job.usage }
  );
  assert.deepEqual(readJobFile(resolveJobFile(workspace, job.id)), job);
});

test("concurrent child upserts retain every job", async () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir();
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "state-upsert-worker.mjs");
  const children = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, workspace, `concurrent-${index}`], {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }
        });
        child.on("error", reject);
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
      })
    )
  );
  assert.equal(children.length, 20);
  const [stateDirectory] = fs.readdirSync(path.join(dataDir, "state"));
  const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, "state", stateDirectory, "state.json"), "utf8")).jobs;
  assert.deepEqual(
    jobs.map((job) => job.id).sort(),
    Array.from({ length: 20 }, (_, index) => `concurrent-${index}`).sort()
  );
});

test("invalid state is backed up before a fresh state is returned", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{ not json", "utf8");
  assert.deepEqual(listJobs(workspace), []);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.readdirSync(path.dirname(stateFile)).some((name) => /^state\.json\.corrupt-\d+$/.test(name)), true);
});
