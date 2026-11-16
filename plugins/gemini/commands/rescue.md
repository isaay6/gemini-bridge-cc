---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <id>] [--effort <level>] [--allow <prefix>] [request]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent via `Agent` and forward the raw user request as its prompt. It is a subagent, not a skill. Its final output must be returned verbatim.

`--background` and `--wait` control Claude Code execution and are not forwarded to `task`. Preserve `--model`, `--effort`, and `--allow` for the task runtime, but do not include them in the natural-language task text. Default to foreground when neither execution flag is provided.

Unless `--resume` or `--fresh` was specified, first run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
```

When it reports `available: true`, ask exactly once whether to continue the current Gemini thread or start a new one. If the user chooses continue, add `--resume`; otherwise add `--fresh`. Do not ask when it reports unavailable.

The subagent should make one `task` call and return its stdout unchanged. If no request was supplied, ask what Gemini should investigate or fix. If the runtime reports that agy is unavailable or unauthenticated, direct the user to `/gemini:setup`.
