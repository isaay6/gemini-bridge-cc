---
description: Check whether the local Antigravity CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

If the result says agy is unavailable:

- Use `AskUserQuestion` exactly once to ask whether Claude should install agy now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these options:
  - `Install agy (Recommended)`
  - `Skip for now`
- If the user chooses installation, run the official installer appropriate to the platform:
  - macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  - Windows: `irm https://antigravity.google/cli/install.ps1 | iex`
- Then rerun the setup command above.

If agy is already installed, do not ask about installation.

Present the final setup output. If installation was skipped, present the original setup output. Preserve any guidance to run `!agy` to sign in.
