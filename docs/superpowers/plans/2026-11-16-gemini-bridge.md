# gemini-bridge-cc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin (`gemini`, marketplace `isaay6`) that lets Claude delegate code reviews and tasks to Google's Antigravity CLI (`agy`), ported from OpenAI's codex plugin 1.0.6.

**Architecture:** Slash commands (`commands/*.md`) call one Node entry point, `scripts/gemini-companion.mjs`. Each review/task spawns one `agy --input-format stream-json --output-format stream-json` process, sends its prompt as one NDJSON line over stdin, and parses its NDJSON events into a run summary, which is then classified into a job state. Job tracking, git context, state and rendering are ported from the codex plugin; the Codex transport (app-server, broker) is dropped.

**Tech Stack:** Node ≥ 18.18 ES modules, no runtime dependencies, `node --test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-16-gemini-bridge-design.md` (read §5.8 "Resultados de la fase 0" before any task touching `agy`).

**Reference source (read-only):** codex plugin at `~/.claude/plugins/cache/openai-codex/codex/1.0.6/` (called `CODEX/` below) and its repo with tests at `~/.claude/plugins/marketplaces/openai-codex/` (called `CODEXREPO/`).

## Global Constraints

- Node `>=18.18.0`; zero runtime npm dependencies; ES modules (`"type": "module"`).
- License Apache-2.0. `NOTICE` must keep OpenAI's copyright and add: "Modified by isaay6 in 2026: replaced the Codex transport with Antigravity CLI (agy)." Every file ported from CODEX keeps its behaviour, minus Codex-specific parts.
- Names: plugin `gemini`, marketplace `isaay6`, repo `gemini-bridge-cc`, commands `/gemini:*`, subagent `gemini:gemini-rescue`, env prefix `GEMINI_BRIDGE_`, fallback state dir `os.tmpdir()/gemini-bridge`.
- `agy` is always spawned with `cwd = fs.realpathSync.native(workspaceRoot)`, `stdio: ["pipe","pipe","pipe"]`, `--input-format stream-json`, `--output-format stream-json`, an explicit `--print-timeout`, and exactly one prompt NDJSON line before stdin is closed.
- Never pass `--dangerously-skip-permissions`. Never use `--mode plan`.
- Read-only command allow-list: `git, ls, cat, grep, find, rg, head, tail, wc`.
- Default timeouts: review 900 s, task 1800 s, stop gate 300 s. External kill timer = print-timeout + 30 s.
- Tested agy version `1.5.9`; minimum accepted `1.5.0`.
- Public docs (README, command descriptions, prompts) in English. README states: unofficial, not affiliated with Google or OpenAI; code and diffs are sent to Google through agy.
- Repo stays **private** until the user decides otherwise.

## Review Focus

1. **Empty "successful" run** (agy exit 0, `status: SUCCESS`, `response: ""`, no denials). The user expects an error, not a blank result → test `classify: empty success is failed` (Task 2).
2. **Workspace path through a symlink** (macOS `/var` → `/private/var`, symlinked checkouts). The user expects edits to work → test `runAgy spawns in realpath cwd` (Task 3).
3. **agy hangs without ever emitting `result`.** The user expects the job to end as `timed-out` and the process tree to be killed → test `runAgy kills hung agy after timeout` (Task 3).
4. **`agy` missing or not authenticated when a command runs.** The user expects a pointer to `/gemini:setup`, not a stack trace → test `review without agy prints setup hint` (Task 6).
5. **`/gemini:cancel` on a background job.** The user expects the agy child to die and the job to be `cancelled`, not `failed` → test `cancel kills worker and agy child` (Task 7).

---

