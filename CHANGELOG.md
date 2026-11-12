# Changelog

All notable changes to this project are documented here.

## [0.2.1] - 2026-11-12

### Security

- Status messages no longer include prompt or MCP text; only tool names and file paths are copied.
- OSC output is restricted to `/dev/tty` or a file under the system temp directory; symlinks and FIFOs are refused and `O_NOFOLLOW` is used.
- State now lives in a user-owned 0700 directory with 0600 atomic writes, `O_NOFOLLOW`, and a per-session lock.
- Hook stdin is capped at 1 MiB; oversized input recovers only event, session and tool name.
- `HERDR_NOTIFY_TTY` and `HERDR_NOTIFY_DEBUG` writes are hardened; `notify.sh` validates the Node path and always exits 0.

### Fixed

- `/clear` now clears the TUI resume command instead of keeping the old session.
- Session state keys are hashed, removing collisions between similar session ids.
- `seq` is monotonic across parallel hooks.
- Unexpected exceptions can no longer produce a nonzero hook exit.

### Changed

- Status messages are terse: `working` replaces prompt text, `waiting for input` replaces MCP text.
- Plugin and marketplace versions are now 0.2.1.

## [0.2.0] - 2026-11-12

### Added

- CodeBuddy marketplace manifest (`.codebuddy-plugin/marketplace.json`), so the plugin installs with `/plugin marketplace add szkane/codebuddy-herdr` and `/plugin install herdr-notify@codebuddy-herdr`.
- TUI native resume: every `pane report-agent` call carries `--agent-session-id <id> -- codebuddy --resume <id>`.
- Optional Herdr Core template at `examples/herdr-core-templates/codebuddy.md` for `hc run codebuddy "task"`.

### Changed

- `StopFailure` now reports `blocked` with `turn failed` instead of OSC `error`, because the Herdr app only renders working/blocked/done/idle.
- Plugin and package versions are now 0.2.0.

## [0.1.0] - 2026-11-12

### Added

- Initial release: OSC 7501 state reporting for the Herdr app, `pane report-agent` for the Herdr TUI, blocked recovery, and monotonic sequence numbers.