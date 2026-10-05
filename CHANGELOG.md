# Changelog

All notable changes to Turnweft are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Every change that affects users adds an entry under **Unreleased**. `npm version <v>` turns that section into the new version; publishing fails without a section for the version being published.

## [Unreleased]

## [0.1.0-alpha.2] - 2026-10-05

### Added
- Conversations running in the host's bypass mode are no longer asked to confirm. This means Claude Code's `bypassPermissions` mode, reported by the plugin's new PreToolUse hook for each call, or Codex full access (`sandbox_mode: danger-full-access`). Claude Code's auto mode and every other mode still show the dialog. The approval covers one job, at the permissions it had when submitted, and is not remembered.
- `turnweft send` on the command line shows the macOS confirmation dialog, like the plugins do. Before, it only printed the terminal command.
- `CHANGELOG.md`, a pre-commit hook that requires a changelog entry for user-facing changes and runs the privacy scan, and a publish check for the version's changelog section.

### Changed
- The README is rewritten for people who don't know the project yet: what it is for, how a typical session goes, safety, configuration and troubleshooting. English and Chinese versions.
- The plugin skills tell the assistant to use the Turnweft tools rather than the command line, which always asks for confirmation.

### Security
- The bypass signal was reviewed over three rounds of cross-review. It can't be set by the model, by tool arguments or through the command line's environment. Each record is bound to one call (tool + task arguments), is valid for 15 seconds and is used once.

## [0.1.0-alpha.1] - 2026-10-05

### Fixed
- Text an agent writes before and after a tool call is no longer glued together in the final result; a blank line now separates them.

### Changed
- Version numbers are no longer edited by hand: the MCP server reads `package.json`, `npm version` updates the plugin manifests, and publishing refuses mismatched versions.

## [0.1.0-alpha.0] - 2026-10-04

### Added
- First public release (macOS). Claude Code and Codex can delegate to Dim, Droid, Grok, OpenCode and agy in the real project directory, through persistent sessions that resume after idle.
- One confirmation per agent × project × kind of task when an agent's mode goes beyond your grant, shown as a macOS dialog that waits for your answer.
- Background jobs with idempotent `requestId`, in-order execution per session, one writer per project, and `in_doubt` instead of automatic resends.
- English and Chinese text for people (dialogs, CLI), selectable with `"language"` in `~/.turnweft/config.json`.

[Unreleased]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/handong66/turnweft/releases/tag/v0.1.0-alpha.0
