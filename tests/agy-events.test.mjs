import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import {
  createAgyEventAccumulator,
  parseAgyEvents,
  classifyAgyRun
} from "../plugins/gemini/scripts/lib/agy-events.mjs";

function runFixture(name, extra = {}) {
  const fx = fixture(name);
  const run = parseAgyEvents(fx.ndjson);
  const verdict = classifyAgyRun({ run, exitCode: fx.exit, stderr: fx.stderr, timedOut: false, cancelled: false, ...extra });
  return { fx, run, verdict };
}

const line = (obj) => JSON.stringify(obj);
const result = (r) => line({ event: "result", result: { status: "SUCCESS", ...r } });

test("success fixture is completed", () => {
  const { run, verdict } = runFixture("success");
  assert.equal(verdict.state, "completed");
  assert.equal(run.response, "Hi! How can I help you today?\n");
  assert.equal(run.conversationId, "29a22bce-0352-4fc2-b4d3-f8d4770c7928");
});

test("review-structured is completed with structured output", () => {
  const { run, verdict } = runFixture("review-structured");
  assert.equal(verdict.state, "completed");
  assert.equal(run.structuredOutput.verdict, "needs-attention");
  assert.equal(run.structuredOutput.findings.length, 1);
});

test("review-write-denied is failed with denial reason and hint", () => {
  const { run, verdict } = runFixture("review-write-denied");
  assert.equal(verdict.state, "failed");
  assert.match(verdict.reason, /^permission denied: Edit/);
  assert.match(verdict.hint, /allow-rule/);
  assert.deepEqual(run.deniedActions, [{ action: "write_file", displayName: "Edit" }]);
});

test("command-denied is failed", () => {
  const { run, verdict } = runFixture("command-denied");
  assert.equal(verdict.state, "failed");
  assert.equal(run.deniedActions[0].action, "command");
});

test("rescue-edit-ok is completed with no tool errors", () => {
  const { run, verdict } = runFixture("rescue-edit-ok");
  assert.equal(verdict.state, "completed");
  assert.deepEqual(run.toolErrors, []);
});

test("invalid-model is failed with exit 1", () => {
  const { fx, verdict } = runFixture("invalid-model");
  assert.equal(fx.exit, 1);
  assert.equal(verdict.state, "failed");
  assert.match(verdict.reason, /not recognized/);
});

test("print-timeout is timed-out with exit 3", () => {
  const { fx, verdict } = runFixture("print-timeout");
  assert.equal(fx.exit, 3);
  assert.equal(verdict.state, "timed-out");
});

test("resume is completed with two turns", () => {
  const { run, verdict } = runFixture("resume");
  assert.equal(verdict.state, "completed");
  assert.equal(run.numTurns, 2);
});

test("tool errors are collected once per step", () => {
  const { run } = runFixture("command-denied");
  assert.equal(run.toolErrors.length, 1);
  assert.equal(run.toolErrors[0].tool, "run_command");
  assert.equal(run.toolErrors[0].type, "TOOL_ERROR");
  const err = (n) => line({ event: "step_update", step_update: { step_index: n, state: "ERROR", tool_info: { name: "x", error: { type: "T", message: "m" } } } });
  const acc = createAgyEventAccumulator();
  acc.push(err(1));
  acc.push(err(1));
  acc.push(err(2));
  assert.equal(acc.finish().toolErrors.length, 2);
});

test("classify: empty success is failed", () => {
  const run = parseAgyEvents(result({ response: "" }));
  const v = classifyAgyRun({ run, exitCode: 0, stderr: "", timedOut: false, cancelled: false });
  assert.equal(v.state, "failed");
  assert.match(v.reason, /empty response/);
});

test("no result event is failed", () => {
  const run = parseAgyEvents(line({ event: "init", conversation_id: "c1", init: {} }));
  const v = classifyAgyRun({ run, exitCode: 0, stderr: "boom\n", timedOut: false, cancelled: false });
  assert.equal(v.state, "failed");
  assert.match(v.reason, /without a result event/);
  assert.equal(run.conversationId, "c1");
});

test("unknown event counted, not fatal", () => {
  const run = parseAgyEvents([line({ event: "weird" }), result({ response: "ok" })].join("\n"));
  assert.equal(run.unknownEvents, 1);
  assert.equal(classifyAgyRun({ run, exitCode: 0, stderr: "", timedOut: false, cancelled: false }).state, "completed");
});

test("non-JSON line counted, not fatal", () => {
  const run = parseAgyEvents(["not json", "", result({ response: "ok" })].join("\n"));
  assert.equal(run.invalidLines, 1);
  assert.equal(classifyAgyRun({ run, exitCode: 0, stderr: "", timedOut: false, cancelled: false }).state, "completed");
});

test("response falls back to agent_response text deltas", () => {
  const delta = (t) => line({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: t } });
  const run = parseAgyEvents([delta("a"), delta("b"), result({ response: "" })].join("\n"));
  assert.equal(run.response, "ab");
});

test("denials with non-empty response is completed-with-denials", () => {
  const run = parseAgyEvents(result({ response: "partial", denied_actions: [{ action: "command", display_name: "Bash" }] }));
  const v = classifyAgyRun({ run, exitCode: 0, stderr: "", timedOut: false, cancelled: false });
  assert.equal(v.state, "completed-with-denials");
});

test("cancelled wins over everything", () => {
  const run = parseAgyEvents(result({ response: "ok" }));
  const v = classifyAgyRun({ run, exitCode: 3, stderr: "", timedOut: true, cancelled: true });
  assert.equal(v.state, "cancelled");
});

test("command-denied hint never relays skip-permissions advice and suggests --allow", () => {
  const { verdict } = runFixture("command-denied");
  assert.match(verdict.hint, /allow-rule/);
  assert.doesNotMatch(verdict.hint, /dangerously/);
  assert.match(verdict.hint, /--allow/);
});

test("stderr fallback reasons never relay skip-permissions advice", () => {
  const run = parseAgyEvents(line({ event: "result", result: { status: "ERROR", response: "" } }));
  const verdict = classifyAgyRun({
    run,
    exitCode: 1,
    stderr: "boom. Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.\n",
    timedOut: false,
    cancelled: false
  });
  assert.equal(verdict.state, "failed");
  assert.doesNotMatch(verdict.reason, /dangerously/);
});
