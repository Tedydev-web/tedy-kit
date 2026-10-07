#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d /tmp/tedy-probes-XXXX)"
mkdir -p /tmp/tedy-probes/logs && rm -f /tmp/tedy-probes/logs/*.jsonl
cd "$W" && git init -q && echo a > a.txt && git add a.txt && git -c user.email=p@p -c user.name=p commit -qm init && echo m >> a.txt
run() { timeout 300 claude -p --plugin-dir "$HERE/probe" --permission-mode bypassPermissions --max-budget-usd 1 "$@" < /dev/null 2>/dev/null; }
echo "[1-3] hook input, if-filters, plugin root"
run "Run exactly these two bash commands, one tool call each, and nothing else: (1) git status --short (2) rtk git log -1 --oneline. Then reply DONE." >/dev/null
for t in if-git if-rtk all-bash; do printf '%s: ' "$t"; jq -r .cmd /tmp/tedy-probes/logs/$t.jsonl 2>/dev/null | paste -sd'|' -; done
echo "[4-5] disable-model-invocation and listing"
run "Do not invoke any skill or tool. For each name answer LISTED or NOT LISTED: (a) probe:zz-visible-probe (b) probe:zz-hidden-probe (c) probe:zz-body-probe."
echo "[6] routing line reaches a name-only skill"
run --append-system-prompt "Routing rule: whenever the user asks to check probe visibility, invoke the probe:zz-visible-probe skill." --output-format stream-json --verbose "check probe visibility please" | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | "\(.name) \(.input|tostring)"' | head -1
echo "[7] compaction keeps skill body, compact hook output, user import"
SID=$(python3 -c 'import uuid;print(uuid.uuid4())')
run --session-id "$SID" "/probe:zz-body-probe" >/dev/null
run --resume "$SID" "/compact" >/dev/null
run --resume "$SID" "Answer from your context, quoting exactly, or NONE: (1) the check value from the zz-body-probe skill; (2) any line containing ROLE-REMINDER; (3) the first heading line of the Shared Agent Core instructions."
echo "[8] ask rule inside bypassPermissions"
timeout 300 claude -p --permission-mode bypassPermissions --max-budget-usd 1 --output-format stream-json --verbose --settings '{"permissions":{"ask":["Bash(echo tedy-ask-probe*)"]}}' "Run exactly: echo tedy-ask-probe-1" < /dev/null 2>/dev/null | jq -r 'select(.type=="result") | "permission_denials=\(.permission_denials // [] | length)"'
D="$HOME/.claude/projects/$(echo "$W" | sed 's#[/.]#-#g')"
[ -d "$D" ] && rm -rf "$D"
rm -rf "$W"
