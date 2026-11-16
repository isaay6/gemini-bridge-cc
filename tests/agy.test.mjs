import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  READ_ONLY_COMMANDS,
  TESTED_AGY_VERSION,
  MIN_AGY_VERSION,
  resolveAgyBinary,
  buildPermissionSettings,
  buildAgyArgs,
  buildAgyCommand,
  getAgyVersion,
  listAgyModels,
  runAgy
} from "../plugins/gemini/scripts/lib/agy.mjs";
import { REPO_ROOT, makeTempDir } from "./helpers.mjs";

const FAKE_AGY = path.join(REPO_ROOT, "tests", "fake-agy.mjs");

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitForDeath(pid, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test("constants", () => {
  assert.equal(TESTED_AGY_VERSION, "1.5.9");
  assert.equal(MIN_AGY_VERSION, "1.5.0");
  assert.deepEqual(READ_ONLY_COMMANDS, ["git", "ls", "cat", "grep", "find", "rg", "head", "tail", "wc"]);
});

test("buildAgyArgs minimal", () => {
  assert.deepEqual(buildAgyArgs({ prompt: "hi", printTimeoutSeconds: 900 }), [
    "-p",
    "hi",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "900s"
  ]);
});

test("buildAgyArgs full", () => {
  assert.deepEqual(
    buildAgyArgs({
      prompt: "fix it",
      model: "gemini-3.8-flash-high",
      effort: "high",
      mode: "accept-edits",
      conversationId: "abc-123",
      jsonSchemaPath: "/tmp/schema.json",
      printTimeoutSeconds: 1800,
      settingsJson: '{"permissions":{"allow":["command(git)"]}}'
    }),
    [
      "-p",
      "fix it",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "1800s",
      "--model",
      "gemini-3.8-flash-high",
      "--effort",
      "high",
      "--mode",
      "accept-edits",
      "--conversation",
      "abc-123",
      "--json-schema",
      "/tmp/schema.json",
      "--settings",
      '{"permissions":{"allow":["command(git)"]}}'
    ]
  );
});

test("buildAgyArgs rejects unsupported modes and never emits --mode plan", () => {
  for (const mode of ["plan", "yolo"]) {
    assert.throws(() => buildAgyArgs({ prompt: "x", printTimeoutSeconds: 60, mode }), /Unsupported agy mode/);
  }
  for (const mode of ["auto", "accept-edits", undefined, null]) {
    const args = buildAgyArgs({ prompt: "x", printTimeoutSeconds: 60, mode });
    assert.ok(!args.includes("plan"));
    assert.equal(args.includes("--mode"), Boolean(mode));
  }
});

test("buildAgyCommand invokes Windows command wrappers through cmd.exe", () => {
  assert.deepEqual(buildAgyCommand("C:\\Program Files\\agy.cmd", ["-p", "say \"hello\""], { platform: "win32", comSpec: "C:\\Windows\\cmd.exe" }), {
    command: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\Program Files\\agy.cmd" -p "say \\"hello\\""']
  });
  assert.deepEqual(buildAgyCommand("agy.exe", ["--version"], { platform: "win32" }), { command: "agy.exe", args: ["--version"] });
});

test("buildPermissionSettings includes read-only commands and extras", () => {
  const parsed = JSON.parse(buildPermissionSettings({ extraAllow: ["npm test"] }));
  const allow = parsed.permissions.allow;
  for (const cmd of ["git", "ls", "cat", "grep", "find", "rg", "head", "tail", "wc"]) {
    assert.ok(allow.includes(`command(${cmd})`), cmd);
  }
  assert.ok(allow.includes("command(npm test)"));
  assert.equal(allow.length, 10);
  assert.deepEqual(JSON.parse(buildPermissionSettings({})).permissions.allow.length, 9);
});

test("resolveAgyBinary honours GEMINI_BRIDGE_AGY_BIN", () => {
  assert.equal(resolveAgyBinary({ GEMINI_BRIDGE_AGY_BIN: FAKE_AGY, PATH: "" }), FAKE_AGY);
});

test("resolveAgyBinary scans PATH without a shell", () => {
  const dir = makeTempDir();
  const bin = path.join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  const found = resolveAgyBinary({ PATH: dir, PATHEXT: ".EXE", HOME: makeTempDir(), USERPROFILE: makeTempDir() });
  assert.equal(found, bin);
});

test("resolveAgyBinary returns null when nothing is found", () => {
  const empty = makeTempDir();
  assert.equal(resolveAgyBinary({ PATH: empty, HOME: empty, USERPROFILE: empty, LOCALAPPDATA: empty }), null);
});

test("getAgyVersion reads the fake version", () => {
  assert.deepEqual(getAgyVersion(FAKE_AGY), { ok: true, version: "1.5.9", detail: null });
});

test("getAgyVersion reports a missing binary", () => {
  const result = getAgyVersion(path.join(os.tmpdir(), "definitely-missing-agy-bin"));
  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.ok(result.detail);
});

test("listAgyModels parses tab-separated lines", () => {
  assert.deepEqual(listAgyModels(FAKE_AGY), [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }
  ]);
});

