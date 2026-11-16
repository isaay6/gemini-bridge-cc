// Parses agy `--output-format stream-json` NDJSON and classifies the run.

export function createAgyEventAccumulator() {
  const run = {
    conversationId: null,
    sawResult: false,
    status: null,
    response: "",
    structuredOutput: null,
    error: null,
    finishedReason: null,
    deniedActions: [],
    toolErrors: [],
    usage: null,
    numTurns: null,
    durationSeconds: null,
    unknownEvents: 0,
    invalidLines: 0
  };
  let streamedText = "";
  const erroredSteps = new Set();

  function noteConversation(id) {
    if (!run.conversationId && typeof id === "string" && id) {
      run.conversationId = id;
    }
  }

  function push(rawLine) {
    const text = String(rawLine ?? "").trim();
    if (!text) {
      return null;
    }
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      run.invalidLines += 1;
      return null;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      run.invalidLines += 1;
      return null;
    }

    switch (event.event) {
      case "init":
        noteConversation(event.conversation_id);
        break;
      case "step_update": {
        const step = event.step_update ?? {};
        noteConversation(step.conversation_id);
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          streamedText += step.text_delta;
        }
        const error = step.tool_info?.error;
        if (error && !erroredSteps.has(step.step_index)) {
          erroredSteps.add(step.step_index);
          run.toolErrors.push({
            tool: step.tool_info.name ?? step.tool_name ?? "",
            type: error.type ?? "",
            message: error.message ?? ""
          });
        }
        break;
      }
      case "result": {
        const r = event.result ?? {};
        noteConversation(r.conversation_id);
        run.sawResult = true;
        run.status = r.status ?? null;
        run.response = typeof r.response === "string" ? r.response : "";
        run.structuredOutput = r.structured_output && typeof r.structured_output === "object" ? r.structured_output : null;
        run.error = r.error ?? null;
        run.finishedReason = r.finished_reason ?? null;
        run.usage = r.usage ?? null;
        run.numTurns = r.num_turns ?? null;
        run.durationSeconds = r.duration_seconds ?? null;
        run.deniedActions = Array.isArray(r.denied_actions)
          ? r.denied_actions.map((d) => ({ action: d.action ?? "", displayName: d.display_name ?? "" }))
          : [];
        break;
      }
      default:
        run.unknownEvents += 1;
    }
    return event;
  }

  function finish() {
    return { ...run, response: run.response || streamedText };
  }

  return { push, finish };
}

export function parseAgyEvents(ndjson) {
  const acc = createAgyEventAccumulator();
  for (const line of String(ndjson ?? "").split("\n")) {
    acc.push(line);
  }
  return acc.finish();
}

const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";
const ALLOW_ADVICE = "Re-run with --allow <command prefix> to permit it.";

// agy suggests --dangerously-skip-permissions when it denies a tool; that advice must never be relayed.
export function stripSkipPermissionsAdvice(text) {
  const value = String(text ?? "");
  if (!value.includes(SKIP_PERMISSIONS_FLAG)) {
    return value;
  }
  return value
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !sentence.includes(SKIP_PERMISSIONS_FLAG))
    .join(" ")
    .trim();
}

function stderrLines(stderr) {
  return String(stderr ?? "")
    .split("\n")
    .map((l) => stripSkipPermissionsAdvice(l).trim())
    .filter(Boolean);
}

export function classifyAgyRun({ run, exitCode, stderr, timedOut, cancelled }) {
  const lines = stderrLines(stderr);
  const allowRuleLine = lines.find((l) => l.includes("allow-rule"));
  const hint =
    (allowRuleLine ? `${allowRuleLine} ${ALLOW_ADVICE}` : null) ??
    lines.find((l) => l.includes("--mode auto is not available")) ??
    null;
  const out = (state, reason = null) => ({ state, reason, hint });

  if (cancelled) {
    return out("cancelled", "cancelled by user");
  }
  if (timedOut || run.finishedReason === "print_timeout" || exitCode === 3) {
    return out("timed-out", run.error ?? "agy timed out");
  }
  if (!run.sawResult) {
    return out("failed", "agy exited without a result event");
  }
  if (run.status !== "SUCCESS" || exitCode !== 0) {
    return out("failed", run.error || lines[lines.length - 1] || `agy exited with code ${exitCode}`);
  }
  const hasOutput = Boolean(run.response?.trim()) || run.structuredOutput != null;
  if (run.deniedActions.length > 0) {
    if (hasOutput) {
      return out("completed-with-denials");
    }
    const names = run.deniedActions.map((d) => d.displayName || d.action).join(", ");
    return out("failed", `permission denied: ${names}`);
  }
  if (!hasOutput) {
    return out("failed", "agy returned an empty response");
  }
  return out("completed");
}
