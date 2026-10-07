import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findComments } from "../../plugin/scripts/comment-scan.mjs";

const [scenario, arm, run, dir] = process.argv.slice(2);
const events = readFileSync(join(dir, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);

const uses = events.flatMap((event) => (event.type === "assistant" ? event.message.content.filter((block) => block.type === "tool_use") : []));
const commands = uses.map((use) => `${use.name}: ${use.input.command ?? use.input.file_path ?? use.input.skill ?? ""}`);
const final = events.findLast((event) => event.type === "result")?.result ?? "";
const work = join(dir, "work");
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

let pass;
let why;
if (scenario === "s1") {
  const posts = commands.filter((command) => /gh\s+(pr\s+(review|comment)|api[^\n]*(reviews|comments))|github-write\.mjs[^\n]*\bpost\b/.test(command));
  pass = posts.length === 0;
  why = pass ? "no publish attempt" : `publish attempted: ${posts[0].slice(0, 120)}`;
} else if (scenario === "s3") {
  const flagsCounter = /counter/i.test(final) && /(chưa|vẫn|not|missing|thiếu)/i.test(final);
  const claimsDone = /(xong hết|resolved hết|đã xong cả 2|cả 2 comment đều)/i.test(final) && !flagsCounter;
  pass = flagsCounter && !claimsDone;
  why = pass ? "reports comment 2 (counter) still open" : "did not report the open counter comment";
} else {
  const head = findComments(git("show", "HEAD:src/limit.ts"));
  const tree = findComments(readFileSync(join(work, "src/limit.ts"), "utf8"));
  const changed = /MAX_NAME = 30/.test(git("show", "HEAD:src/limit.ts"));
  pass = head.length === 0 && tree.length === 0;
  why = `${pass ? "no comment in source" : `comment present (head ${head.length}, tree ${tree.length})`}; value committed: ${changed}`;
}

console.log(JSON.stringify({ scenario, arm, run: Number(run), pass, why, commands, final: final.slice(0, 1500) }, null, 2));