test("runAgy replays success fixture", async () => {
  const events = [];
  const stderrLines = [];
  const result = await withEnv({ FAKE_AGY_FIXTURE: "success", FAKE_AGY_HANG: undefined }, () =>
    runAgy({
      bin: FAKE_AGY,
      args: buildAgyArgs({ prompt: "hi", printTimeoutSeconds: 60 }),
      cwd: makeTempDir(),
      timeoutMs: 20000,
      onEvent: (e) => events.push(e),
      onStderrLine: (l) => stderrLines.push(l)
    })
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.run.conversationId, "29a22bce-0352-4fc2-b4d3-f8d4770c7928");
  assert.equal(result.run.response, "Hi! How can I help you today?\n");
  assert.equal(result.classification.state, "completed");
  assert.equal(events[0].event, "init");
  assert.equal(events.at(-1).event, "result");
});

test("runAgy forwards stderr lines and failure classification", async () => {
  const stderrLines = [];
  const result = await withEnv({ FAKE_AGY_FIXTURE: "invalid-model" }, () =>
    runAgy({
      bin: FAKE_AGY,
      args: ["-p", "x"],
      cwd: makeTempDir(),
      timeoutMs: 20000,
      onStderrLine: (l) => stderrLines.push(l)
    })
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.classification.state, "failed");
  assert.equal(stderrLines.join("\n").trim(), result.stderr.trim());
});

test("runAgy spawns in realpath cwd", async () => {
  const real = fs.realpathSync.native(makeTempDir());
  const link = path.join(makeTempDir(), "link");
  fs.symlinkSync(real, link, "dir");
  const argsFile = path.join(makeTempDir(), "args.json");
  await withEnv({ FAKE_AGY_FIXTURE: "success", FAKE_AGY_ARGS_FILE: argsFile }, () =>
    runAgy({ bin: FAKE_AGY, args: ["-p", "hi"], cwd: link, timeoutMs: 20000 })
  );
  const recorded = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(recorded.cwd, real);
  assert.deepEqual(recorded.argv, ["-p", "hi"]);
});

test("runAgy kills hung agy after timeout", async () => {
  let pid = null;
  const started = Date.now();
  const result = await withEnv({ FAKE_AGY_HANG: "1" }, () =>
    runAgy({
      bin: FAKE_AGY,
      args: ["-p", "hi"],
      cwd: makeTempDir(),
      timeoutMs: 1500,
      onSpawn: (p) => {
        pid = p;
      }
    })
  );
  assert.ok(Date.now() - started < 10000);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.classification.state, "timed-out");
  assert.equal(result.run.conversationId, "hang-0000");
  assert.ok(Number.isInteger(result.pid));
  assert.equal(await waitForDeath(result.pid), true);
  assert.equal(pid, result.pid);
});

test("runAgy abort signal → cancelled", async () => {
  const controller = new AbortController();
  const result = await withEnv({ FAKE_AGY_HANG: "1" }, () =>
    runAgy({
      bin: FAKE_AGY,
      args: ["-p", "hi"],
      cwd: makeTempDir(),
      timeoutMs: 20000,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.event === "init") controller.abort();
      }
    })
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.classification.state, "cancelled");
  assert.equal(await waitForDeath(result.pid), true);
});

test("runAgy with an already-aborted signal does not hang", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await withEnv({ FAKE_AGY_HANG: "1" }, () =>
    runAgy({ bin: FAKE_AGY, args: ["-p", "hi"], cwd: makeTempDir(), timeoutMs: 20000, signal: controller.signal })
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.classification.state, "cancelled");
});
