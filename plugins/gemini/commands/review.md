---
description: Run a Gemini code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Gemini review through the shared runtime. This command is review-only: do not fix issues or apply patches. Return its output verbatim.

Raw slash-command arguments: `$ARGUMENTS`

If the arguments include `--wait`, run in the foreground. If they include `--background`, launch the command with `Bash(..., run_in_background: true)`. Otherwise, estimate the review size using `git status --short --untracked-files=all` and the relevant `git diff --shortstat`; ask exactly once whether to wait or run in the background. Recommend waiting only for a clearly tiny review (roughly one or two files); recommend background otherwise.

Preserve arguments exactly. The companion parses `--wait` and `--background`; Claude Code controls actual background execution.

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"
```

Return stdout exactly as-is.

Background:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`,
  description: "Gemini review",
  run_in_background: true
})
```

After launching, say: "Gemini review started in the background. Check `/gemini:status` for progress."
