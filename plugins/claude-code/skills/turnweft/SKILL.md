---
name: turnweft
description: Delegate a task to another coding agent (Dim, Droid, Grok, OpenCode, agy) through Turnweft, keep talking to the same agent session, and verify what it did. Use when the user asks to have one of these agents analyze, fix, implement or review something, or to continue work with an agent session started earlier.
---

For **long-running or unattended work**, pass `nonInteractive: true` on every `turnweft_ask` / `turnweft_delegate` call. This means do not wait; it never grants permission to run. User config `confirmationMode: "fail-fast"` also enforces this; false/absent call flags defer to config. If the result is `needs_confirmation`, **mark that task blocked, continue other independent work, and report blocked tasks with the returned `grantCommand` at the end**. Do not poll a nonexistent job, downgrade implement to analyze, or resubmit through the CLI. The waiting instructions below apply only to wait-mode submissions.

**Never shell out to the Turnweft CLI as a fallback**, including `export ...; turnweft send`: the CLI cannot see the host's per-call permission mode and may wait for confirmation. If agy or another provider needs an API key/base URL or other variables, tell the user to set `providerEnv: { "agy": { "VARIABLE_NAME": "value" } }` in `~/.turnweft/config.json`. Only the user may edit this file; **the agent must never edit it**, grant policy itself, or pass environment values via tool arguments/project files. New provider processes and probes read this config; already running provider processes keep their launch environment.

The user may pre-authorize a single project in their own terminal with `turnweft policy grant --provider <id> --root <dir> --intent implement --until <ISO time or HH:MM>`, review tier/excess and type yes. Queued tasks cannot start after expiry; running tasks continue. A same-request retry with a fresh host-supplied bypass can release just that waiting job; never manufacture a bypass signal. Existing wait-mode jobs retain their queue position until confirmed, cancelled or expired; opting into fail-fast later does not cancel them.

# Working with other agents through Turnweft

Turnweft runs the other agent in the user's real project directory, in a persistent session you can continue. Tools: `turnweft_agents`, `turnweft_session`, `turnweft_ask` (analyze), `turnweft_delegate` (implement), `turnweft_job`, `turnweft_cancel`.

Always use these tools. Do not shell out to the `turnweft` command line instead: it cannot see this conversation's permission mode, so it never takes the bypass shortcut and asks the user whenever a confirmation is required. If the tools are missing (for example right after the plugin was reinstalled), tell the user to start a new conversation.

## Start or continue a session
- Pick the provider the user named. If unsure whether it is installed, call `turnweft_agents`.
- New work: `turnweft_session` with `action: "create"`, `provider`, `cwd` (the project directory). Keep the returned `sessionId` and use it for every follow-up with that agent in this conversation.
- Set `model` or `effort` on create only when the user asks for one. `effort` is the agent's thinking level in that agent's own values, passed through unchanged: Dim `auto`/`none`/`high`/`max`, Droid `none`…`max`, Grok `low`…`xhigh`, OpenCode `low`/`high`/`max`/`default`, agy `low`…`max`. The exact set depends on the model.
- To change the thinking level of an existing session (e.g. "think harder from now on"), use `turnweft_session` with `action: "update"`, the `sessionId` and the new `effort`. Do not create a new session for this: update keeps the same agent session and its context, and applies from the next turn.
- Continue with the exact `sessionId` you saved. Never guess "the latest session". If you lost it, `turnweft_session` `list` for this project and ask the user which one if more than one fits.
- A session created from another host (Codex) must be attached explicitly (`action: "attach"`) and only when the user asks to continue it here.

## Submit a turn
- Choose the intent from what the user wants this turn to do: `turnweft_ask` for analysis or review that must not change files, `turnweft_delegate` to change code. "Review and fix" is an ask followed by a delegate, not one call.
- Generate a fresh `requestId` (e.g. a UUID) for each new turn and keep it. If a call errors or times out, retry with the **same** `requestId`; Turnweft returns the original job instead of running the work twice.
- Submission returns quickly with a `jobId`. Poll with `turnweft_job` (`waitMs` up to the limit; pass `afterSeq` from the previous `nextSeq` to get only new events). Do not resubmit while a job is running.

