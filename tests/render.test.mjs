import test from "node:test";
import assert from "node:assert/strict";

import { parseAgyEvents } from "../plugins/gemini/scripts/lib/agy-events.mjs";
import {
  renderSetupReport,
  renderReviewResult,
  renderTaskResult,
  renderStatusReport,
  renderJobStatusReport,
  renderStoredJobResult,
  renderCancelReport
} from "../plugins/gemini/scripts/lib/render.mjs";
import { fixture } from "./helpers.mjs";

const meta = { reviewLabel: "Review", targetLabel: "working tree diff" };

test("renderReviewResult renders the structured review fixture", () => {
  const { structuredOutput } = parseAgyEvents(fixture("review-structured").ndjson);
  const out = renderReviewResult(structuredOutput, {
    ...meta,
    usage: { input_tokens: 10, output_tokens: 5 }
  });
  assert.match(out, /^# Gemini Review/);
  assert.match(out, /critical/);
  assert.match(out, /calc\.py:1/);
  assert.match(out, /Verdict: needs-attention/);
  assert.match(out, /Tokens: 10 in \/ 5 out/);
  assert.doesNotMatch(out, /Codex/);
});

test("renderReviewResult degrades when output is missing or malformed", () => {
  const missing = renderReviewResult(null, meta);
  assert.match(missing, /did not return structured/i);
  const bad = renderReviewResult({ verdict: "approve", summary: "Fine." }, meta);
  assert.match(bad, /unexpected review shape/);
  assert.match(bad, /Missing array `findings`\./);
});

test("renderTaskResult lists denied actions and the hint", () => {
  const out = renderTaskResult(
    {
      response: "Did what I could.",
      classification: { state: "completed-with-denials", reason: null, hint: "add an allow-rule for Bash" },
      deniedActions: [{ action: "run_command", displayName: "Bash" }],
      usage: { input_tokens: 3, output_tokens: 4 },
      conversationId: "conv-1"
    },
    { jobId: "task-1" }
  );
  assert.match(out, /Did what I could\./);
  assert.match(out, /Denied actions/);
  assert.match(out, /Bash/);
  assert.match(out, /allow-rule/);
  assert.match(out, /Tokens: 3 in \/ 4 out/);
  assert.match(out, /conv-1/);
});

test("renderTaskResult never prints an empty body on failure", () => {
  const out = renderTaskResult(
    {
      response: "",
      classification: { state: "failed", reason: "permission denied: Bash", hint: null },
      deniedActions: [{ action: "run_command", displayName: "Bash" }]
    },
    { jobId: "task-2" }
  );
  assert.ok(out.trim().length > 0);
  assert.match(out, /permission denied/);
  assert.match(out, /Bash/);
});

test("renderTaskResult reports timeouts with the job id", () => {
  const out = renderTaskResult(
    { response: "", classification: { state: "timed-out", reason: "agy timed out", hint: null } },
    { jobId: "task-3" }
  );
  assert.match(out, /timed out/i);
  assert.match(out, /task-3/);
});

test("renderTaskResult reports cancellation", () => {
  const out = renderTaskResult(
    { response: "", classification: { state: "cancelled", reason: "cancelled by user", hint: null } },
    { jobId: "task-4" }
  );
  assert.match(out, /cancelled/i);
});

test("renderSetupReport renders agy, auth, models and review gate", () => {
  const out = renderSetupReport({
    ready: false,
    node: { detail: "v22" },
    agy: { available: false, detail: "not found", installCommand: "curl -fsSL https://example.com | sh" },
    auth: { ok: false, detail: "not logged in" },
    models: [{ id: "gemini-3.8-flash-low", label: "Flash Low" }],
    reviewGate: { enabled: true, model: "gemini-3.8-flash-low" },
    actionsTaken: [],
    nextSteps: ["Run agy to log in."]
  });
  assert.match(out, /# Gemini Setup/);
  assert.match(out, /needs attention/);
  assert.match(out, /not found/);
  assert.match(out, /curl -fsSL/);
  assert.match(out, /not logged in/);
  assert.match(out, /gemini-3.8-flash-low/);
  assert.match(out, /review gate: enabled/i);
  assert.match(out, /Run agy to log in\./);
  assert.doesNotMatch(out, /Codex/);
});

test("renderSetupReport tolerates missing fields", () => {
  const out = renderSetupReport({});
  assert.match(out, /# Gemini Setup/);
});

test("renderStatusReport and renderJobStatusReport show conversation id and denials", () => {
  const job = {
    id: "task-9",
    status: "completed",
    kindLabel: "task",
    title: "Gemini Task",
    jobClass: "task",
    write: true,
    conversationId: "conv-9",
    agyState: "completed-with-denials",
    deniedActions: [{ action: "run_command", displayName: "Bash" }],
    logFile: "/tmp/x.log"
  };
  const status = renderStatusReport({
    config: { stopReviewGate: true },
    running: [{ ...job, id: "task-8", status: "running", elapsed: "5s" }],
    latestFinished: job,
    recent: [job],
    needsReview: true
  });
  assert.match(status, /# Gemini Status/);
  assert.match(status, /Review gate: enabled/);
  assert.match(status, /\/gemini:cancel task-8/);
  assert.match(status, /conv-9/);
  assert.doesNotMatch(status, /Codex/);

  const one = renderJobStatusReport(job);
  assert.match(one, /# Gemini Job Status/);
  assert.match(one, /agy --conversation conv-9/);
  assert.match(one, /Bash/);
  assert.match(one, /\/gemini:result task-9/);
});

test("renderStoredJobResult prefers rendered output and appends conversation id", () => {
  const out = renderStoredJobResult(
    { id: "review-1", status: "completed", jobClass: "review", conversationId: "conv-1" },
    {
      conversationId: "conv-1",
      rendered: "# Gemini Review\n\nVerdict: approve\n",
      result: { result: { verdict: "approve" } }
    }
  );
  assert.match(out, /^# Gemini Review/);
  assert.match(out, /Gemini conversation ID: conv-1/);
  assert.match(out, /Resume in Gemini: agy --conversation conv-1/);
});

test("renderStoredJobResult falls back to a stub without payload", () => {
  const out = renderStoredJobResult({ id: "t-1", status: "failed", errorMessage: "boom" }, null);
  assert.match(out, /Job: t-1/);
  assert.match(out, /boom/);
});

test("renderCancelReport mentions gemini status", () => {
  const out = renderCancelReport({ id: "t-1", title: "Gemini Task" });
  assert.match(out, /Cancelled t-1/);
  assert.match(out, /\/gemini:status/);
});
