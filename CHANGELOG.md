# Changelog

All notable changes to this project are documented here.

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
