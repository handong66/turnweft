# Changelog

All notable changes to Turnweft are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Every change that affects users adds an entry under **Unreleased**. `npm version <v>` turns that section into the new version; publishing fails without a section for the version being published.

## [Unreleased]

### Fixed

- Probe dead project-lock owners outside SQLite write transactions, then fence reclamation against holder and lease changes (U24).

### Changed

- A fresh trusted host bypass retry can authorize its matching undelivered waiting job with the current capability digest, without confirming a shared proposal or reviving finished jobs.
- Unattended hosts mark unauthorized tasks blocked, continue independent work, and report at the end; skills forbid intent downgrades, CLI fallback and agent edits to user config. `permissionTimeoutMs` remains reserved, not an implemented pending-action timer.
- `turnweft doctor` reports every ignored `parallelWrites` entry and its reason.

### Added
- Unattended confirmation mode (U25): user `confirmationMode: "fail-fast"`, MCP `nonInteractive: true`, and CLI `send --non-interactive` return a structured `needs_confirmation` proposal and terminal grant command without a dialog, waiting job, or queue entry. The default remains `wait`; false/absent call flags defer to user config.
- User-only `providerEnv` supplies provider variables to probes and new processes in MCP, CLI and workers, with configured values redacted from persisted results/events and output.
- Terminal pre-authorization: `policy grant --provider <id> --root <dir> --intent <intent> --until <ISO or HH:MM>` requires a TTY and manual yes. Expiry is checked at submit and before execution; already running jobs continue. Policy lists label expired grants.
- User-only `parallelWrites` in `~/.turnweft/config.json` opts exact project roots into concurrent implement jobs. Default writes remain serialized; separate git worktrees are recommended for parallel writers. Shared/exclusive holds preserve exclusion across config changes and retain crash/frozen-provider recovery. Existing SQLite locks migrate as exclusive holders.
- Overlapping write jobs report peer IDs in `concurrentWrites` and localized MCP/CLI warnings about overwritten changes and mixed-agent commits.

## [0.1.0-alpha.3] - 2026-10-05

### Added
- Sessions can set a thinking level: `effort` on `turnweft_session create`, `--effort` on `turnweft session create`. The value is the agent's own (Dim `thought_level`, Droid and Grok `reasoning_effort`, OpenCode `effort`, agy `--effort`) and is re-applied after the model whenever the session is opened or resumed. Before, every agent ran at its default; Dim implementation sessions were always `auto`.
- Results and the `config.readback` event report `effort` (requested and effective). `turnweft_agents` lists `effortConfig` among each agent's capabilities.
- The thinking level can be changed mid-conversation: `turnweft_session` action `update`, or `turnweft session update <id> --effort <level>`. It applies from the next turn, in the same agent session, so the context is kept. Dim, Droid, Grok and OpenCode change it inside the running session; agy, which only takes it at launch, is restarted on the same conversation.
- `scripts/live-smoke.mjs` accepts `--effort`.

### Changed
- A thinking level the agent doesn't offer with the current model fails the turn with `invalid_effort` before the prompt is sent. The error lists the offered values. Turnweft never runs a turn at a different level: Droid silently ignores unknown values, and OpenCode resets the level when the model changes, so the level is set last, always sent even when it already looks right, and only a fresh answer from the agent counts as the read-back. If the level drifts between turns, Turnweft sets it again in the running session before the next turn. A rejected level fails only that turn; the session stays usable. When the agent doesn't confirm a change in time, the level counts as unknown: Turnweft closes that process and the next turn resumes the same session and sets the level again. The level is read in the same transaction that starts a turn, so an update applies to every turn that hasn't started yet and never to one already started.
- The plugins now require runtime 0.1.0-alpha.3 or later, because their skills use `effort` and the `update` action (`npm install -g turnweft@latest`).
- `turnweft_session create` and `turnweft session create` reject an empty `model` or `effort`. Before, an empty model was dropped silently and the agent used its default.

## [0.1.0-alpha.2] - 2026-10-05

### Added
- Conversations running in the host's bypass mode are no longer asked to confirm. This means Claude Code's `bypassPermissions` mode, reported by the plugin's new PreToolUse hook for each call, or Codex full access (`sandbox_mode: danger-full-access`). Claude Code's auto mode and every other mode still show the dialog. The approval covers one job, at the permissions it had when submitted, and is not remembered.
- `turnweft send` on the command line shows the macOS confirmation dialog, like the plugins do. Before, it only printed the terminal command.
- `CHANGELOG.md`, and git hooks (pre-commit and pre-merge-commit) that require a new changelog entry for user-facing changes and scan the staged content for private data. `npm install` enables them unless you already set `core.hooksPath` (skipped in CI).
- Publishing checks that the version has a changelog section and scans the final npm package for private data.

### Changed
- The README is rewritten for people who don't know the project yet: what it is for, how a typical session goes, safety, configuration and troubleshooting. English and Chinese versions.
- The plugin skills tell the assistant to use the Turnweft tools rather than the command line, which never takes the bypass shortcut.
- The plugins now require runtime 0.1.0-alpha.2 or later, so bypass approval works after upgrading (`npm install -g turnweft@latest`).
- The README states the limits plainly: changed files come from git snapshots, the assistant's verification is a skill instruction, `doctor` doesn't check sign-in, and Grok tasks need one confirmation even for analysis.

### Security
- The bypass signal was reviewed over three rounds of cross-review. It can't be set through tool arguments or through the command line's environment, and the hook overwrites any planted record before each call. Each record is bound to one call (tool + task arguments), is valid for 15 seconds and is used once. A program that can write to `~/.turnweft` at the same moment as the call is outside this protection.

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

[Unreleased]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.2...v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/handong66/turnweft/compare/v0.1.0-alpha.0...v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/handong66/turnweft/releases/tag/v0.1.0-alpha.0
