function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.sessionUnknown) {
    parts.push("session unknown");
  }
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatResumeCommand(conversationId) {
  return conversationId ? `agy --conversation ${conversationId}` : null;
}

function formatUsageLine(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (input == null && output == null) {
    return null;
  }
  return `Tokens: ${input ?? 0} in / ${output ?? 0} out`;
}

function deniedLabel(denied) {
  return denied?.displayName || denied?.action || "unknown";
}

function appendDeniedSection(lines, deniedActions, hint) {
  if (!Array.isArray(deniedActions) || deniedActions.length === 0) {
    return;
  }
  lines.push("", "Denied actions:");
  for (const denied of deniedActions) {
    lines.push(`- ${deniedLabel(denied)}`);
  }
  if (hint) {
    lines.push("", `Hint: ${hint}`);
  }
}

function appendFooter(lines, { usage, conversationId }) {
  const usageLine = formatUsageLine(usage);
  if (usageLine) {
    lines.push("", usageLine);
  }
  if (conversationId) {
    lines.push("", `Gemini conversation ID: ${conversationId}`, `Resume in Gemini: ${formatResumeCommand(conversationId)}`);
  }
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Gemini Conversation ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/gemini:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/gemini:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.sessionUnknown ? `${job.status} (session unknown)` : job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.conversationId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.agyState && job.agyState !== "completed") {
    lines.push(`  Outcome: ${job.agyState}`);
  }
  if (Array.isArray(job.deniedActions) && job.deniedActions.length > 0) {
    lines.push(`  Denied actions: ${job.deniedActions.map(deniedLabel).join(", ")}`);
  }
  const usageLine = formatUsageLine(job.usage);
  if (usageLine) {
    lines.push(`  ${usageLine}`);
  }
  if (job.conversationId) {
    lines.push(`  Gemini conversation ID: ${job.conversationId}`);
    lines.push(`  Resume in Gemini: ${formatResumeCommand(job.conversationId)}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /gemini:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /gemini:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /gemini:review --wait");
    lines.push("  Stricter review: /gemini:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

function finish(lines) {
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSetupReport(report = {}) {
  const agy = report.agy ?? {};
  const auth = report.auth ?? {};
  const models = Array.isArray(report.models) ? report.models : [];
  const gate = report.reviewGate ?? {};
  const agyDetail =
    agy.detail ??
    (agy.available ? [agy.path, agy.version].filter(Boolean).join(" ") || "available" : "not found");
  const lines = [
    "# Gemini Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:"
  ];
  if (report.node?.detail) {
    lines.push(`- node: ${report.node.detail}`);
  }
  if (report.npm?.detail) {
    lines.push(`- npm: ${report.npm.detail}`);
  }
  lines.push(`- agy: ${agyDetail}`);
  if (agy.available && agy.tested === false) {
    lines.push("  (this agy version has not been tested with the plugin)");
  }
  if (!agy.available && agy.installCommand) {
    lines.push(`  Install: ${agy.installCommand}`);
  }
  lines.push(`- auth: ${auth.detail ?? (auth.ok ? "authenticated" : "not checked")}`);
  if (models.length > 0) {
    lines.push("- models:");
    for (const model of models) {
      const label = model.label && model.label !== model.id ? ` (${model.label})` : "";
      lines.push(`  - ${model.id}${label}`);
    }
  }
  lines.push(
    `- review gate: ${gate.enabled ? "enabled" : "disabled"}${gate.enabled && gate.model ? ` (model: ${gate.model})` : ""}`,
    ""
  );

  if (report.actionsTaken?.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps?.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return finish(lines);
}

function renderReviewProblem(meta, headline, detailLine, rawOutput) {
  const lines = [`# Gemini ${meta.reviewLabel}`, ""];
  if (meta.targetLabel) {
    lines.push(`Target: ${meta.targetLabel}`);
  }
  lines.push(headline, "", detailLine);
  if (rawOutput) {
    lines.push("", "Raw final message:", "", "```text", rawOutput, "```");
  }
  appendReasoningSection(lines, meta.reasoningSummary);
  appendFooter(lines, meta);
  return finish(lines);
}

export function renderReviewResult(structuredOutput, meta = {}) {
  meta = { reviewLabel: "Review", ...meta };
  if (structuredOutput == null) {
    return renderReviewProblem(
      meta,
      "Gemini did not return structured review output.",
      `- Detail: ${meta.parseError ?? "no structured output was captured"}`,
      meta.rawOutput
    );
  }

  const validationError = validateReviewResultShape(structuredOutput);
  if (validationError) {
    return renderReviewProblem(
      meta,
      "Gemini returned JSON with an unexpected review shape.",
      `- Validation error: ${validationError}`,
      meta.rawOutput ?? JSON.stringify(structuredOutput)
    );
  }

  const data = normalizeReviewResultData(structuredOutput);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Gemini ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);
  appendFooter(lines, meta);

  return finish(lines);
}

