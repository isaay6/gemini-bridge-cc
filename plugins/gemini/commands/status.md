---
description: Show active and recent Gemini jobs for this repository, including review-gate status
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status "$ARGUMENTS"`

Without a job ID, render output as one compact Markdown table and preserve job ID, kind, status, phase, duration, summary, and follow-up commands. With a job ID, present full output without summarizing.
