# Turnweft

[中文说明](README.zh-CN.md)

Persistent agent sessions for Claude Code and Codex.

From Claude Code (CC) or Codex, delegate work to **Dim, Droid, Grok, OpenCode or agy**. The delegated agent reads, writes and runs commands in your real project directory, and you can keep following up in the same session. A permission you have confirmed once is not asked again.

> Status: `0.1.0-alpha`, macOS only. Design and decisions: [TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md](TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md). Test records: [docs/m0/M0_RESULTS.md](docs/m0/M0_RESULTS.md) (protocol probes) and [docs/e2e/E2E_RESULTS.md](docs/e2e/E2E_RESULTS.md) (end to end). These documents are written in Chinese.

## How it works

```
CC / Codex ──MCP──▶ turnweft mcp ──▶ shared state (~/.turnweft/state.sqlite)
                                          │
                                          ▼
                          one background worker per active session
                                          │
                 ┌──────────── ACP ───────┴────── native stream-json ─┐
                 ▼          ▼          ▼          ▼                    ▼
                Dim       Droid      Grok     OpenCode               agy
```

- **Sessions persist.** Each Turnweft session is bound to one native session ID. After an idle timeout the agent process is stopped; the next follow-up resumes the same native session. If it cannot be resumed you get an explicit error, never a silent new session.
- **Real directory.** Agents work directly in your project: no copies, no worktrees. Every result lists the files changed in that turn separately from changes that were already uncommitted.
- **Permissions.** Every open or resume sets the agent's native permission mode and reads it back. When that mode is broader than what you have granted, you confirm once per agent × project × intent (see [Confirming permissions](#confirming-permissions)). Every result states the actual mode.
- **No duplicate runs.** Callers send a `requestId`; a retry returns the original job. A job that was delivered and then lost contact is marked `in_doubt` and is never resent automatically.

## Install

Requires macOS, Node.js ≥ 22.13, and the CLIs of the agents you want to use, each already signed in.

```bash
npm install -g turnweft
turnweft doctor     # checks which agents are available; starts no model task
```

Turnweft looks for each agent CLI on PATH first, then in common install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, plus `~/.opencode/bin` and the `dim` bundled in DimAgent.app), so it also works when a host started from the Dock has a short PATH. Other locations can be set under `executables` in `~/.turnweft/config.json`.

### Claude Code

```bash
claude plugin marketplace add handong66/turnweft
claude plugin install turnweft@turnweft
```

### Codex

```bash
codex plugin marketplace add handong66/turnweft
codex plugin add turnweft@turnweft
```

Restart Codex afterwards; new conversations load the plugin.

Both plugins contain only an MCP registration, a skill and a launcher. The runtime always comes from the `turnweft` command. If it is missing or too old, the plugin offers a single `turnweft_setup` tool that explains how to install it.

## Confirming permissions

When the agent's mode is broader than your grant, the job is recorded as `waiting_confirmation` and nothing runs yet:

1. Turnweft first asks the host to show its own confirmation prompt. In testing, Claude Code 2.1.286 and the Codex 0.160.0 desktop app both declined it automatically without showing it.
2. Turnweft then shows a macOS dialog naming the agent, project, mode and what it allows beyond your grant. The dialog waits for your choice; no answer never counts as a denial.
3. **Allow** starts the waiting job without resubmitting. **Deny** cancels it (`confirmation_denied`). A proposal expires after 24 hours (`confirmation_expired`).
4. `turnweft send` on the command line shows the same dialog. You can also run `turnweft policy grant <proposalId>` in a terminal and type `yes` or `no`. It refuses non-terminal input and has no auto-approve flag, but it cannot tell who is typing: run it yourself rather than letting an agent with a terminal tool run it.

**Bypass conversations are not asked.** When the host conversation runs in its bypass mode, Turnweft authorizes the job directly: no proposal, no dialog. It reads only what the host itself records: in Claude Code, the latest `permissionMode` in the conversation transcript must be `bypassPermissions` (auto mode and every other mode still show the dialog); in Codex, the turn metadata must say `sandbox_mode: danger-full-access` (full access). This applies to that one job and is not remembered, so the same project in a non-bypass conversation still asks. Results state the actual mode and `authorizedBy`. Nothing the model passes can turn this on.

Confirmations are stored per agent × project × intent and are not asked again while they stay valid; a new agent version or a change in what the mode allows asks again. List them with `turnweft policy list`; revoke one with `turnweft policy revoke <id>`.

Text shown to people (dialog, CLI output, proposals) is in English or Chinese. To pick one, set `"language": "zh"` or `"en"` in `~/.turnweft/config.json`; this also works for hosts started from the Dock, which do not see shell variables. Otherwise Turnweft follows `TURNWEFT_LANG`, then `LC_ALL`, `LC_MESSAGES` and `LANG`, then the macOS primary language, and defaults to English. (`TURNWEFT_LANG` overrides the config file.) Model-facing tool descriptions and warnings remain English. Existing stored confirmations retain their original text.

## Command line

```bash
turnweft session create --agent droid --cwd .        # returns a tws_… session ID
echo "Fix the bug in src/math.js and run the tests" | turnweft send --session tws_… --intent implement
turnweft job wait twj_… --include-result
turnweft cancel twj_…
turnweft policy list
turnweft session close tws_…
```

## Agents (tested on macOS)

| Agent | Transport | Native mode for implement | Writes | Follow-up | Resume after stop | Cancel |
| --- | --- | --- | --- | --- | --- | --- |
| Dim 0.5.16 | ACP | `permission=workspace-write`; command requests answered by Turnweft | ✅ | ✅ | ✅ | ✅ |
| Droid 0.233.0 | ACP | `autonomy_level=normal`; each edit and command request answered by Turnweft | ✅ | ✅ | ✅ | ✅ |
| Grok 1.0.46 | ACP (`agent --no-leader stdio`) | follows your `~/.grok/config.toml` (confirm once if it is broader than your grant) | ✅ | ✅ | ✅ | ✅ |
| agy 1.2.16 | native long-lived stream-json | skip permissions + accept-edits (confirm once) | ✅ | ✅ | ✅ | ✅ |
| OpenCode 1.18.34 | ACP | `mode=build`, following OpenCode's own permission config (confirm once) | ✅ | ✅ | ✅ | ✅ |

## Known limitations

- macOS only, including the confirmation dialog.
- Stopping relies on process groups: child processes that leave their group (for example with `setsid`) are not tracked.
- Grok's actual permission mode cannot be read back; Turnweft infers it from `~/.grok/config.toml`. OpenCode's effective permission rules cannot be read back either. Results say so.
- OpenCode's ACP does not report provider errors (such as an exhausted quota); Turnweft detects them only through an inactivity timeout.
- Setting a Dim model explicitly changes that workspace's default model persistently; results mention it.
- No model is chosen by Turnweft: each agent uses its own default unless you pass one.

## Development

```bash
git clone https://github.com/handong66/turnweft.git
cd turnweft
npm install
npm run build
npm link            # provides the turnweft command from this checkout
npm test            # core and host-layer tests with simulated agents; no model quota used
node scripts/live-smoke.mjs droid --model <model>   # real agent end to end (uses quota)
```

## License

[MIT](LICENSE)
