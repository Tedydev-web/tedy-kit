import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ISSUE_OR_PR, PINNED_BLOB } from "./prior-art.mjs";

const EVIDENCE = /^\s*- (\S+)(?: "(.+)")?\s*$/;
const COMMAND = /^\s*- `[^`]+` \(/;
const LOCAL_PATH = /^(?:~\/|[\w.-]+\/)\S*:\d+(?:-\d+)?$/;
const QUERY_LINE = /^no (social )?prior art: /;
const GITHUB_EVIDENCE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|issues|pull)\/\S+/;
const BROKEN = new Set(["missing", "wrong-lines", "excerpt-absent", "no-excerpt", "unparsed"]);

const squash = (text) => text.replace(/\s+/g, " ").trim();

export function ghCli(args) {
  try {
    return execFileSync("gh", ["api", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return null;
    throw new Error(`gh api ${args.join(" ")}: ${String(error.stderr || error.message).trim()}`);
  }
}

function blobLabel(match, excerpt, ghApi) {
  const [, owner, repo, sha, path, start, end] = match;
  const raw = ghApi(["-H", "Accept: application/vnd.github.raw", `repos/${owner}/${repo}/contents/${path}?ref=${sha}`]);
  if (raw === null) return ["missing"];
  const lines = raw.split("\n");
  const wanted = squash(excerpt);
  if (squash(lines.slice(Number(start) - 1, Number(end || start)).join(" ")).includes(wanted)) return ["ok"];
  return squash(raw).includes(wanted) ? ["wrong-lines"] : ["missing"];
}

function issueLabels(match, excerpt, ghApi) {
  const [, owner, repo, , number] = match;
  const base = `repos/${owner}/${repo}`;
  const raw = ghApi([`${base}/issues/${number}`]);
  if (raw === null) return ["missing"];
  const issue = JSON.parse(raw);
  let state = issue.state;
  if (state === "closed" && issue.pull_request) state = JSON.parse(ghApi([`${base}/pulls/${number}`])).merged_at ? "merged" : "closed-unmerged";
  else if (state === "closed") state = { completed: "completed", not_planned: "not-planned" }[issue.state_reason] || "closed";
  const comments = ghApi([`${base}/issues/${number}/comments`, "--paginate", "--jq", ".[].body"]) || "";
  return [state, squash(`${issue.body || ""} ${comments}`).includes(squash(excerpt)) ? "excerpt-found" : "excerpt-absent"];
}

function lineLabels(line, ghApi) {
  if (QUERY_LINE.test(line) || COMMAND.test(line)) return { ref: line.trim(), labels: ["unchecked"] };
  const evidence = line.match(EVIDENCE);
  const github = line.match(GITHUB_EVIDENCE);
  if (!evidence) return github ? { ref: github[0], labels: ["unparsed"] } : null;
  const [, ref, excerpt] = evidence;
  const pinned = ref.match(PINNED_BLOB);
  const issue = ref.match(ISSUE_OR_PR);
  if (github && !pinned && !issue) return { ref, labels: ["unparsed"] };
  if (pinned || issue) {
    if (excerpt === undefined) return { ref, labels: ["no-excerpt"] };
    return { ref, labels: pinned ? blobLabel(pinned, excerpt, ghApi) : issueLabels(issue, excerpt, ghApi) };
  }
  return ref.startsWith("https://") || LOCAL_PATH.test(ref) ? { ref, labels: ["unchecked"] } : null;
}

export function verifyText(label, text, ghApi = ghCli) {
  return text.split("\n").flatMap((line, index) => {
    const row = lineLabels(line, ghApi);
    return row ? [{ label, line: index + 1, ...row, broken: row.labels.some((name) => BROKEN.has(name)) }] : [];
  });
}

function main(files) {
  if (!files.length || files.some((file) => !existsSync(file) || !statSync(file).isFile())) {
    process.stderr.write("usage: prior-art-verify.mjs <adr-or-card.md>...   (every file must exist)\n");
    return 2;
  }
  let rows;
  try {
    rows = files.flatMap((file) => verifyText(file, readFileSync(file, "utf8")));
  } catch (error) {
    process.stderr.write(`prior-art-verify: ${error.message}\n`);
    return 2;
  }
  if (rows.length) process.stdout.write(`${rows.map((row) => `${row.label}:${row.line} ${row.labels.join(" ")} ${row.ref}`).join("\n")}\n`);
  const broken = rows.filter((row) => row.broken).length;
  process.stderr.write(`prior-art-verify: ${rows.length} line(s), ${broken} broken\n`);
  return broken ? 1 : 0;
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
