# Changelog

## 0.1.0

Initial release (unofficial).

- `/gemini:setup`, `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`.
- Background jobs, resumable Gemini conversations, optional stop-time review gate.
- Read-only command allow-list for reviews; `accept-edits` plus `--allow` for tasks; optional `--auto`.
- Never uses `--dangerously-skip-permissions`.
- Tested with `agy` 1.5.9; minimum supported 1.5.0.

### Security

- On Windows, only the native `agy.exe` is executed; `.cmd` and `.bat` wrappers are rejected to prevent command injection.

### Verified

- Automated tests: 104/104 passing
- Real agy smoke (agy 1.5.9): passed (setup, review, task, task --resume-last)
- Plugin install into Claude Code and `/gemini:*` commands: pending (done by the controller)
