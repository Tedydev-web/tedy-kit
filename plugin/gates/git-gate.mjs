import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_GATES_ON, ask, deny, gateSwitches, logGate, readHookInput } from "../lib/hook-io.mjs";
import { resolveMap } from "../lib/project-map.mjs";
import { splitSegments, substitutions, tokenize } from "../lib/shell-segments.mjs";
import { check as checkQuoted } from "./publish-quote-gate.mjs";
import { evaluate as trackerToken, trackerHost } from "./tracker-token-gate.mjs";

export { splitSegments, tokenize };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "fetch", "rev-parse", "branch", "ls-files", "remote", "describe", "blame", "reflog"]);
const READ_ONLY_GH_ACTIONS = new Set(["view", "list", "diff", "checks", "status", "watch", "download"]);
const READ_ONLY_GH_AREAS = new Set(["search", "status", "browse", "help", "version"]);
const GH_HELP = new Set(["-h", "--help"]);
const LOCAL_GH = new Set(["pr checkout", "repo clone", "auth", "config", "alias", "extension", "completion"]);
const PROTECTED_BRANCHES = new Set(["main", "master", "dev", "develop", "production", "staging"]);
const GH_COMMANDS = new Set(["agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "copilot", "discussion", "extension", "gist", "gpg-key", "help", "issue", "label", "licenses", "org", "pr", "preview", "project", "release", "repo", "ruleset", "run", "search", "secret", "skill", "ssh-key", "status", "variable", "version", "workflow"]);
const WRAPPERS = new Map([
  ["if", []],
  ["then", []],
  ["else", []],
  ["elif", []],
  ["do", []],
  ["while", []],
  ["until", []],
  ["command", []],
  ["exec", ["-a"]],
  ["builtin", []],
  ["nohup", []],
  ["time", ["-f", "-o"]],
  ["timeout", ["-s", "--signal", "-k", "--kill-after"]],
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t", "-T"]],
  ["doas", ["-u", "-C"]],
  ["nice", ["-n", "--adjustment"]],
  ["ionice", ["-c", "-n", "-p"]],
  ["stdbuf", ["-i", "-o", "-e"]],
  ["xargs", ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]],
  ["env", ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]],
]);
const WRAPPER_ARGUMENTS = new Map([["timeout", 1]]);
const PR_CREATE_VALUE_FLAGS = new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETER = /^(?:python|node|perl|ruby|deno|bun)[\d.]*$/;
const EVAL_WORDS = new Set(["eval", "source", ".", "alias", "function"]);
const NOT_LITERAL = /[$`(*?,{]|^\[(?!\[?$)|.}/;
const RUNNERS = new Set(["env", "script", "ssh", "su", "runuser", "sg", "setsid", "flock", "watch", "parallel", "tmux", "screen", "expect", "unbuffer", "at", "batch", "chroot", "systemd-run", "nsenter", "unshare", "firejail", "bwrap"]);
const API_MERGE = /pulls\/\d+\/merge\b|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/;
const MAX_COMMAND = 10_000;
const REWRITE = "Rewrite it so every command word is literal: split it into plain commands, or put the code in a script file in the system temp directory (never inside the repository) with the Write tool and run it as `python3 <file>` or `node <file>`, with no eval, no `bash -c`, no heredoc code and no command word in a variable. Never put a git push, a merge or a GitHub write inside a script: run it as a plain command of its own so the gate can check it. The user is not asked, because they cannot check this form either.";
const UNREADABLE_REASON = `tedy gate: this command runs code the gate cannot read (a command word built at run time, eval, a shell reading code from stdin or -c, an interpreter one-liner that mentions gh, or git -c alias/core). ${REWRITE}`;
const MERGE_REASON = "tedy gate: merging or marking a PR ready belongs to the user. Allow it only if the user asked for this exact PR in this turn.";
const PUBLISH = /(?:github-write\.mjs["']?\s+(?:post|reply|edit|minimize|resolve|unresolve|pr-body)|openproject\.mjs["']?\s+apply|figma-comments\.mjs["']?\s+(?:post|reply|delete)|gdoc-comments\.mjs["']?\s+(?:reply|anchor|edit|delete))\b|^(?=[\s\S]*--apply\b)[\s\S]*?(?:openproject\.mjs["']?\s+(?:set|comment|comment-edit|relation|relation-delete|rollback)|doc-comment-file\.mjs["']?\s+post)\b/;
export const CLAUDE_SETTINGS = process.env.TEDY_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
const REWRITING_PUSH = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--all|--prune|-d|--delete)$/;
const CTX_TOOL = /__ctx_(execute|execute_file|batch_execute)$/;
const CTX_LANGUAGES = new Set(["javascript", "typescript", "python", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp"]);

function graphQuery(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = ["-f", "-F", "--field", "--raw-field"].includes(token) ? args[index + 1] : token.match(/^(?:-[fF]|--(?:raw-)?field=)(.*)$/)?.[1];
    if (value?.startsWith("query=")) return value.slice("query=".length);
  }
  return null;
}

function classifyGitHubApi(args) {
  let method = null;
  let hasFields = false;
  let endpoint = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-X" || token === "--method") {
      method = (args[index + 1] ?? "").toUpperCase();
      index += 1;
    } else if (token.startsWith("--method=")) {
      method = token.slice("--method=".length).toUpperCase();
    } else if (/^-X./.test(token)) {
      method = token.replace(/^-X=?/, "").toUpperCase();
    } else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(token)) {
      hasFields = true;
      index += 1;
    } else if (/^(--(raw-)?field=|--input=|-[fF].)/.test(token)) {
      hasFields = true;
    } else if (!token.startsWith("-") && endpoint === null) {
      endpoint = token;
    }
  }
  if (endpoint === "graphql") {
    if (args.some((token) => /mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/.test(token))) return "pr-merge";
    if (args.some((token) => /\bmutation\b/.test(token))) return "github-write";
    if (args.some((token) => /^--input(=|$)|=@/.test(token))) return "pr-merge";
    const query = graphQuery(args);
    return query !== null && /^\s*(query\b|\{)/.test(query) && !/\$\(|`/.test(query) ? null : "pr-merge";
  }
  const effective = method ?? (hasFields ? "POST" : "GET");
  if (effective === "PUT" && /\/pulls\/\d+\/merge\/?$/.test(endpoint ?? "")) return "pr-merge";
  if (effective === "POST" && /\/pulls\/?$/.test(endpoint ?? "")) return "pr-open";
  return effective === "GET" ? null : "github-write";
}