### Task 1: Repository scaffold and manifests

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/gemini/.claude-plugin/plugin.json`, `package.json`, `LICENSE` (copy `CODEXREPO/LICENSE`), `NOTICE`, `.gitignore`, `.github/workflows/ci.yml`, `tests/helpers.mjs`, `tests/manifest.test.mjs`
- Already present: `tests/fixtures/agy/*.{ndjson,stderr,exit}` (real recordings from phase 0)

**Interfaces:**
- Produces: `tests/helpers.mjs` exports `fixture(name) -> {ndjson: string, stderr: string, exit: number}`, `makeTempRepo(files: Record<string,string>) -> string` (git-initialised, one commit, returns **realpath**), `REPO_ROOT`, `PLUGIN_ROOT`.

- [ ] **Step 1:** `git init -b main`; `package.json`: name `gemini-bridge-cc`, version `0.1.0`, private, type module, engines node `>=18.18.0`, scripts `test: node --test tests/`, `bump-version`, `check-version`.
- [ ] **Step 2: Write failing test** `tests/manifest.test.mjs`: marketplace `name === "isaay6"`, single plugin `name === "gemini"`, `source === "./plugins/gemini"`; versions in `package.json`, `marketplace.json` (metadata + plugin) and `plugin.json` are all equal.
- [ ] **Step 3:** Run `npm test` → FAIL (files missing). Write the manifests (descriptions: "Use Gemini (via Antigravity CLI) from Claude Code to review code or delegate tasks. Unofficial.") → PASS.
- [ ] **Step 4:** CI matrix `ubuntu-latest, macos-latest, windows-latest` × node `18.18`, `22`, running `npm test` and `npm run check-version`.
- [ ] **Step 5: Commit** `chore: scaffold gemini-bridge-cc plugin`.

### Task 2: agy event parser and run classifier

**Files:**
- Create: `plugins/gemini/scripts/lib/agy-events.mjs`, `tests/agy-events.test.mjs`

**Interfaces:**
- Produces:
  - `createAgyEventAccumulator() -> { push(line: string): AgyEvent|null, finish(): AgyRun }`
  - `parseAgyEvents(ndjson: string) -> AgyRun`
  - `AgyRun = { conversationId: string|null, sawResult: boolean, status: string|null, response: string, structuredOutput: object|null, error: string|null, finishedReason: string|null, deniedActions: {action: string, displayName: string}[], toolErrors: {tool: string, type: string, message: string}[], usage: object|null, numTurns: number|null, durationSeconds: number|null, unknownEvents: number, invalidLines: number }`
  - `classifyAgyRun({ run, exitCode, stderr, timedOut, cancelled }) -> { state: "completed"|"completed-with-denials"|"failed"|"timed-out"|"cancelled", reason: string|null, hint: string|null }`

Classification order (first match wins): cancelled → `cancelled`; `timedOut` or `finishedReason === "print_timeout"` or `exitCode === 3` → `timed-out`; `!sawResult` → `failed` ("agy exited without a result event"); `status !== "SUCCESS"` or `exitCode !== 0` → `failed` (reason = `error` or last stderr line); `deniedActions.length > 0` → `completed-with-denials` if response or structuredOutput non-empty, else `failed` (reason starts with `"permission denied: "` + display names); empty response and no structuredOutput → `failed` ("agy returned an empty response"); else `completed`. `hint` = the stderr line containing `allow-rule`, or the line containing `--mode auto is not available`, or null.

`response` comes from `result.response`; if that is empty, fall back to the concatenated `text_delta` of `agent_response` steps. `conversationId` is taken from the first event that carries one (`init` has it at top level).

- [ ] **Step 1: Write failing tests**, one per fixture:
  - `success` → completed, response `"Hi! How can I help you today?\n"`.
  - `review-structured` → completed, `structuredOutput.verdict === "needs-attention"`, `findings.length === 1`.
  - `review-write-denied` → failed, reason matches `/^permission denied: Edit/`, hint matches `/allow-rule/`.
  - `command-denied` → failed, `deniedActions[0].action === "command"`.
  - `rescue-edit-ok` → completed, `toolErrors` empty.
  - `invalid-model` → failed with exit 1, reason matches `/not recognized/`.
  - `print-timeout` → timed-out with exit 3.
  - `resume` → completed, `numTurns === 2`.
  - Synthetic: `classify: empty success is failed`; `no result event is failed`; `unknown event counted, not fatal`; `non-JSON line counted, not fatal`; `denials with non-empty response is completed-with-denials`; `cancelled wins over everything`.
- [ ] **Step 2:** `node --test tests/agy-events.test.mjs` → FAIL.
- [ ] **Step 3:** Implement `agy-events.mjs`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: parse and classify agy stream-json runs`.

### Task 3: agy runner

**Files:**
- Create: `plugins/gemini/scripts/lib/agy.mjs`, `tests/fake-agy.mjs`, `tests/agy.test.mjs`
- Port: `CODEX/scripts/lib/process.mjs` → `plugins/gemini/scripts/lib/process.mjs` (unchanged) with `CODEXREPO/tests/process.test.mjs` → `tests/process.test.mjs`

**Interfaces:**
- Consumes: `createAgyEventAccumulator`, `classifyAgyRun` (Task 2); `terminateProcessTree(pid)`, `runCommand` (process.mjs).
- Produces:
  - `READ_ONLY_COMMANDS: string[]`, `TESTED_AGY_VERSION = "1.5.9"`, `MIN_AGY_VERSION = "1.5.0"`
  - `resolveAgyBinary(env = process.env) -> string|null`: `env.GEMINI_BRIDGE_AGY_BIN`, then `agy` on PATH, then `~/.local/bin/agy`, then `%LOCALAPPDATA%\agy\bin\agy.exe`.
  - `buildPermissionSettings({ extraAllow = [] }) -> string`: JSON `{"permissions":{"allow":["command(git)",…, "command(<extra>)"]}}`.
  - `buildAgyArgs({ prompt, model, effort, mode, conversationId, jsonSchemaPath, printTimeoutSeconds, settingsJson }) -> string[]`: starts with `["-p", prompt, "--output-format", "stream-json", "--print-timeout", "<n>s"]`, and adds each optional flag only when it is set. `mode` ∈ `accept-edits|auto|undefined`.
  - `getAgyVersion(bin) -> { ok: boolean, version: string|null, detail: string|null }`
  - `listAgyModels(bin) -> { id: string, label: string }[]` (parses `id\tlabel` lines, skips "Fetching…").
  - `runAgy({ bin, args, cwd, timeoutMs, onEvent, onStderrLine, signal }) -> Promise<{ run: AgyRun, exitCode: number|null, stderr: string, timedOut: boolean, cancelled: boolean, classification }>`. Spawns with realpath cwd; if `bin` ends in `.mjs`/`.js`, spawns `process.execPath bin …`; POSIX `detached: true` so the tree can be killed; on timeout or abort it calls `terminateProcessTree`.

`tests/fake-agy.mjs`: `--version` prints `FAKE_AGY_VERSION` (default `1.5.9`); `models` prints two tab-separated lines; otherwise it writes `{argv, cwd}` JSON to `FAKE_AGY_ARGS_FILE` (if set), replays `tests/fixtures/agy/$FAKE_AGY_FIXTURE.{ndjson,stderr}` and exits with `.exit`; `FAKE_AGY_HANG=1` prints the init line and sleeps forever.

- [ ] **Step 1: Write failing tests:** `buildAgyArgs` minimal and full (exact arrays); `buildPermissionSettings` with `extraAllow: ["npm test"]` includes `"command(npm test)"` and all 9 read-only entries; `resolveAgyBinary` honours env; `getAgyVersion` → `1.5.9`; `listAgyModels` → 2 entries; `runAgy replays success fixture`; `runAgy spawns in realpath cwd` (pass a symlink to a temp dir, then assert that the recorded cwd equals its realpath); `runAgy kills hung agy after timeout` (`FAKE_AGY_HANG=1`, `timeoutMs: 1500` → `timedOut: true`, classification `timed-out`, pid no longer alive); `runAgy abort signal → cancelled`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS (also on the ported process tests).
- [ ] **Step 5: Commit** `feat: spawn agy with timeouts, permissions and realpath cwd`.

### Task 4: Port shared libraries

**Files (port from `CODEX/scripts/lib/`, renaming codex→gemini in identifiers, messages and env vars; logic unchanged):**
- `args.mjs`, `fs.mjs` (temp prefix `gemini-bridge-`), `git.mjs`, `state.mjs` (fallback dir `gemini-bridge`), `tracked-jobs.mjs` (`SESSION_ID_ENV = "GEMINI_BRIDGE_SESSION_ID"`), `job-control.mjs`, `workspace.mjs`, `prompts.mjs`
- Tests: port `CODEXREPO/tests/{git,state}.test.mjs` → `tests/`.

**Interfaces:**
- Produces (same signatures as CODEX): `parseArgs`, `splitRawArgumentString`, `resolveReviewTarget`, `collectReviewContext`, `getWorkingTreeState`, `loadState`, `saveState`, `upsertJob`, `listJobs`, `getConfig`, `setConfig`, `writeJobFile`, `readJobFile`, `resolveJobLogFile`, `generateJobId`, `runTrackedJob`, `createJobRecord`, `createJobLogFile`, `appendLogLine`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `resolveResultJob`, `resolveCancelableJob`, `sortJobsNewestFirst`, `resolveWorkspaceRoot`, `loadPromptTemplate`, `interpolateTemplate`.
- Job records gain the fields `conversationId: string|null`, `agyState` (the classification state), `deniedActions`, `usage`.

- [ ] **Step 1:** Copy the ported tests and adjust names → run → FAIL.
- [ ] **Step 2:** Port the files; `grep -ri codex plugins/gemini/scripts/lib` returns nothing.
- [ ] **Step 3:** Run → PASS. **Step 4: Commit** `feat: port job tracking, git and state helpers`.

### Task 5: Rendering

**Files:**
- Port and modify: `CODEX/scripts/lib/render.mjs` → `plugins/gemini/scripts/lib/render.mjs`; `CODEXREPO/tests/render.test.mjs` → `tests/render.test.mjs`

**Interfaces:**
- Consumes: `AgyRun` and classification (Task 2).
- Produces: `renderSetupReport(report)`, `renderReviewResult(structuredOutput, meta)`, `renderTaskResult({ response, classification, deniedActions, usage, conversationId }, meta)`, `renderStatusReport`, `renderJobStatusReport`, `renderStoredJobResult`, `renderCancelReport`. Remove `renderNativeReviewResult`.

- [ ] **Step 1: Failing tests:** review render of the `review-structured` fixture contains `critical` and `calc.py:1`; a task render with state `completed-with-denials` contains a "Denied actions" section that lists `Bash` and the hint; a `failed` render with reason `permission denied` never prints an empty body; `timed-out` renders "timed out" and the job id.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: render agy results with denials and usage`.

### Task 6: Companion — setup and reviews

**Files:**
- Create: `plugins/gemini/scripts/gemini-companion.mjs` (subcommands `setup`, `review`, `adversarial-review`), `plugins/gemini/prompts/review.md`, port `CODEX/prompts/adversarial-review.md`, copy `CODEX/schemas/review-output.schema.json`
- Test: `tests/companion-review.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: CLI `node gemini-companion.mjs <sub> [--json] [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>] [--timeout <s>] [focus…]`. With `--json`, it prints `{ ok, state, jobId, rendered, structuredOutput?, rawOutput }`.

Rules:
- `setup` reports `agy` (path, version vs `MIN`/`TESTED`), auth (one `agy -p "Reply with OK" --print-timeout 60s` call; failure ⇒ `"Run !agy to sign in"`), models (`listAgyModels`), and gate state; `--enable-review-gate` / `--disable-review-gate` call `setConfig`. If agy is missing, `installCommand` is the official one-liner for the platform (it is never run by the script).
- Review prompts: target description, changed-file list, `git diff --shortstat`, the exact `git diff` command agy must run, "do not modify files", and the schema. Uses `buildPermissionSettings({})`, no `--mode`, `--json-schema <path to schema>`. If `structuredOutput` is null but the response parses as JSON matching the schema's required keys, use it; otherwise the state is `failed` ("review output did not match schema") and the raw text is shown.
- A prompt over 100 000 chars → error before spawning.

- [ ] **Step 1: Failing tests** (fake agy via `GEMINI_BRIDGE_AGY_BIN`, temp repo with one modified file): `setup --json` reports version `1.5.9` and 2 models; `setup` with missing bin gives `available: false` and the install command; `review --wait --json` with fixture `review-structured` → `ok`, verdict `needs-attention`, recorded args contain `--json-schema` and no `--mode`; `review on clean tree says nothing to review` (agy not spawned); `review without agy prints setup hint` (exit code 1, stdout mentions `/gemini:setup`); review with fixture `review-write-denied` → state `failed` and reason `permission denied`; `adversarial-review` passes the focus text into the prompt.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: gemini setup and review commands`.

### Task 7: Companion — tasks and job management

**Files:**
- Modify: `plugins/gemini/scripts/gemini-companion.mjs` (add `task`, `task-worker`, `task-resume-candidate`, `status`, `result`, `cancel`)
- Test: `tests/companion-task.test.mjs`

**Interfaces:**
- Produces: `task [--background] [--write|--read-only] [--auto] [--allow <prefix>]… [--resume-last] [--model <id>] [--effort <lvl>] [--timeout <s>] <prompt>`; `task-resume-candidate --json -> { available: boolean, jobId?, conversationId? }`.
- Mode mapping: `--write` (default for rescue) → `--mode accept-edits`; `--read-only` → no `--mode`; `--auto` → `--mode auto`, and if stderr contains `--mode auto is not available`, the result says so. `--allow` values go to `buildPermissionSettings({ extraAllow })`. `--resume-last` → `--conversation <conversationId of latest finished task job in this Claude session>`.
- Background: same detached worker pattern as CODEX `spawnDetachedTaskWorker` / `handleTaskWorker`; the worker stores `pid` of the agy child in the job record so `cancel` can kill it.

- [ ] **Step 1: Failing tests:** `task --json` with fixture `rescue-edit-ok` → completed, args contain `--mode accept-edits`; `--read-only` → no `--mode`; `--allow "npm test"` → settings contain `command(npm test)`; `--resume-last` after a completed `rescue-edit-ok` job passes `--conversation <that fixture's conversation_id>`; `task-resume-candidate` false on a fresh state; background task → `status` shows it running then completed, and `result` renders it; `cancel kills worker and agy child` (`FAKE_AGY_HANG=1`, cancel → state `cancelled`, both pids dead).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: gemini task delegation and job management`.

### Task 8: Commands, subagent, skills and hooks

**Files:**
- Create (adapted from CODEX equivalents, codex→gemini, Codex-specific advice removed): `plugins/gemini/commands/{setup,review,adversarial-review,rescue,status,result,cancel}.md`, `plugins/gemini/agents/gemini-rescue.md` (model `sonnet`, tools `Bash`, skills `agy-cli-runtime`, `gemini-prompting`), `plugins/gemini/skills/{agy-cli-runtime,gemini-result-handling,gemini-prompting}/SKILL.md`, `plugins/gemini/hooks/hooks.json`, `plugins/gemini/scripts/session-lifecycle-hook.mjs`, `plugins/gemini/scripts/stop-review-gate-hook.mjs`, `plugins/gemini/prompts/stop-review-gate.md`
- Test: `tests/commands.test.mjs`, `tests/stop-gate.test.mjs`

Specifics:
- `setup.md`: if agy is unavailable, ask once whether to run the official installer (`curl -fsSL https://antigravity.google/cli/install.sh | bash` on macOS/Linux, `irm https://antigravity.google/cli/install.ps1 | iex` on Windows), then tell the user to run `!agy` to sign in.
- `rescue.md` / agent: `--model` is passed through as an agy model id (`agy models`); write is the default unless the user asks for read-only; `--allow` is passed through.
- `gemini-prompting` skill: short guidance for writing prompts for Gemini models via agy (explicit task, files, verification command, "do not modify files" for read-only). No GPT-specific content.
- Stop gate: same flow as CODEX, but timeout `300 s` and model `config.gateModel ?? "gemini-3.8-flash-low"`; read-only task. **On agy failure or timeout: allow (no block), and write a note to stderr.** Block only on a `BLOCK:` first line.

- [ ] **Step 1: Failing tests:** every command file has frontmatter with `description`, and each `gemini-companion.mjs <sub>` it references exists in the companion's dispatcher; no file under `plugins/gemini` matches `/codex/i` except `NOTICE` lines; `hooks.json` Stop timeout ≥ 330; stop gate with config off emits nothing; gate with a synthetic fixture `tests/fixtures/agy/gate-block.*` (copy of `success` with response `"BLOCK: x\n"`) emits `{"decision":"block"}`; gate with `print-timeout` fixture emits no decision and a stderr note.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: slash commands, rescue subagent, skills and review gate`.

### Task 9: Docs, release tooling and real-world verification

**Files:**
- Create: `README.md`, `CHANGELOG.md` (`0.1.0`), `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `scripts/bump-version.mjs` (port `CODEXREPO/scripts/bump-version.mjs` + its test), `scripts/smoke.sh`

- [ ] **Step 1:** README sections: what it is, "Unofficial" notice, requirements (Node 18.18+, agy ≥ 1.5.0, a Google account), install (`claude plugin marketplace add isaay6/gemini-bridge-cc`, `claude plugin install gemini@isaay6`, `/gemini:setup`), commands table, permissions model (read-only allow-list, `--allow`, `--auto`, no skip-permissions), privacy (code goes to Google via agy), Google terms note, troubleshooting (symlinks, `auto` unavailable, timeouts), credits/licence.
- [ ] **Step 2:** `scripts/smoke.sh`: creates a temp repo **under `$HOME`** with a buggy file, then runs with real agy: `setup --json`, `review --wait --json`, `task --json "fix the bug"`, `task --resume-last --json "what did you change?"`; asserts `ok: true` on each and that the file changed. Run `npm test` → all PASS; run `scripts/smoke.sh` → all PASS.
- [ ] **Step 3: Local install check:** `claude plugin marketplace add "<repo path>"`, `claude plugin install gemini@isaay6`, then in a Claude Code session in a test repo run every `/gemini:*` command once. Record the outcome in `CHANGELOG.md` under "Verified".
- [ ] **Step 4: Commit** `docs: README, changelog and release tooling for 0.1.0`.

### Task 10: Private GitHub repository (needs the user's explicit go-ahead)

- [ ] **Step 1:** Ask the user for confirmation, then run `gh repo create isaay6/gemini-bridge-cc --private --source . --push`.
- [ ] **Step 2:** `git tag v0.1.0 && git push origin v0.1.0`; CI green on all 6 matrix jobs.
- [ ] **Step 3:** From a clean shell: `claude plugin marketplace add isaay6/gemini-bridge-cc` installs (private repos need the user's GitHub auth; note this in the README).
