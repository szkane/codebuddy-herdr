# AGENTS.md

Instructions for coding agents working in this repository. Read this before changing code.

## Project

`codebuddy-herdr` publishes `herdr-notify`, a CodeBuddy Code plugin that makes CodeBuddy a first-class agent in Herdr.

- Repo root: CodeBuddy marketplace (`.codebuddy-plugin/marketplace.json`)
- `herdr-notify/`: the plugin
- `test/`: node:test suite
- `examples/`: Herdr app `programs.json` and Herdr Core template
- User docs: `README.md`, `README.zh-CN.md`
- Release history: `CHANGELOG.md`

The version of record is `herdr-notify/.codebuddy-plugin/plugin.json`.

## Architecture

Hooks -> `herdr-notify/index.js` -> state mapping -> one of two transports:

1. **Herdr app / herdr-core (`hc`)**: OSC 7501 to `/dev/tty`. Over SSH the bytes reach the Mac app. Root record only.
2. **Herdr TUI (`herdr`)**: `pane report-agent`; selected when `HERDR_ENV=1` and `HERDR_BIN_PATH` is not `hc`.

`scripts/notify.sh` locates Node and execs `index.js`. `index.js` has no dependencies and no build step.

Per-session state lives in `$XDG_RUNTIME_DIR/herdr-notify` or `$TMPDIR/herdr-notify-<uid>` (hashed key, monotonic seq + last state).

## Invariants (do not break)

- Hooks exit 0 always. Delivery failures are written to the debug log; never block a turn.
- OSC goes to `/dev/tty` (or `HERDR_NOTIFY_TTY`), never stdout. CodeBuddy captures hook stdout.
- Use the root OSC record. Do **not** add `id=`; herdr-core does not surface child records as the pane agent.
- Do not map `PermissionRequest` to blocked. It fires for auto-approved tools. Use:
  - `Notification(permission_prompt)` for approval dialogs
  - `AskUserQuestion` / `ExitPlanMode` via `PreToolUse`
  - `Elicitation` for MCP input
- `StopFailure` maps to `blocked`, not OSC `error`. The app only renders working/blocked/done/idle.
- `done`/`error` records survive; a late `idle_prompt` may reset only a previous `working`.
- `seq` must strictly increase per session. Use a per-session lock and `Math.max(Date.now(), previous+1)`; do not rely on a bare timestamp.
- TUI resume only on `report-agent`: `--agent-session-id <id> -- codebuddy --resume <id>`. Omit for unsafe ids and for `release-agent`.
- Status messages must not contain prompt text, MCP text, shell commands, URLs, or secrets. Use tool name + file path.
- OSC output is limited to `/dev/tty` or a file under the system temp directory. Refuse symlinks and FIFOs; open with `O_NOFOLLOW`.
- State must be written to a user-owned 0700 directory, with 0600 atomic writes and a per-session lock.
- Hook stdin is capped at 1 MiB; oversized input may only recover event, session and tool name.
- No daemon, no network calls, no runtime dependencies.

## Testing

Run before every commit:

```bash
node --test
codebuddy plugin validate .
codebuddy plugin validate ./herdr-notify
```

Test rules:

- Every behavior change needs a case in `test/notify.test.js`.
- Tests must set `TMPDIR`, `HERDR_NOTIFY_TTY` and `HERDR_NOTIFY_DEBUG` to a temp dir, and clear `HERDR_ENV` / `HERDR_BIN_PATH` / `HERDR_PANE_ID`.
- Mock `herdr` / `hc` with small shell scripts; never require a real Herdr for tests.
- `--dry-run` prints a JSON envelope containing the OSC payload and must not deliver or write state.
- Security regressions must stay covered: symlinked tty, FIFO tty, symlinked state dir, oversized input, and parallel hooks with unique seq.

Marketplace smoke test (isolated, does not touch the real config):

```bash
tmp=$(mktemp -d)
CODEBUDDY_CONFIG_DIR="$tmp" codebuddy plugin marketplace add "$PWD"
CODEBUDDY_CONFIG_DIR="$tmp" codebuddy plugin install herdr-notify@codebuddy-herdr --scope user
CODEBUDDY_CONFIG_DIR="$tmp" codebuddy plugin list | grep herdr
```

Manual approval regression (requires Herdr core, a model call, and an interactive pane):

1. Start `codebuddy --permission-mode default` in a Herdr pane.
2. Ask it to use `Write` to create a temp file.
3. `hc get <pane> | jq .status` must show `blocked` / `kind=permission`.
4. Kill the pane. Never leave the test process running.

## Release checklist

1. Bump the version in:
   - `herdr-notify/.codebuddy-plugin/plugin.json`
   - `herdr-notify/package.json`
   - `.codebuddy-plugin/marketplace.json` (marketplace and plugin entry)
   - `CHANGELOG.md`
2. Update `README.md` and `README.zh-CN.md` together (install, mapping, limitations, layout).
3. Run tests and both validations.
4. Commit in logical commits.
5. Do not push or force-push unless the user explicitly asks. If push is denied, report it; do not switch remotes or bypass permissions.

## Environment and compatibility

- Verified with CodeBuddy 2.183.0 and herdr-core 0.1.20.
- Node.js 18+ is required where hooks run.
- `hc` is the app core binary; it has no `pane report-agent` in 0.1.x. Use OSC for the app.
- `herdr` is the TUI binary; use `pane report-agent`.
- The Herdr app's stock UI only renders `status`, `app`/`program`, and the terminal title. It ignores `msg`, `progress`, `tokens` and custom labels. Do not add complexity for those unless a custom mod is explicitly requested.

## Known upstream gaps (document, do not fake)

- **App-side native resume**: `hc` 0.1.x has no public session-reporting API.
- **Built-in "Start an agent" entry**: add `codebuddy` to `defaults/programs.json` upstream; local `programs.json` works today.
- **`herdr agent start --kind codebuddy`**: the core kind list is fixed; needs an upstream kind + detection manifest.

## Working agreements

- Keep changes small and explicit; no new abstractions for one-off cases.
- Preserve the no-dependency, no-build design of `index.js`.
- Comments explain why, not what.
- Do not edit installed plugin caches under `~/.codebuddy/plugins/cache/`; use `--plugin-dir` or reinstall.
- Do not commit machine paths, logs, temp files, or secrets.
- When changing state mapping, update the test matrix and both README tables.
- The marketplace manifest and the plugin manifest are separate; do not put `plugin.json` at the repo root.
- The app menu entry lives on the user's Mac (`~/.config/herdr-app/programs.json`); the repo only ships an example.

A change is done when tests pass, both manifests validate, the READMEs are in sync, and the behavior appears in the mapping table.
