# gemini-bridge-cc

Use Gemini from inside Claude Code. The `gemini` plugin delegates code reviews and tasks to Google's Antigravity CLI (`agy`) and brings the results back into your Claude Code session.

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by Google or OpenAI. It is a community plugin that drives the `agy` command-line tool you install yourself.

## Requirements

- Node.js 18.18 or newer
- Antigravity CLI (`agy`) 1.5.0 or newer (tested with 1.5.9), installed and signed in
- A Google account that can use `agy`

## Install

```bash
claude plugin marketplace add isaay6/gemini-bridge-cc
claude plugin install gemini@isaay6
```

Then, inside Claude Code, run:

```
/gemini:setup
```

`/gemini:setup` checks that `agy` is installed, supported and authenticated, and lists the models your account can use.

While this repository is private, `claude plugin marketplace add isaay6/gemini-bridge-cc` needs GitHub access to the repo (for example a signed-in `gh` or a configured git credential). To install from a local clone instead:

```bash
git clone <repo url> /path/to/clone
claude plugin marketplace add /path/to/clone
claude plugin install gemini@isaay6
```

## Commands

| Command | What it does |
| --- | --- |
| `/gemini:setup [--enable-review-gate\|--disable-review-gate]` | Checks `agy` (install, version, sign-in), lists models, and toggles the optional stop-time review gate. |
| `/gemini:review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch]` | Gemini code review of your local git changes. Review-only: it never edits files. |
| `/gemini:adversarial-review [--wait\|--background] [--base <ref>] [--scope auto\|working-tree\|branch] [focus ...]` | A review that challenges the approach, design choices and assumptions. Extra text is treated as focus. |
| `/gemini:rescue [--background\|--wait] [--resume\|--fresh] [--model <id>] [--effort <level>] [--allow <prefix>] [request]` | Hands an investigation or fix to the `gemini:gemini-rescue` subagent. `--resume` continues the previous Gemini conversation; `--fresh` starts a new one. |
| `/gemini:status [job-id] [--all]` | Shows running and recent Gemini jobs for this repository, plus review-gate status. |
| `/gemini:result [job-id]` | Shows the stored final output of a finished job. |
| `/gemini:cancel [job-id]` | Cancels an active background job. |

Reviews use `--base <ref>` to compare `<ref>...HEAD`, and `--scope` to pick the working tree, a branch diff, or `auto`.

### Stop-time review gate

`/gemini:setup --enable-review-gate` makes Gemini review Claude's last-turn changes before a session stops. It has its own 5 minute limit and, if that is exceeded, lets the stop through and tells you. It is off by default and can use quota on every stop, so enable it deliberately.

## Permissions model

`agy` runs non-interactively, so the plugin decides up front what it may do:

- **Reviews** run in `agy`'s default mode with an allow-list of read-only commands only: `git`, `ls`, `cat`, `grep`, `find`, `rg`, `head`, `tail`, `wc`. Any write is denied.
- **Rescue tasks** run with `--mode accept-edits`, so Gemini can edit files, plus the same read-only command allow-list.
- **`--allow <prefix>`** (repeatable) adds a command prefix, for example `--allow "npm test"`. Anything not on the list is denied and reported.
- **`--auto`** (companion `task` flag) opts into `agy`'s `auto` mode. It is not available for every account; if it is not, `agy` falls back to its default mode and the plugin tells you.
- **The plugin never uses `--dangerously-skip-permissions`**, and never uses `--mode plan`.
- A denial ends the Gemini turn. If actions were denied the result is reported as completed with denials, and as failed for permissions if there was no response, listing what was denied.

Settings are passed per run with `--settings`; your own `agy` configuration is not modified.

## Privacy

This plugin sends your code to Google. When you run a review or task, `agy` reads files and `git diff` output from your repository and transmits prompts and that content to Google's services under your Google account. Do not use it on code you are not allowed to share with Google. Review prompts do not embed the full diff; they name the target and ask `agy` to run `git diff` itself, but the result still reaches Google.

Job state is stored locally under `CLAUDE_PLUGIN_DATA`, or `$TMPDIR/gemini-bridge` if that is unset.

## Google terms

Whether driving `agy` from third-party tooling is within Google's terms of use is not clearly answered by Google. You are responsible for checking the terms that apply to your account and `agy` plan. This repository is private until the maintainer decides otherwise.

## Troubleshooting

- **Edits are denied in a temp or symlinked directory.** `agy` denies edits when the working directory passes through a symlink (for example `/var` or `/tmp` on macOS). The plugin launches `agy` with the resolved real path; if you test by hand, use a real path such as one under `$HOME`.
- **`--mode auto is not available`.** Some accounts cannot use `auto` mode. `agy` continues in default mode and the plugin reports it. Drop `--auto` or use `--allow` for the commands you need.
- **A job times out.** Defaults are 900 s for reviews, 1800 s for tasks and 300 s for the stop gate. Use `--timeout <seconds>` on the companion, or narrow the review with `--base` / `--scope`.
- **Empty result with denied actions.** `agy` stops the turn at the first denial. Re-run with `--allow "<command prefix>"` for what it needed.
- **Not signed in or `agy` not found.** Run `/gemini:setup`. To point at a custom binary set `GEMINI_BRIDGE_AGY_BIN`.
- **Prompt too large.** Prompts over 100000 characters are rejected; narrow the scope.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md).

## Credits and license

Licensed under Apache-2.0. The plugin structure is derived from OpenAI's Codex plugin for Claude Code, which is also Apache-2.0; see [NOTICE](NOTICE). Modified by isaay6 in 2026: replaced the Codex transport with Antigravity CLI (`agy`).
