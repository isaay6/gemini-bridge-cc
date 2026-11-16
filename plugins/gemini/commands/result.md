---
description: Show the stored final output for a finished Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the complete command output without summarizing, including status, result payload, files, line numbers, errors, and follow-up commands.