export function renderTaskResult(result = {}, meta = {}) {
  const { response, classification, deniedActions, usage, conversationId } = result;
  const state = classification?.state ?? "completed";
  const reason = classification?.reason ?? null;
  const hint = classification?.hint ?? null;
  const body = typeof response === "string" ? response.trim() : "";
  const lines = [];

  if (state === "timed-out") {
    lines.push(`Gemini timed out${meta.jobId ? ` (job ${meta.jobId})` : ""}.`);
    if (reason) {
      lines.push("", `Reason: ${reason}`);
    }
    if (body) {
      lines.push("", "Partial output:", "", body);
    }
  } else if (state === "cancelled") {
    lines.push(`Gemini run was cancelled${meta.jobId ? ` (job ${meta.jobId})` : ""}.`);
    if (body) {
      lines.push("", "Partial output:", "", body);
    }
  } else if (state === "failed") {
    lines.push(`Gemini run failed${meta.jobId ? ` (job ${meta.jobId})` : ""}.`);
    lines.push("", `Reason: ${reason || "Gemini did not return a final message."}`);
    if (body) {
      lines.push("", "Partial output:", "", body);
    }
  } else if (body) {
    lines.push(body);
  } else {
    lines.push("Gemini did not return a final message.");
  }

  const showHint = state !== "completed";
  appendDeniedSection(lines, deniedActions, showHint ? hint : null);
  appendFooter(lines, { usage, conversationId });
  return finish(lines);
}

export function renderStatusReport(report) {
  const lines = [
    "# Gemini Status",
    "",
    `Review gate: ${report.config?.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];
  const running = report.running ?? [];
  const recent = report.recent ?? [];

  if (running.length > 0) {
    appendActiveJobsTable(lines, running);
    lines.push("");
    lines.push("Live details:");
    for (const job of running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Gemini adversarial review and block if it finds issues.");
  }

  return finish(lines);
}

export function renderJobStatusReport(job) {
  const lines = ["# Gemini Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return finish(lines);
}

export function renderStoredJobResult(job, storedJob) {
  const conversationId = storedJob?.conversationId ?? job.conversationId ?? null;
  const withResume = (text) => {
    const output = text.endsWith("\n") ? text : `${text}\n`;
    if (!conversationId) {
      return output;
    }
    return `${output}\nGemini conversation ID: ${conversationId}\nResume in Gemini: ${formatResumeCommand(conversationId)}\n`;
  };

  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    return withResume(storedJob.rendered);
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.response === "string" && storedJob.result.response) ||
    "";
  if (rawOutput) {
    return withResume(rawOutput);
  }

  if (storedJob?.rendered) {
    return withResume(storedJob.rendered);
  }

  const lines = [
    `# ${job.title ?? "Gemini Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (conversationId) {
    lines.push(`Gemini conversation ID: ${conversationId}`);
    lines.push(`Resume in Gemini: ${formatResumeCommand(conversationId)}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return finish(lines);
}

export function renderCancelReport(job) {
  const lines = [
    "# Gemini Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/gemini:status` for the updated queue.");

  return finish(lines);
}
