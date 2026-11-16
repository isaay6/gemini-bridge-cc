# Changelog

## 0.1.1

### Fixed

- Windows: prompts are sent to `agy` through stdin (`--input-format stream-json`) instead of the command line, so long prompts no longer hit the ~32K command-line limit.
- Windows: line endings are forced to LF (`.gitattributes`) and parsers accept CRLF.
- macOS / Node 18: hooks read their stdin robustly (retry on `EAGAIN`). Before, a long previous Claude response could silently disable the stop-time review gate.
- Windows: the cross-process state lock tolerates `EPERM`/`EBUSY` while another process has the lock file open, retries its removal, and waits up to 30 s, so concurrent jobs no longer time out.
- The stop-time review gate passes its prompt to the companion through a private temporary file (mode 0600, deleted after the run).

### Verified

- Automated tests: 123/123 passing on ubuntu, macos and windows × Node 18.18 and 22 (GitHub Actions).
- Real agy smoke (agy 1.5.9): passed (setup, review, task, task --resume-last).
- Plugin installed into Claude Code from the marketplace; `/gemini:setup` verified inside Claude Code.

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

- Automated tests: 104/104 passing (macOS)
- Real agy smoke (agy 1.5.9): passed (setup, review, task, task --resume-last)
- Plugin install into Claude Code: verified locally