function commandTokens(segment) {
  const tokens = strippedTokens(segment);
  return tokens.length && tokens[0].includes("/") ? [basename(tokens[0]), ...tokens.slice(1)] : tokens;
}

function strippedTokens(segment) {
  const all = tokenize(segment);
  let at = 0;
  for (;;) {
    while (at < all.length && (ENV_ASSIGNMENT.test(all[at]) || /^[({!]+$/.test(all[at]))) at += 1;
    if (at < all.length) all[at] = all[at].replace(/^[({!]+/, "");
    const flags = WRAPPERS.get(all[at]);
    if (!flags) break;
    let positionals = WRAPPER_ARGUMENTS.get(all[at]) ?? 0;
    at += 1;
    while (at < all.length) {
      if (ENV_ASSIGNMENT.test(all[at])) at += 1;
      else if (all[at].startsWith("-")) at += flags.includes(all[at]) ? 2 : 1;
      else if (positionals > 0) {
        positionals -= 1;
        at += 1;
      } else break;
    }
  }
  return all.slice(at);
}

function unreadable(segment) {
  const tokens = strippedTokens(segment);
  const [word = "", ...args] = tokens;
  if (NOT_LITERAL.test(word) || EVAL_WORDS.has(word)) return true;
  const program = basename(word);
  if (/\$'[^']*\\/.test(segment)) return true;
  const raw = tokenize(segment);
  if (raw.some((token, index) => RUNNERS.has(basename(token)) && raw.slice(index + 1).some((arg) => /\s/.test(arg) && /\bgh\b|github/i.test(arg)))) return true;
  if (SHELLS.has(program)) return args.some((arg) => /^-[a-zA-Z]*[cs]/.test(arg) || arg === "<<<" || arg === "<") || !args.some((arg) => !arg.startsWith("-"));
  if (INTERPRETER.test(program)) return args.some((arg) => /^(-[a-zA-Z]*[ce][a-zA-Z]*|--eval|--print)$/.test(arg)) && /\bgh\b|github/i.test(segment);
  if (program === "git") {
    let index = 0;
    for (; index < args.length && args[index].startsWith("-"); index += 1) {
      if (/^--config-env/.test(args[index])) return true;
      if (args[index] === "-c" && /^(alias|core)\./i.test(args[index + 1] ?? "")) return true;
      if (args[index] === "-c" || args[index] === "-C") index += 1;
    }
    if (args[index] === "config" && args.slice(index + 1).some((arg) => /^(alias|core)\./i.test(arg))) return true;
  }
  return false;
}

export function loadAskRules(path) {
  try {
    const rules = JSON.parse(readFileSync(path, "utf8")).permissions?.ask ?? [];
    return rules.flatMap((rule) => (typeof rule === "string" ? (rule.match(/^Bash\(([\s\S]*)\)$/)?.slice(1) ?? []) : []));
  } catch {
    return null;
  }
}

export function globMatches(glob, text) {
  const parts = glob.split("*");
  if (parts.length === 1) return glob === text;
  const first = parts[0];
  const last = parts.at(-1);
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  const end = text.length - last.length;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

function uncoveredPublish(command, settingsFile) {
  let rules;
  for (const segment of splitSegments(command, false)) {
    if (!PUBLISH.test(segment)) continue;
    rules ??= loadAskRules(settingsFile);
    if (rules === null) return "tedy gate: could not read the ask rules; approve only if you have seen the exact draft.";
    if (!rules.some((glob) => globMatches(glob, segment))) return `tedy gate: no permission rule covers this publish (\`${segment.slice(0, 120)}\`); approve only if you have seen the exact draft.`;
  }
  return null;
}

export function hiddenPublish(command) {
  for (const segment of splitSegments(command, false)) {
    if (!PUBLISH.test(segment)) continue;
    const tokens = tokenize(segment);
    const first = tokens.find((token) => !ENV_ASSIGNMENT.test(token));
    if (first !== "node") return segment;
  }
  return null;
}

function withoutRepoFlags(args) {
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-R" || args[index] === "--repo") index += 1;
    else if (!/^(-R.|--repo=)/.test(args[index])) kept.push(args[index]);
  }
  return kept;
}

export function classify(segment, cwd) {
  const [program, ...args] = commandTokens(segment);
  if (program === "cd") return { kind: "cd", dir: resolve(cwd, (args[0] ?? "~").replace(/^~(?=\/|$)/, homedir())) };
  if (program === "git") {
    let dir = cwd;
    let index = 0;
    while (index < args.length && args[index].startsWith("-")) {
      if (args[index] === "-C") {
        dir = resolve(dir, args[index + 1] ?? ".");
        index += 2;
      } else if (args[index] === "-c") {
        index += 2;
      } else {
        index += 1;
      }
    }
    const subcommand = args[index];
    if (subcommand === "push") return { kind: "push", dir, args: args.slice(index + 1) };
    if (subcommand === "add") return { kind: "add", dir, args: args.slice(index + 1) };
    if (subcommand === "commit") {
      const all = args.slice(index + 1).some((token) => token === "--all" || /^-[^-]*a/.test(token));
      return { kind: "commit", dir, all };
    }
    return { kind: READ_ONLY_GIT.has(subcommand) ? "read" : "other", dir };
  }
  if (program === "gh") {
    const ghArgs = withoutRepoFlags(args);
    const words = ghArgs.filter((token) => !token.startsWith("-"));
    if (!words.length) return { kind: "read", dir: cwd };
    const [area] = words;
    const rest = ghArgs.slice(ghArgs.indexOf(area) + 1);
    const action = rest[0];
    const plainArea = !ghArgs[0].startsWith("-");
    const plainAction = plainArea && action !== undefined && !action.startsWith("-");
    const pr = plainArea ? area === "pr" : words.includes("pr");
    const verbs = plainAction ? [action] : words;
    if (plainArea && (GH_HELP.has(action) || (plainAction && GH_HELP.has(rest[1])))) return { kind: "read", dir: cwd };
    if (pr && verbs.some((word) => word === "create" || word === "new")) return { kind: "pr-create", dir: cwd, args: rest };
    if (plainArea && area === "extension" && action === "exec") return { kind: "github-write", dir: cwd, pr: false, verbs: [action], unknown: true };
    if (plainArea && area === "api") {
      const api = classifyGitHubApi(rest);
      if (api === "pr-merge") return { kind: "github-write", dir: cwd, pr: true, verbs: ["merge"] };
      if (api === "pr-open") return { kind: "github-write", dir: cwd, pr: true, verbs: ["api-pr-create"] };
      return { kind: api ?? "read", dir: cwd };
    }
    if (plainArea && (READ_ONLY_GH_AREAS.has(area) || (plainAction && READ_ONLY_GH_ACTIONS.has(action)))) return { kind: "read", dir: cwd };
    if (plainArea && (LOCAL_GH.has(area) || (plainAction && LOCAL_GH.has(`${area} ${action}`)))) return { kind: "other", dir: cwd };
    return { kind: "github-write", dir: cwd, pr, verbs, unknown: plainArea && !GH_COMMANDS.has(area) };
  }
  return { kind: "other", dir: cwd };
}

function tryGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

export function pushRisk(args, dir, exempt = []) {
  const rewriting = args.find((arg) => REWRITING_PUSH.test(arg));
  if (rewriting) return `\`${rewriting}\` can rewrite or delete remote branches`;
  const exemptRoots = new Set(exempt.map((path) => resolve(path)));
  const guarded = (target) => PROTECTED_BRANCHES.has(target) && !exemptRoots.has(tryGit(dir, ["rev-parse", "--show-toplevel"]));
  const refspecs = args.filter((arg) => !arg.startsWith("-")).slice(1);
  if (!refspecs.length) {
    const upstream = tryGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const target = upstream ? upstream.replace(/^[^/]+\//, "") : tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return guarded(target) ? `it pushes to \`${target}\`` : null;
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return `\`${refspec}\` forces the update`;
    const [source, destination = source] = refspec.split(":");
    if (!source) return `\`${refspec}\` deletes a remote branch`;
    const target = destination === "HEAD" ? tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : destination.replace(/^refs\/heads\//, "");
    if (guarded(target)) return `it pushes to \`${target}\``;
  }
  return null;
}

export function prBody(args, dir) {
  for (let index = 0; index < args.length; index += 1) {
    const match = args[index].match(/^(--body|-b|--body-file|-F)(?:=([\s\S]*))?$/);
    if (!match) continue;
    const value = match[2] ?? args[index + 1];
    if (value === undefined) return null;
    if (match[1] === "--body" || match[1] === "-b") return value;
    if (value === "-") return null;
    try {
      return readFileSync(resolve(dir, value), "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

export function isDraft(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (PR_CREATE_VALUE_FLAGS.has(args[index])) index += 1;
    else if (args[index] === "--draft" || args[index] === "--draft=true" || /^-d[A-Za-z]*$/.test(args[index])) return true;
  }
  return false;
}

function mentionsGhMerge(segment) {
  const tokens = commandTokens(segment);
  const at = tokens.findIndex((token) => basename(token) === "gh");
  if (at < 1) return false;
  const rest = tokens.slice(at + 1);
  return rest.includes("pr") && rest.some((word) => word === "merge" || word === "ready");
}

export function evaluate(command, cwd, { gates = ALL_GATES_ON, projectsDir, settingsFile } = {}) {
  let asked = null;
  let rewrite = null;
  const askFor = (reason) => {
    asked ??= { allow: false, ask: true, reason };
  };
  const rewriteFor = (reason) => {
    rewrite ??= { allow: false, reason };
  };
  const hidden = hiddenPublish(command);
  if (hidden) askFor(`tedy gate: this publishes through a kit script in a form the permission rules do not match (\`${hidden.slice(0, 120)}\`). Allow it only if the user approved this exact publish; otherwise run it as a plain \`node <script> …\` command.`);
  const uncovered = settingsFile ? uncoveredPublish(command, settingsFile) : null;
  if (uncovered) askFor(uncovered);
  if (command.length > MAX_COMMAND) rewriteFor(`tedy gate: this command is longer than ${MAX_COMMAND} characters, too long to check. ${REWRITE}`);
  const nested = substitutions(command);
  if (nested === null) rewriteFor(`tedy gate: this command nests command substitutions too deeply to check. ${REWRITE}`);
  let dir = cwd;
  for (const segment of [...splitSegments(command), ...(nested ?? []).flatMap((body) => splitSegments(body))]) {
    const action = classify(segment, dir);
    if (action.kind === "cd") {
      dir = action.dir;
      continue;
    }
    if (unreadable(segment)) rewriteFor(UNREADABLE_REASON);
    if (action.kind === "push") {
      const risk = pushRisk(action.args, action.dir, gates.pushExempt);
      if (risk) askFor(`tedy gate: ${risk}, which belongs to the user. Allow it only if the user asked for this push.`);
      continue;
    }
    if (action.kind === "pr-create") {
      if (gates.draftPrOnly && !isDraft(action.args)) return { allow: false, reason: "tedy gate: open the PR as a draft with `--draft`; the user marks it ready." };
      let found;
      try {
        found = projectsDir ? resolveMap(action.dir, projectsDir) : resolveMap(action.dir);
      } catch {
        askFor("tedy gate: a project map could not be read, so the work-package check for this PR did not run. Allow it only if this PR needs no work package, then fix the map.");
        continue;
      }
      if (found?.map?.tracker && !/\bOP#\d+\b/.test(prBody(action.args, action.dir) ?? "")) {
        return { allow: false, reason: "tedy gate: this project tracks work in OpenProject, so every PR carries its work package as `--body \"OP#<id>\"`. No work package yet: stop, hand the task to the PM session (shared/handoff.md), and open the PR once it exists. A body file must already exist when the command runs." };
      }
      continue;
    }
    if (action.kind !== "github-write") {
      if (mentionsGhMerge(segment) || (commandTokens(segment)[0] !== "gh" && API_MERGE.test(segment) && /https?:\/\/|graphql/i.test(segment))) askFor(MERGE_REASON);
      continue;
    }
    if (action.pr && action.verbs.some((verb) => verb === "merge" || verb === "ready" || /^\$|`/.test(verb))) {
      askFor(MERGE_REASON);
      continue;
    }
    if (!gates.ghWrites) {
      if (action.verbs?.includes("api-pr-create")) askFor("tedy gate: opening a PR through `gh api` skips the draft and work-package checks. Use `gh pr create`, or allow this only if the user asked for it.");
      else if (action.unknown) askFor("tedy gate: this `gh` command is not one the gate knows, so it may be an alias that merges or publishes. Allow it only if the user asked for it.");
      continue;
    }
    if (/\bgh\s+(pr|issue)\s+(merge|close|reopen|ready|edit|lock|unlock)\b/.test(segment)) {
      return { allow: false, reason: "tedy gate: merging, closing or editing a PR or issue belongs to the user. Tell the user what is ready and let them do it." };
    }
    return { allow: false, reason: "tedy gate: publish to GitHub through github-write.mjs after the user approves the draft. Reading with gh (view, diff, list, GET, GraphQL queries) stays open." };
  }
  return rewrite ?? asked ?? { allow: true };
}

function batchCommands(commands) {
  let list = commands;
  if (typeof list === "string") {
    if (!list.trim()) return null;
    try {
      list = JSON.parse(list);
    } catch {
      list = [list];
    }
    if (!Array.isArray(list)) list = [commands];
  }
  if (!Array.isArray(list) || !list.length) return null;
  const read = list.map((item) => (typeof item === "string" ? item : item?.command));
  return read.every((command) => typeof command === "string") ? read : null;
}

export function bashInputs(input) {
  const tool = String(input.tool_name ?? "").match(CTX_TOOL)?.[1];
  if (!tool) return { inputs: [input] };
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object") return { malformed: "no tool input" };
  if (toolInput.cwd !== undefined && typeof toolInput.cwd !== "string") return { malformed: "`cwd` is not a string" };
  const cwd = toolInput.cwd === undefined ? input.cwd : resolve(input.cwd ?? process.cwd(), toolInput.cwd);
  const shell = (command) => ({ ...input, cwd, tool_input: { command } });
  if (tool === "batch_execute") {
    const commands = batchCommands(toolInput.commands);
    return commands ? { inputs: commands.map(shell) } : { malformed: "`commands` is not a non-empty list of commands" };
  }
  if (typeof toolInput.language !== "string" || typeof toolInput.code !== "string") return { malformed: "`language` or `code` is not a string" };
  if (toolInput.language === "shell") return { inputs: [shell(toolInput.code)] };
  if (CTX_LANGUAGES.has(toolInput.language)) return { inputs: [] };
  return { malformed: `language \`${toolInput.language.slice(0, 40)}\` is not one the gate knows` };
}

function judge(input) {
  const command = input.tool_input?.command ?? "";
  try {
    const gates = gateSwitches();
    let result = evaluate(command, input.cwd ?? process.cwd(), { gates, settingsFile: CLAUDE_SETTINGS });
    if (result.allow || result.ask) {
      const token = trackerToken(input.tool_input, trackerHost(), { cwd: input.cwd ?? process.cwd() });
      if (token) result = { allow: false, reason: token };
    }
    if ((result.allow || result.ask) && gates.publishQuote) {
      let quoted = null;
      try {
        quoted = checkQuoted(input);
      } catch (error) {
        if (result.allow) throw error;
      }
      if (quoted && (!quoted.ask || result.allow)) result = { allow: false, ...quoted };
    }
    if (!result.allow) logGate({ hook: "git-gate", decision: result.ask ? "ask" : "deny", tool: input.tool_name, command: command.slice(0, 200), cwd: input.cwd, reason: result.reason });
    return result;
  } catch (error) {
    logGate({ hook: "git-gate", decision: "ask", tool: input.tool_name, command: String(command).slice(0, 200), error: error.message });
    return { allow: false, ask: true, reason: PUBLISH.test(command) ? `tedy gate: could not check this publish command (${error.message}). Approve only if you have seen the exact draft.` : `tedy gate: could not check this command (${error.message}). Allow it only if the user asked for it.` };
  }
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  const { inputs, malformed } = bashInputs(input);
  if (malformed) {
    const reason = `tedy gate: could not read this context-mode call (${malformed}), so it is refused unchecked. Send shell code as \`code\` with \`language: "shell"\`, or batch commands as a list of \`{ label, command }\`.`;
    logGate({ hook: "git-gate", decision: "deny", tool: input.tool_name, cwd: input.cwd, reason });
    deny(reason);
    return;
  }
  const results = inputs.map(judge);
  const result = results.find((item) => !item.allow && !item.ask) ?? results.find((item) => item.ask);
  if (result?.ask) ask(result.reason);
  else if (result) deny(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
