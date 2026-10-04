#!/bin/bash
# Codex host end-to-end for one provider (consumes model quota):
#   1) codex exec: create session, ask (analyze), delegate (implement) -> expect needs_confirmation
#   2) grant every pending proposal through a pseudo-TTY (test stand-in for the user)
#   3) codex exec resume <thread id from run 1>: resubmit with the same requestIds, follow-up ask, run tests
# Usage: scripts/codex-host-e2e.sh <provider> [model]
set -u
PROVIDER=$1; MODEL=${2:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
L=$ROOT/plugins/codex/launcher.mjs
OUT=$ROOT/m0/results/codex-host/$PROVIDER; mkdir -p "$OUT"
P=$(mktemp -d /tmp/tw-codex-$PROVIDER-XXXX)
cp -R "$ROOT/m0/fixture-template/." "$P/" && cd "$P" && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture
# Unattended run: no macOS dialog (nobody would click it); confirmations go through the terminal grant below.
MCP=(-c 'mcp_servers.turnweft.command="node"' -c "mcp_servers.turnweft.args=[\"$L\"]" -c 'mcp_servers.turnweft.tool_timeout_sec=60' -c 'mcp_servers.turnweft.env={TURNWEFT_NO_NATIVE_DIALOG="1"}')
MODEL_ARG=""; [ -n "$MODEL" ] && MODEL_ARG=", model $MODEL"
perl -e 'alarm 3600; exec @ARGV' codex exec --skip-git-repo-check -C "$P" "${MCP[@]}" \
  "Use the Turnweft MCP tools only. 1) turnweft_session action create, provider $PROVIDER, cwd $P$MODEL_ARG. 2) turnweft_ask on it (generate and remember requestId A): 'Read src/math.js and list its bugs, one short line each. Do not modify files.' 3) If it returns needs_confirmation, note its proposalId and requestId A and skip to step 5. Otherwise poll turnweft_job (waitMs 20000, includeResult true) until terminal. 4) turnweft_delegate on the same session (requestId B): 'Fix the bugs in src/math.js so node --test test/math.test.js passes.' 5) Report: sessionId, requestIds A and B, every proposalId returned, and each job state/text you saw. Do not edit files yourself." \
  < /dev/null > "$OUT/run1.log" 2>&1
# Resume the exact Codex thread from run 1 (not --last: parallel runs would pick each other's threads).
THREAD=$(grep -m1 -oE 'session id: [0-9a-f-]+' "$OUT/run1.log" | awk '{print $3}')
echo "thread=$THREAD" > "$OUT/thread.txt"
for PID in $(grep -oE 'twq_[0-9a-f]{20}' "$OUT/run1.log" | sort -u); do
  (sleep 3; printf 'yes\n'; sleep 3) | script -q /dev/null turnweft policy grant "$PID" > "$OUT/grant-$PID.log" 2>&1
done
perl -e 'alarm 3600; exec @ARGV' codex exec resume "$THREAD" --skip-git-repo-check "${MCP[@]}" \
  "The user confirmed any pending Turnweft policies in a terminal. For every turn that returned needs_confirmation, resubmit it with the SAME requestId and prompt, then poll turnweft_job (waitMs 20000, includeResult true) until terminal. Make sure the delegate (requestId B) has run. Then turnweft_ask the same session (new requestId): 'Which lines did you change, and what did I first ask you in this conversation? Answer briefly.' Poll until terminal. Report each job state, the delegate result files.changed and permission effectiveMode, and the final answer. Then run node --test test/math.test.js yourself and report pass/fail. Do not edit files yourself." \
  < /dev/null > "$OUT/run2.log" 2>&1
TESTS=$(node --test test/math.test.js >/dev/null 2>&1 && echo pass || echo fail)
echo "provider=$PROVIDER project=$P tests=$TESTS changed=$(git status --porcelain | tr '\n' ' ')" | tee "$OUT/summary.txt"
