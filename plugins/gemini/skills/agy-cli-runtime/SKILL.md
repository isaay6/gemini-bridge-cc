---
name: agy-cli-runtime
description: Internal helper contract for calling the Gemini companion task runtime from Claude Code
user-invocable: false
---

# agy Runtime

Use this skill only inside `gemini:gemini-rescue`.

- Invoke exactly one command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...`.
- The rescue subagent is a forwarder, not an orchestrator. Return stdout unchanged and do no repository work of its own.
- Do not call setup, review, adversarial-review, status, result, or cancel.
- Default to `--write`; use `--read-only` only for an explicit read-only request or a request limited to review, diagnosis, or research.
- Pass `--model` as the requested agy model id (`agy models` lists ids), and pass `--allow` through unchanged.
- Strip Claude-side `--background` and `--wait` controls before invoking `task`.
- Map `--resume` to `--resume-last`; `--fresh` means no resume. Preserve `--model`, `--effort`, and `--allow` as runtime options, not task text.
