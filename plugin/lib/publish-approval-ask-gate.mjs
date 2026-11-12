import { pathToFileURL } from "node:url";
import { gateSwitches, logGate, readHookInput } from "./hook-io.mjs";
import { unquotedPreviews } from "./publish-approval-ticket.mjs";

const REASON = "publish approval is in answer mode, and the chat has not shown this approving question's whole preview, so the answer would mint no ticket and the write would be refused. Nothing was asked. Right before the question, quote the whole preview verbatim in one fenced block of a reply text, then call AskUserQuestion again, with no tool call between them. Never switch publish approval to another mode to get past this; the mode is the user's setting.";

export function run() {
  const input = readHookInput();
  try {
    if (input.agent_id || gateSwitches().publishApproval !== "answer") return;
    const missing = unquotedPreviews(input);
    if (missing === null) {
      logGate({ hook: "publish-approval-ask", decision: "transcript-unread", tool_use_id: input.tool_use_id });
      return;
    }
    if (!missing.length) return;
    logGate({ hook: "publish-approval-ask", decision: "deny", previews: missing.length, tool_use_id: input.tool_use_id });
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON } })}\n`);
  } catch (error) {
    logGate({ hook: "publish-approval-ask", decision: "check-failed", error: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
