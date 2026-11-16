import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { makeTempDir, makeTempRepo, PLUGIN_ROOT } from "./helpers.mjs";
import { setConfig } from "../plugins/gemini/scripts/lib/state.mjs";

const hookPath = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const fakeAgyPath = path.join(process.cwd(), "tests", "fake-agy.mjs");

function runHook(cwd, env = {}) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd, last_assistant_message: "Changed a file." }),
    encoding: "utf8"
  });
}

test("disabled stop gate emits nothing", () => {
  const workspace = makeTempRepo({ "a.txt": "a\n" });
  const result = runHook(workspace, { CLAUDE_PLUGIN_DATA: makeTempDir("gemini-gate-off-") });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("gate blocks only a BLOCK first line", () => {
  const workspace = makeTempRepo({ "a.txt": "a\n" });
  const stateRoot = makeTempDir("gemini-gate-block-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  try {
    setConfig(workspace, "stopReviewGate", true);
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const result = runHook(workspace, {
    CLAUDE_PLUGIN_DATA: stateRoot,
    GEMINI_BRIDGE_AGY_BIN: fakeAgyPath,
    FAKE_AGY_FIXTURE: "gate-block"
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "x" });
});

test("failed or timed-out gate task allows stop and leaves a note", () => {
  const workspace = makeTempRepo({ "a.txt": "a\n" });
  const stateRoot = makeTempDir("gemini-gate-timeout-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  try {
    setConfig(workspace, "stopReviewGate", true);
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
  const result = runHook(workspace, {
    CLAUDE_PLUGIN_DATA: stateRoot,
    GEMINI_BRIDGE_AGY_BIN: fakeAgyPath,
    FAKE_AGY_FIXTURE: "print-timeout"
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /allowing stop/i);
});