## When confirmation is needed
Some agents can only work in a tier that is broader than the current grant (for example Droid approving commands, or a Grok config that auto-approves everything). The first `turnweft_delegate` (or `turnweft_ask` for an agent that cannot be held read-only) for that agent in this project needs the user's confirmation once. You cannot confirm on the user's behalf, and you must not run `turnweft policy grant` yourself.
- The result is `awaiting_confirmation`: the job is recorded (state `waiting_confirmation`) and nothing has run yet. Claude Code declines MCP confirmation dialogs automatically, so Turnweft shows its own macOS dialog on the user's screen; it waits until they choose.
- Tell the user plainly what tier and extra permissions were requested, and that a Turnweft dialog is waiting on their screen. Do **not** resubmit: after they click Allow, the same job starts by itself.
- Then keep polling `turnweft_job` with the same `jobId` and `waitMs: 25000` in this same turn, so you notice the confirmation and carry on (nextAction is `confirm_policy` while it waits). Do not end your turn just to wait for the click. Stop polling after about 10 minutes of waiting; then tell the user to say "continue" once they have confirmed, and resume polling when they do.
- When this conversation runs in bypass permissions mode, Turnweft learns that from Claude Code itself (the plugin's PreToolUse hook) and authorizes the job directly: the result is `accepted` with a warning "Authorized by the host's bypass mode", and no dialog appears. Auto mode and other modes still show the dialog. Never claim or pass a bypass yourself; Turnweft only trusts what Claude Code records.
- If they click Deny, the job is cancelled (`confirmation_denied`). It never times out into a denial; it only expires with the proposal (`confirmation_expired`, after a day).
- If no dialog appeared or they prefer the terminal, give the command in its own `bash` code block — `turnweft policy grant <proposalId>` (type `yes` to allow, `no` to deny) — and tell them to run it in the app's terminal panel or their own terminal (the inline Run button shows the prompt but does not accept typing).

## While the agent works
- Do not edit the same files yourself while a delegated write is running.
- To stop it, `turnweft_cancel` with the `jobId`. Cancellation is confirmed only when the job state becomes `cancelled`.

## Reading results
- `turnweft_job` with `includeResult: true` returns the final text, the files changed inside the session directory during the turn (pre-existing uncommitted changes are listed separately and are not the agent's), any `changedOutsideCwd` paths elsewhere in the repository (these may be someone else's concurrent edits; check before attributing them), the effective permission mode, and any approvals Turnweft answered.
- The agent saying "tests pass" is a claim. Run the tests yourself before telling the user the work is done.
- `in_doubt` means the turn may have run but Turnweft could not confirm it finished; inspect the files before deciding whether to retry. Never resend automatically.
- `failed` with `permission_blocked`, `capability_mismatch`, `auth_required` or `session_not_found`: report the reason to the user; do not switch to another agent or start a new session silently.
- `failed` with `invalid_effort`: the agent does not offer that thinking level with this model; nothing was sent. The reason lists the values it offers. Ask the user which one to use, then `update` the same session with it and resubmit the turn with a new `requestId`.

## Read-only analysis and denied actions

Analyze turns deny every command, including `git show`, `git diff` and `git log`; reading files is allowed. When the agent needs a diff, log or other command output, the host must export it to a file first and point the agent to that file. Do not expect an analyze agent to run a read-only command.

For normally ended analyze turns (including native permission stops), non-empty final text means `succeeded`; denied requests are listed in `result.deniedActions` (`kind`, `title`), with `warningCodes: ["denied_actions"]` and a localized envelope warning that the result may be incomplete. Surface that warning and inspect the report. Empty/whitespace output plus a denial means `failed` / `permission_blocked`: supply the needed output as files, or use implement when authorized. Empty output with no denial stays `succeeded` with `empty_output`. Implement permission stops still fail, even if they returned text; cancellation, provider errors and incomplete turns retain their existing classifications. User prompt text is not rewritten.

## Parallel writers and reviews

- To run several writing agents in parallel on one project, give each its own git worktree and create each Turnweft session in that directory. Turnweft locks per canonical directory, so different worktrees do not block each other.
- Implement jobs in the same directory queue by default. Use `turnweft_ask` (`analyze`) for reviews: it never queues behind the project write lock. Same-session turns always remain FIFO.
- The user can opt an exact directory into concurrent writes with `"parallelWrites": ["/absolute/project/directory"]` in `~/.turnweft/config.json`. Only the user may change this setting; **the agent must never edit that config itself**. There is no tool argument, task flag or project-file override.
- Risk: concurrent changes may overwrite each other, and git commits may include other agents' changes. Surface the `concurrentWrites` peer job IDs and warnings when present.
