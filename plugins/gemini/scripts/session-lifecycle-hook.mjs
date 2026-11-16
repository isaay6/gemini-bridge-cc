#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!fs.existsSync(resolveStateFile(workspaceRoot))) {
    return;
  }
  const state = loadState(workspaceRoot);
  const sessionJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  for (const job of sessionJobs) {
    if (job.status === "queued" || job.status === "running") {
      try {
        terminateProcessTree(job.agyPid ?? job.pid ?? Number.NaN);
      } catch {
        // Best-effort cleanup during session shutdown.
      }
    }
  }
  if (sessionJobs.length) {
    saveState(workspaceRoot, { ...state, jobs: state.jobs.filter((job) => job.sessionId !== sessionId) });
  }
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";
  if (eventName === "SessionStart") {
    appendEnvVar(SESSION_ID_ENV, input.session_id);
    return;
  }
  if (eventName === "SessionEnd") {
    cleanupSessionJobs(input.cwd || process.cwd(), input.session_id || process.env[SESSION_ID_ENV]);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
