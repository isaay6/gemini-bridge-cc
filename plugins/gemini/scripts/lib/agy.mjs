// Spawns the Antigravity CLI (`agy`), streams its NDJSON events and enforces timeouts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import { createAgyEventAccumulator, classifyAgyRun } from "./agy-events.mjs";
import { terminateProcessTree } from "./process.mjs";

export const READ_ONLY_COMMANDS = ["git", "ls", "cat", "grep", "find", "rg", "head", "tail", "wc"];
export const TESTED_AGY_VERSION = "1.5.9";
export const MIN_AGY_VERSION = "1.5.0";
// `--mode plan` is deliberately excluded: it writes a plan and waits for approval (phase 0).
const ALLOWED_MODES = ["accept-edits", "auto"];

const IS_WINDOWS = process.platform === "win32";
const SYNC_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    if (!IS_WINDOWS) {
      fs.accessSync(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name, env) {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) {
    return null;
  }
  const exts = IS_WINDOWS
    ? ["", ...String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
    : [""];
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function resolveAgyBinary(env = process.env) {
  if (env.GEMINI_BRIDGE_AGY_BIN) {
    return env.GEMINI_BRIDGE_AGY_BIN;
  }
  const onPath = findOnPath("agy", env);
  if (onPath) {
    return onPath;
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const localBin = path.join(home, ".local", "bin", IS_WINDOWS ? "agy.exe" : "agy");
  if (isExecutableFile(localBin)) {
    return localBin;
  }
  if (env.LOCALAPPDATA) {
    const winBin = path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (isExecutableFile(winBin)) {
      return winBin;
    }
  }
  return null;
}

export function buildPermissionSettings({ extraAllow = [] } = {}) {
  const allow = [...READ_ONLY_COMMANDS, ...extraAllow].map((cmd) => `command(${cmd})`);
  return JSON.stringify({ permissions: { allow } });
}

export function buildAgyArgs({
  prompt,
  model,
  effort,
  mode,
  conversationId,
  jsonSchemaPath,
  printTimeoutSeconds,
  settingsJson
}) {
  if (mode != null && mode !== "" && !ALLOWED_MODES.includes(mode)) {
    throw new Error(`Unsupported agy mode "${mode}": use ${ALLOWED_MODES.join(" or ")}, or omit it.`);
  }
  const args = ["-p", prompt, "--output-format", "stream-json", "--print-timeout", `${printTimeoutSeconds}s`];
  const optional = [
    ["--model", model],
    ["--effort", effort],
    ["--mode", mode],
    ["--conversation", conversationId],
    ["--json-schema", jsonSchemaPath],
    ["--settings", settingsJson]
  ];
  for (const [flag, value] of optional) {
    if (value) {
      args.push(flag, String(value));
    }
  }
  return args;
}

function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

// Kept pure so Windows wrapper invocation can be verified off Windows.
export function buildAgyCommand(bin, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (/\.(mjs|js)$/i.test(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const commandLine = [bin, ...args].map(quoteForCmd).join(" ");
    return { command: options.comSpec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
  }
  return { command: bin, args };
}

function runSync(bin, args) {
  const { command, args: fullArgs } = buildAgyCommand(bin, args);
  return spawnSync(command, fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SYNC_TIMEOUT_MS,
    windowsHide: true
  });
}

function failureDetail(result) {
  if (result.error) {
    return result.error.code === "ENOENT" ? "agy not found" : result.error.message;
  }
  return (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
}

export function getAgyVersion(bin) {
  const result = runSync(bin, ["--version"]);
  if (result.error || result.status !== 0) {
    return { ok: false, version: null, detail: failureDetail(result) };
  }
  const match = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+/);
  if (!match) {
    return { ok: false, version: null, detail: `unrecognised version output: ${result.stdout.trim()}` };
  }
  return { ok: true, version: match[0], detail: null };
}

export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  return 0;
}

export function listAgyModels(bin) {
  const result = runSync(bin, ["models"]);
  if (result.error || result.status !== 0) {
    return [];
  }
  const models = [];
  for (const line of String(result.stdout).split(/\r?\n/)) {
    if (!line.includes("\t") || /^Fetching/i.test(line.trim())) {
      continue;
    }
    const [id, ...rest] = line.split("\t");
    if (id.trim()) {
      models.push({ id: id.trim(), label: rest.join("\t").trim() });
    }
  }
  return models;
}

function lineSplitter(onLine) {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    },
    end() {
      if (buffer) {
        const line = buffer.replace(/\r$/, "");
        buffer = "";
        onLine(line);
      }
    }
  };
}

export function runAgy({ bin, args, cwd, timeoutMs, onEvent, onStderrLine, onSpawn, signal, env }) {
  return new Promise((resolve) => {
    const accumulator = createAgyEventAccumulator();
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const realCwd = fs.realpathSync.native(cwd ?? process.cwd());
    const { command, args: fullArgs } = buildAgyCommand(bin, args);
    const child = spawn(command, fullArgs, {
      cwd: realCwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true
    });
    const pid = child.pid ?? null;

    const safeCall = (fn, value) => {
      if (typeof fn !== "function") {
        return;
      }
      try {
        fn(value);
      } catch {
        // Callback errors must not break the run.
      }
    };

    const stdoutLines = lineSplitter((line) => {
      const event = accumulator.push(line);
      if (event) {
        safeCall(onEvent, event);
      }
    });
    const stderrSplitter = lineSplitter((line) => safeCall(onStderrLine, line));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdoutLines.write(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      stderrSplitter.write(chunk);
    });

    const kill = () => {
      if (pid == null || killTimer) {
        return;
      }
      try {
        terminateProcessTree(pid);
      } catch {
        // Already gone or not killable; the close handler still runs.
      }
      killTimer = setTimeout(() => {
        try {
          if (IS_WINDOWS) {
            terminateProcessTree(pid);
          } else {
            process.kill(-pid, "SIGKILL");
          }
        } catch {
          // Ignore: process tree already exited.
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      cancelled = true;
      kill();
    };

    const finish = (exitCode, extraStderr = "") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      stdoutLines.end();
      stderrSplitter.end();
      if (extraStderr) {
        stderr += extraStderr;
        safeCall(onStderrLine, extraStderr.trim());
      }
      const run = accumulator.finish();
      const outcome = { run, exitCode, stderr, timedOut, cancelled, pid };
      resolve({ ...outcome, classification: classifyAgyRun(outcome) });
    };

    child.on("error", (error) => {
      const message = error.code === "ENOENT" ? `agy not found: ${bin}` : error.message;
      finish(null, `${message}\n`);
    });
    child.on("close", (code) => finish(code));

    if (pid != null) {
      safeCall(onSpawn, pid);
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          kill();
        }
      }, timeoutMs);
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
