import { appendFileSync, readFileSync } from "node:fs";
const tag = process.argv[2];
let input = "";
try { input = readFileSync(0, "utf8"); } catch {}
let event = {};
try { event = JSON.parse(input) ?? {}; } catch {}
const cmd = event.tool_input?.command ?? null;
appendFileSync(`/tmp/tedy-probes/logs/${tag}.jsonl`, JSON.stringify({
  tag,
  cmd,
  tool: event.tool_name ?? null,
  root: process.env.CLAUDE_PLUGIN_ROOT ?? null,
  event: event.hook_event_name ?? null,
  agent_type: event.agent_type ?? null,
  agent_id: event.agent_id ?? null,
  session_id: event.session_id ?? null,
  cwd: event.cwd ?? null,
  permission_mode: event.permission_mode ?? null,
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  mark: process.env.TEDY_PROBE_MARK ?? null,
  at: new Date().toISOString(),
}) + "\n");
if (tag === "compact") console.log("ROLE-REMINDER-77310: active role probe");
if (tag === "hook-ask" && typeof cmd === "string" && cmd.includes("tedy-hook-ask")) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "probe hook ask" } }));
}
