import { appendFileSync, readFileSync } from "node:fs";
const tag = process.argv[2];
let input = "";
try { input = readFileSync(0, "utf8"); } catch {}
let cmd = null;
try { cmd = JSON.parse(input)?.tool_input?.command ?? null; } catch {}
appendFileSync(`/tmp/tedy-probes/logs/${tag}.jsonl`, JSON.stringify({ tag, cmd, root: process.env.CLAUDE_PLUGIN_ROOT ?? null, at: new Date().toISOString() }) + "\n");
if (tag === "compact") console.log("ROLE-REMINDER-77310: active role probe");
