import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ask, deny, logGate, readHookInput } from "../lib/hook-io.mjs";
import { splitParts, substitutions, tokenize } from "../lib/shell-segments.mjs";

const REVIEWER = "tedy:reviewer";
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const READ_SCRIPTS = { "project-map.mjs": ["resolve", "missing"], "prd-section.mjs": ["find", "index"], "figma-read.mjs": ["text", "diff", "versions"] };
const PLAIN_READS = new Set(["rg", "grep", "egrep", "fgrep", "fd", "find", "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "file", "stat", "diff", "comm", "jq", "basename", "dirname", "realpath", "pwd", "echo", "printf", "true", "test", "which", "date", "tree", "sed"]);
const GIT_READS = new Set(["blame", "log", "show", "diff", "grep", "ls-files", "ls-tree", "rev-parse", "merge-base", "cat-file", "status", "rev-list", "describe", "shortlog", "show-ref", "name-rev", "for-each-ref", "diff-tree"]);
const GH_READS = { pr: ["view", "diff", "list", "checks", "status"], issue: ["view", "list"], repo: ["view"], search: ["code", "prs", "issues", "commits", "repos"], run: ["view", "list"] };
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"]);
const SED_RANGE = /^(\d+|\$)(,(\d+|\$))?p$/;
const SAFE_SINK = new Set(["/dev/null", "&1", "&2"]);
const NETWORK = new Set(["curl"]);
const INSTEAD = "Use git log/show/diff/blame/grep, rg, grep, cat, head, sed -n 'N,Mp', find without -exec, gh pr view/diff or gh api GET, or the kit's read scripts, and report what you could not check instead.";

export const isReviewer = (input) => input.tool_name === "Bash" && input.agent_type === REVIEWER;

const refuse = (segment, why) => ({ decision: "deny", reason: `tedy reviewer gate: the reviewer is read-only, so "${segment}" is refused (${why}). ${INSTEAD}` });

function redirectProblem(tokens) {
  const args = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const match = tokens[index].match(/^(\d*|&)(>>?)(.*)$/);
    if (!match) {
      args.push(tokens[index]);
      continue;
    }
    const target = match[3] || tokens[(index += 1)];
    if (!SAFE_SINK.has(target)) return { args, problem: "it writes to a file" };
  }
  return { args, problem: null };
}

function plainProblem(word, args) {
  if (word === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return "rg --pre runs a program";
  if (word === "find" && args.some((arg) => FIND_WRITES.has(arg) || arg.startsWith("-fprint"))) return "find with -exec or -delete changes files";
  if (word === "fd" && args.some((arg) => ["-x", "-X"].includes(arg) || arg.startsWith("--exec"))) return "fd --exec runs a program";
  if (word === "sort" && args.some((arg) => arg.startsWith("--output") || /^-[^-]*o/.test(arg))) return "sort -o writes a file";
  if (word === "sed") {
    const flags = args.filter((arg) => arg.startsWith("-"));
    const scripts = args.filter((arg) => !arg.startsWith("-"));
    if (!flags.includes("-n") || flags.some((arg) => !["-n", "-E", "-r"].includes(arg)) || !SED_RANGE.test(scripts[0] ?? "")) return "only sed -n 'N,Mp' reads are allowed";
  }
  return null;
}

function gitVerdict(segment, args) {
  let at = 0;
  while (at < args.length && args[at].startsWith("-")) {
    if (args[at] === "-C") at += 2;
    else if (["--no-pager", "-P", "--no-optional-locks"].includes(args[at])) at += 1;
    else return refuse(segment, `git option ${args[at]} can change what git runs`);
  }
  const [sub, ...rest] = args.slice(at);
  if (sub === "fetch") return { decision: "ask", reason: `tedy reviewer gate: "${segment}" fetches from the network. Allow it only if the review needs that ref.` };
  if (!GIT_READS.has(sub)) return refuse(segment, `git ${sub ?? ""} is not a read`);
  if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff" || arg === "-O" || arg.startsWith("--open-files-in-pager"))) return refuse(segment, "that option writes a file or runs a program");
  return { decision: "allow" };
}

function ghVerdict(segment, args) {
  const [group, action, ...rest] = args;
  if (group === "api") {
    const all = [action, ...rest];
    if (all.includes("graphql")) return refuse(segment, "gh api graphql can mutate");
    for (let index = 0; index < all.length; index += 1) {
      const arg = all[index] ?? "";
      const method = arg === "-X" || arg === "--method" ? all[index + 1] : arg.match(/^(?:-X|--method=)(.+)$/)?.[1];
      if (method !== undefined && method.toUpperCase() !== "GET") return refuse(segment, `gh api ${method} writes`);
      if (/^-[fF]/.test(arg) || /^--(field|raw-field|input)\b/.test(arg)) return refuse(segment, "gh api with fields sends a request body");
    }
    return { decision: "allow" };
  }
  return GH_READS[group]?.includes(action) ? { decision: "allow" } : refuse(segment, `gh ${group ?? ""} ${action ?? ""} is not a read`);
}

function nodeVerdict(segment, args, cwd) {
  const [script, sub] = args;
  if (!script || script.startsWith("-")) return refuse(segment, "node runs code");
  const path = resolve(cwd, script);
  const name = path.startsWith(SCRIPTS) ? path.slice(SCRIPTS.length) : null;
  if (!name || !READ_SCRIPTS[name]?.includes(sub)) return refuse(segment, "only the kit's read scripts (project-map resolve, prd-section find, figma-read text) may run");
  return { decision: "allow" };
}

function segmentVerdict(segment, cwd) {
  const tokens = tokenize(segment);
  if (!tokens.length) return { decision: "allow" };
  const { args: words, problem } = redirectProblem(tokens);
  if (problem) return refuse(segment, problem);
  const [word, ...args] = words;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return refuse(segment, "an environment assignment can change what a program runs");
  if (["cd", "pushd", "popd"].includes(word)) return { decision: "allow" };
  if (word === "git") return gitVerdict(segment, args);
  if (word === "gh") return ghVerdict(segment, args);
  if (word === "node") return nodeVerdict(segment, args, cwd);
  if (NETWORK.has(word)) return { decision: "ask", reason: `tedy reviewer gate: "${segment}" reaches the network while the reviewer reads untrusted PR text. Allow it only if the review needs that page.` };
  if (!PLAIN_READS.has(word)) return refuse(segment, `${word} is not on the reviewer's read list`);
  const why = plainProblem(word, args);
  return why ? refuse(segment, why) : { decision: "allow" };
}

export function reviewerVerdict(command, cwd) {
  const nested = substitutions(command);
  if (nested === null || nested.length) return refuse(command, "a command substitution hides what runs");
  let asked = null;
  for (const { text } of splitParts(command, false)) {
    const verdict = segmentVerdict(text.trim(), cwd);
    if (verdict.decision === "deny") return verdict;
    if (verdict.decision === "ask") asked ??= verdict;
  }
  return asked ?? { decision: "allow" };
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  if (!isReviewer(input)) return;
  const command = input.tool_input?.command ?? "";
  try {
    const verdict = reviewerVerdict(command, input.cwd ?? process.cwd());
    logGate({ hook: "reviewer-gate", decision: verdict.decision, agent: input.agent_id, command: command.slice(0, 200) });
    if (verdict.decision === "deny") deny(verdict.reason);
    if (verdict.decision === "ask") ask(verdict.reason);
  } catch (error) {
    logGate({ hook: "reviewer-gate", decision: "deny-on-error", error: error.message });
    deny(`tedy reviewer gate: could not read this command (${error.message}), so the read-only reviewer may not run it. ${INSTEAD}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
