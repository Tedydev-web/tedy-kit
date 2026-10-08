import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isScannedFile, newComments } from "./comment-scan.mjs";
import { deny, logGate, readHookInput } from "./hook-io.mjs";

export function checkEdit(toolName, toolInput) {
  const path = toolInput?.file_path ?? "";
  if (!isScannedFile(path)) return { allow: true };
  const before = toolName === "Write" ? (existsSync(path) ? readFileSync(path, "utf8") : "") : toolInput.old_string ?? "";
  const after = toolName === "Write" ? toolInput.content ?? "" : toolInput.new_string ?? "";
  const added = newComments(before, after);
  if (!added.length) return { allow: true };
  const shown = added.slice(0, 5).map((comment) => `- ${comment.text.split("\n")[0].slice(0, 100)}`).join("\n");
  return {
    allow: false,
    reason: `tedy gate: this edit adds comments to ${path}:\n${shown}\nWrite the change without them and put the explanation in the commit message or PR description (working-style rule 10). Writing the file through Bash does not help: the report after each push flags the same rule to the user.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readHookInput();
  try {
    const result = checkEdit(input.tool_name, input.tool_input);
    if (!result.allow) {
      logGate({ hook: "no-comments-edit", decision: "deny", file: input.tool_input?.file_path });
      deny(result.reason);
    }
  } catch (error) {
    logGate({ hook: "no-comments-edit", decision: "allow-on-error", error: error.message });
  }
}
