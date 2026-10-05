# Turnweft

[中文说明](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/turnweft)](https://www.npmjs.com/package/turnweft) [![license](https://img.shields.io/npm/l/turnweft)](LICENSE)

**Let Claude Code and Codex hand work to your other coding agents, in your real project, and keep the conversation going.**

You talk to Claude Code or Codex as usual. When you want a second opinion, a parallel pair of hands, or simply another model, say so: "ask Grok to review this", "have Droid fix the failing tests". Turnweft starts that agent in the same project folder. The agent reads and changes the real files, and the result comes back to your conversation. Ask a follow-up tomorrow and you reach the same agent session, which still remembers the earlier work.

Supported agents: **Dim, Droid, Grok, OpenCode and agy**.

> Status: `0.1.0-alpha`, macOS only. It works end to end with all five agents in both Claude Code and Codex, but expect rough edges. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

---

## Why Turnweft

If you use more than one coding agent, you probably know the routine:

- You copy code and context from one tool into another, then copy the answer back.
- The second agent works on a copy or in a separate folder, so its changes have to be moved over by hand.
- Coming back later means starting a new chat and explaining everything again.
- Each agent has its own plugin, and each plugin behaves a little differently.

Turnweft replaces that with one way of working. You stay in the assistant you already use, the other agent works where your code actually lives, and every session can be picked up again.

## What it looks like

These conversations are illustrative; real wording depends on the agents and models you use.

### A second opinion, without leaving your chat

> **You** (in Claude Code): Ask Grok to review the login changes I just made. Don't change anything.
>
> **Claude**: Grok looked at `src/auth/session.ts` and `src/auth/login.ts` and flags two issues. The session token is compared with `==` instead of a constant-time check. A failed login doesn't reset the attempt counter. Want me to have Grok fix them, or should I?

Grok read the real files in your project. Because you asked for a review, it changed nothing.

### Hand off a fix while you keep working

> **You**: Have Droid fix the failing tests in `test/math.test.js`, then tell me what it changed.
>
> **Claude**: Droid fixed both bugs. Changed in this turn: `src/math.js`. Your own uncommitted edit to `NOTES.md` was already there and was left alone. I ran the tests myself: 2 passed, 0 failed.

Turnweft compares git snapshots taken before and after the turn, so it can list files that changed during the turn separately from changes you already had. It can't tell who made a change: if you edit the same folder while an agent works, your edits show up too. The plugin also tells Claude to run the tests itself rather than take the agent's word for it.

### Pick up where you left off

> **You** (the next morning): Ask the same Droid session why it changed the rounding.
>
> **Claude**: Droid says the old code used `Math.floor`, which rounds negative numbers the wrong way for this function, so it switched to `Math.trunc`…

Each Turnweft session is tied to the agent's own session. When an idle agent is stopped to save resources, the next question resumes that exact session. It never starts a fresh one that has forgotten everything.

### Permissions: asked once, or not at all

The first time an agent needs more than reading in a project, such as editing files and running commands, a macOS dialog asks you. It names the agent, the project and exactly what the agent will be allowed to do. You click **Allow** once for that agent, project and kind of task, and the waiting task starts by itself. If your Claude Code conversation runs in **bypass permissions** mode, or your Codex thread has **full access**, Turnweft takes that as your answer and doesn't ask.

## A typical journey

1. **Install once.** Run `npm install -g turnweft`, then add the plugin to Claude Code and/or Codex (see [Quick start](#quick-start)).
2. **Ask in plain language.** For example: "Ask OpenCode how this module is structured" or "Have agy implement the CSV export". There are no new commands to learn.
3. **Confirm once if asked.** A dialog may appear the first time an agent edits files in a project. It waits for you, and silence never counts as "no".
4. **Check the result.** You see the agent's answer, the files that changed during the turn, and the permission mode it actually ran with. The plugin tells Claude or Codex to verify the work, for example by running the tests, before calling it done. An agent saying "done" is a claim, not proof.
5. **Follow up anytime.** Ask the same agent again, minutes or days later, and it remembers the earlier work.
6. **Stay in control.** You can cancel a running task, list or revoke past permissions, and see exactly what each agent was allowed to do.

## Who it's for

- People who already use Claude Code or Codex and also have accounts with other coding agents.
- People who want a second model to review or double-check work without copy-pasting.
- People who want to spread work across agents, quotas or models while one conversation stays in charge.

## Quick start

**Requirements:**

- macOS
- Node.js 22.13 or later
- The command-line tool of each agent you want to use (`dim`, `droid`, `grok`, `opencode`, `agy`), already signed in

```bash
npm install -g turnweft
turnweft doctor        # shows which agents were found; starts no model task
```

**Claude Code:**

```bash
claude plugin marketplace add handong66/turnweft
claude plugin install turnweft@turnweft
```

**Codex:**

```bash
codex plugin marketplace add handong66/turnweft
codex plugin add turnweft@turnweft
```

Start a **new** conversation afterwards so it loads the plugin; for Codex, restart the app first. Then try:

```
Ask Droid to explain what this project does, in five bullet points.
```

## Things you can ask

- "Ask Grok to review my last commit for security problems. Read only."
- "Have Droid fix the failing test in `test/api.test.ts` and run the tests."
- "Ask OpenCode to compare our two caching approaches and recommend one."
- "Have agy add a `--json` flag to the export command."
- "Continue with the same Dim session: why did you choose that library?"
- "Cancel the Droid task."

You can name a model if you want one ("use Droid with glm-5.3-flash"). Otherwise each agent uses its own default.

## Permissions and safety

- **Read-only when you ask for analysis.** Reviews and questions run in each agent's read-only or ask-first mode wherever the agent has one. Grok is the exception: Turnweft can't verify Grok's actual permission mode, so Grok tasks need one confirmation even for analysis. If your Grok config auto-approves everything, Grok can't be held read-only at all, and the confirmation says so.
- **Broader modes are confirmed once.** Some agents can only edit in a mode that goes beyond what you granted. For example, the agent approves commands automatically, or it skips its own permission checks. Then a macOS dialog asks you once per agent × project × kind of task. If the agent's version changes, or the mode starts allowing more, you are asked again.
- **Bypass conversations aren't asked.** In Claude Code, only `bypassPermissions` counts; auto mode and every other mode still show the dialog. In Codex, only full access (`danger-full-access`) counts. Turnweft learns the mode from Claude Code or Codex itself, never from what the model says. This kind of approval covers one task and is not remembered.
- **Every result tells the truth about permissions.** It states the mode the agent actually ran with, what that mode allows beyond your grant, and what authorized it.
- **Nothing runs twice by accident.** If the connection to the agent drops after a task was handed over, the task is marked `in_doubt` for you to check. It is never resent automatically. Closing Claude Code or Codex doesn't stop a running task: it keeps going in the background, and you can check on it later.
- **Local only.** Turnweft keeps its state in `~/.turnweft` and makes no network requests of its own. The agents themselves talk to their providers as usual.

What Turnweft can't do:

- It can't hold an agent tighter than that agent's own permission modes allow.
- It can't stop another program running under your account from editing Turnweft's local files.

## Supported agents

Tested on macOS with these versions:

| Agent | How Turnweft talks to it | Mode used for code changes | Edits files | Follow-ups | Resume after idle | Cancel |
| --- | --- | --- | --- | --- | --- | --- |
| Dim 0.5.16 | ACP | `workspace-write`; command requests answered by Turnweft | ✅ | ✅ | ✅ | ✅ |
| Droid 0.233.0 | ACP | `autonomy_level=normal`; each edit and command request answered by Turnweft | ✅ | ✅ | ✅ | ✅ |
| Grok 1.0.46 | ACP (`agent --no-leader stdio`) | follows your `~/.grok/config.toml` | ✅ | ✅ | ✅ | ✅ |
| OpenCode 1.18.34 | ACP | `build` mode, following OpenCode's own permission config | ✅ | ✅ | ✅ | ✅ |
| agy 1.2.16 | native long-lived stream-json | skip permissions + accept edits | ✅ | ✅ | ✅ | ✅ |

## How it works

```
Claude Code / Codex ──MCP──▶ turnweft mcp ──▶ shared state (~/.turnweft/state.sqlite)
                                                   │
                                                   ▼
                                   one background worker per active session
                                                   │
                  ┌──────────── ACP ───────────────┴──── native stream-json ──┐
                  ▼          ▼          ▼          ▼                            ▼
                 Dim       Droid      Grok     OpenCode                       agy
```

- **One runtime, two thin plugins.** The npm package is the only runtime. Each plugin contains an MCP registration, a skill that teaches the assistant how to use Turnweft, and a small launcher. The Claude Code plugin also has a hook that reports the conversation's permission mode. If the runtime is missing, the plugin offers a single setup tool that explains how to install it.
- **Sessions and jobs.** A session binds to one native agent session. Each request is a background job. The caller supplies a `requestId`, so a retry returns the original job. Jobs in a session run in order, and writes to the same project run one at a time, even across sessions.
- **Native permissions, read back where possible.** Whenever an agent session is opened or resumed, Turnweft sets the agent's own permission mode and, for agents that report it, reads it back. If the agent reports something else, the task doesn't run. Grok's mode comes from its config file and can't be read back; for OpenCode, only the mode is checked, not its full permission rules.
- **Idle and resume.** Idle agents are stopped after 10 minutes. The next request resumes them through their native session ID. If resuming fails, you get an error instead of a silent fresh start.
- **Two hosts, one store.** Claude Code and Codex share the same state. To continue a session from the other host, attach it explicitly.

The full design and every decision are in [TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md](TURNWEFT_DESIGN_AND_DEVELOPMENT_PLAN.md). Test records: [docs/m0/M0_RESULTS.md](docs/m0/M0_RESULTS.md) (protocol probes) and [docs/e2e/E2E_RESULTS.md](docs/e2e/E2E_RESULTS.md) (end to end). These documents are in Chinese.

## Confirming permissions in detail

When an agent's mode goes beyond your grant, the job is recorded as `waiting_confirmation` and nothing runs yet:

1. Turnweft first asks the host to show its own confirmation prompt. In testing, Claude Code 2.1.286 and the Codex 0.160.0 desktop app both declined it automatically without showing it.
2. Turnweft then shows a macOS dialog. It names the agent, the project, the mode and what that mode allows beyond your grant. The dialog waits for your choice; no answer never counts as a denial.
3. **Allow** starts the waiting job without resubmitting. **Deny** cancels it (`confirmation_denied`). A proposal expires after 24 hours (`confirmation_expired`).
4. `turnweft send` on the command line shows the same dialog. You can also run `turnweft policy grant <proposalId>` in a terminal and type `yes` or `no`. It refuses non-terminal input and has no auto-approve flag, but it can't tell who is typing. Run it yourself; don't let an agent with a terminal tool run it for you.

**Bypass conversations.** Turnweft trusts only a signal the host produces for that very call:

- **Claude Code:** right before each `turnweft_ask` or `turnweft_delegate` call, the plugin's PreToolUse hook receives the conversation's current permission mode. The hook records the mode for that exact call (tool and task arguments). The record is valid for 15 seconds and used once. Only `bypassPermissions` counts.
- **Codex:** the call's turn metadata must say `sandbox_mode: danger-full-access`.

The approval covers one job, at the permissions it had when you submitted it. The `turnweft` command line never takes a bypass signal. A conversation that was open before you installed or updated the plugin keeps the old version until you start a new one.

Confirmations are stored per agent × project × kind of task. List them with `turnweft policy list`, and revoke one with `turnweft policy revoke <id>`.

## Configuration

Optional settings live in `~/.turnweft/config.json`:

```json
{
  "language": "en",
  "executables": { "droid": "/custom/path/droid" },
  "idleReleaseMs": 600000,
  "inactivityTimeoutMs": 600000
}
```

- **`language`** picks the language of text shown to people, such as dialogs, CLI output and confirmation messages: `"en"` or `"zh"`.
  - Order of precedence: the `TURNWEFT_LANG` environment variable, then this setting, then `LC_ALL`, `LC_MESSAGES` and `LANG`, then the macOS primary language, and finally English.
  - Hosts started from the Dock don't see shell variables, so this setting is the reliable way to choose.
  - Tool descriptions and workflow hints written for the model are always in English.
- **`executables`** gives explicit paths to agent CLIs. Without it, Turnweft looks on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. It also checks `~/.opencode/bin` for OpenCode and the copy of `dim` bundled in DimAgent.app.
- **`idleReleaseMs`** is how long an idle agent is kept running before it is stopped. The default is 10 minutes.
- **`inactivityTimeoutMs`** is how long a turn may go without any activity from the agent before it is cancelled. The default is 10 minutes.

## Command line

The plugins cover normal use. The CLI is useful for scripting and inspection:

```bash
turnweft session create --agent droid --cwd .        # returns a tws_… session ID
echo "Fix the bug in src/math.js and run the tests" | turnweft send --session tws_… --intent implement
turnweft job wait twj_… --include-result
turnweft cancel twj_…
turnweft policy list
turnweft session close tws_…
```

## Troubleshooting

- **An agent shows as unavailable.** Run `turnweft doctor`. It checks that each CLI is installed and reports its version, but it doesn't check whether you are signed in. A signed-out agent fails when a task runs; the error code depends on the agent and the stage at which it fails. If the CLI lives somewhere unusual, set its path under `executables`.
- **A dialog appeared in a bypass conversation.** Bypass approval needs runtime 0.1.0-alpha.2 or later (`npm install -g turnweft@latest`). Otherwise, either that conversation started before the plugin was installed or updated, or the assistant used the `turnweft` command line instead of the plugin tools. Start a new conversation.
- **The assistant says Turnweft isn't installed.** The plugin found no runtime. Run `npm install -g turnweft`, then start a new conversation.
- **Logs** are in `~/.turnweft/logs/`:
  - `mcp.log`: confirmation channels
  - `dialog.log`: dialogs
  - `worker-*.log`: one file per session

## Known limitations

- macOS only, including the confirmation dialog.
- Stopping an agent relies on process groups. Child processes that leave their group (for example with `setsid`) are not tracked.
- Grok's actual permission mode can't be read back; Turnweft infers it from `~/.grok/config.toml`. OpenCode's effective permission rules can't be read back either. Results say so.
- OpenCode's ACP doesn't report provider errors such as an exhausted quota, so Turnweft only detects them through the inactivity timeout.
- Setting a Dim model explicitly changes that workspace's default model for good. Results mention it.
- Claude Code and Codex are hosts, not targets: Turnweft doesn't delegate work to them.

## Uninstall

Cancel or close any running sessions first (`turnweft session list`, then `turnweft session close <id> --policy cancel_running`); uninstalling doesn't stop tasks that are already running.

```bash
claude plugin uninstall turnweft@turnweft
codex plugin remove turnweft@turnweft
npm uninstall -g turnweft
```

Turnweft's sessions, confirmations and logs stay in `~/.turnweft` until you delete that folder.

## Development

```bash
git clone https://github.com/handong66/turnweft.git
cd turnweft
npm install         # also enables the repository's git hooks (unless core.hooksPath is already set; skipped in CI)
npm run build
npm link            # the turnweft command now runs this checkout
npm test            # core and host-layer tests with simulated agents; no model quota used
node scripts/live-smoke.mjs droid --model <model>   # real agent end to end (uses quota)
```

Every change that affects users updates the docs and adds an entry to [CHANGELOG.md](CHANGELOG.md). The git hooks check this on every commit and merge, and scan the staged content for private data. Publishing requires a changelog section for the version and scans the final package automatically. Change versions only with `npm version <v>`; it keeps the plugin manifests in sync.

## License

[MIT](LICENSE)
