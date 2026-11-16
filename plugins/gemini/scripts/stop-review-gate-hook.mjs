#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getConfig } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const TASK_TIMEOUT_SECONDS = 300;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function note(message) {
  process.stderr.write(`[gemini review gate] ${message}\n`);
}

function buildPrompt(input) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  return interpolateTemplate(loadPromptTemplate(ROOT_DIR, "stop-review-gate"), {
    CLAUDE_RESPONSE_BLOCK: lastAssistantMessage ? `Previous Claude response:\n${lastAssistantMessage}` : ""
  });
}

function runGate(cwd, config, input) {
  const script = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(
    process.execPath,
    [
      script,
      "task",
      "--read-only",
      "--json",
      "--timeout",
      String(TASK_TIMEOUT_SECONDS),
      "--model",
      config.gateModel ?? "gemini-3.8-flash-low",
      buildPrompt(input)
    ],
    { cwd, env: childEnv, encoding: "utf8", timeout: (TASK_TIMEOUT_SECONDS + 30) * 1000 }
  );

  if (result.error?.code === "ETIMEDOUT") {
    note("review task timed out; allowing stop.");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      note(`review task failed; allowing stop.${detail ? ` ${detail}` : ""}`);
      return;
    }
    note("review task returned invalid JSON; allowing stop.");
    return;
  }
  if (!payload?.ok) {
    note(`review task did not complete successfully; allowing stop.${payload?.state ? ` State: ${payload.state}.` : ""}`);
    return;
  }
  if (result.status !== 0 || payload?.state !== "completed") {
    note(`review task failed; allowing stop.${payload?.state ? ` State: ${payload.state}.` : ""}`);
    return;
  }
  const firstLine = String(payload.rawOutput ?? "").split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("BLOCK:")) {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: firstLine.slice(6).trim() || firstLine })}\n`);
  }
}

try {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  if (config.stopReviewGate) {
    runGate(workspaceRoot, config, input);
  }
} catch (error) {
  note(`could not run review gate; allowing stop. ${error instanceof Error ? error.message : String(error)}`);
}
