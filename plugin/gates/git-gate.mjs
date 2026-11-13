import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_GATES_ON, ask, deny, gateSwitches, logGate, readHookInput } from "../lib/hook-io.mjs";
import { CLAUDE_SETTINGS, KIT_PUBLISH_APPLY_VERBS, KIT_PUBLISH_WRITE_VERBS } from "../lib/publish-approval-settings.mjs";
import { batchSummary, itemCommand, parseArgs, readBatch, shownSummary, SHOWS_REFUSAL } from "../lib/publish-batch.mjs";
import { resolveMap } from "../lib/project-map.mjs";
import { shellWords, splitSegments, substitutions, tokenize, walkCommands } from "../lib/shell-segments.mjs";
import { INTERPRETER, SHELLS, readsUnreadableCode, redirectLength, scriptOperand, variableScriptArguments, withoutRedirects } from "../lib/shell-program-arguments.mjs";
import { check as checkQuoted } from "./publish-quote-gate.mjs";
import { evaluate as trackerToken, trackerHost } from "./tracker-token-gate.mjs";

export { splitSegments, tokenize };

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "grep", "fetch", "rev-parse", "branch", "ls-files", "remote", "describe", "blame", "reflog"]);
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
  ["setsid", []],
  ["flock", ["-w", "--timeout", "-E", "--conflict-exit-code"]],
  ["npx", ["-p", "--package"]],
]);
const WRAPPER_ARGUMENTS = new Map([["timeout", 1], ["flock", 1]]);
const LOCAL_RUNNERS = new Set(["find", "script", "busybox"]);
const KIT_SCRIPTS = ["github-write.mjs", "openproject.mjs", "figma-comments.mjs", "gdoc-comments.mjs", "doc-comment-file.mjs", "publish-batch.mjs"];
const SEARCH_TOOLS = new Set(["rg", "grep", "egrep", "fgrep", "fd", "fdfind", "ag", "ack"]);
const SEARCH_EXEC = /^(?:-x|-X|--exec|--exec-batch|--pre|--pre-glob)(?:=|$)/;
export const DATA_PROGRAMS = new Set(["printf", "echo", "cat", "tee", "mkdir", "cp", "mv", "rm", "touch", "chmod", "cd", "true"]);
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/;
const SUDO_SHELL = /^(?:-[a-zA-Z]*[si]|--shell|--login)$/;
const PR_CREATE_VALUE_FLAGS = new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template"]);
const EVAL_WORDS = new Set(["eval", "source", ".", "alias", "function"]);
const NOT_LITERAL = /[$`(*?,{]|^\[(?!\[?$)|.}|[^[]\[/;
const RUNNERS = new Set(["env", "script", "ssh", "su", "runuser", "sg", "setsid", "flock", "watch", "parallel", "tmux", "screen", "expect", "unbuffer", "at", "batch", "chroot", "systemd-run", "nsenter", "unshare", "firejail", "bwrap"]);
const API_MERGE = /pulls\/\d+\/merge\b|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/;
const MAX_COMMAND = 10_000;
const REWRITE = "Rewrite it so every command word is literal: split it into plain commands, or put the code in a script file in the system temp directory (never inside the repository) with the Write tool and run it as `python3 <file>` or `node <file>`, with no eval, no `bash -c`, no heredoc code and no command word in a variable. Never put a git push, a merge or a GitHub write inside a script: run it as a plain command of its own so the gate can check it. The user is not asked, because they cannot check this form either.";
const UNREADABLE_REASON = `tedy gate: this command runs code the gate cannot read (a command word built at run time, eval, a shell or interpreter reading code from stdin, a heredoc, a pipe or a process substitution, a shell given -c, an interpreter one-liner that mentions gh, or git -c alias/core). ${REWRITE}`;
const MERGE_REASON = "tedy gate: merging or marking a PR ready belongs to the user. Allow it only if the user asked for this exact PR in this turn.";
const PUBLISH = /(?:github-write\.mjs["']?\s+(?:post|reply|edit|minimize|resolve|unresolve|pr-body)|openproject\.mjs["']?\s+apply|figma-comments\.mjs["']?\s+(?:post|reply|delete)|gdoc-comments\.mjs["']?\s+(?:reply|anchor|edit|delete))\b|^(?=[\s\S]*--apply\b)[\s\S]*?(?:openproject\.mjs["']?\s+(?:set|comment|comment-edit|relation|relation-delete|rollback)|doc-comment-file\.mjs["']?\s+post)\b|publish-batch\.mjs["']?\s[\s\S]*?--shows\b/;
export { CLAUDE_SETTINGS };
const REWRITING_PUSH = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--all|--prune|-d|--delete)$/;
export const CTX_TOOL = /__ctx_(execute|execute_file|batch_execute)$/;
const CTX_PUBLISH_REASON = "tedy gate: this publishes through a kit script from a context-mode tool, where the user's permission rules never ask. Run the publish as a plain Bash command of its own, so the permission rule asks the user before it goes out.";
const KIT_WRITER = /(?:github-write|openproject|figma-comments|gdoc-comments|doc-comment-file)\.mjs/;
const BATCH_SCRIPT = /publish-batch\.mjs/;
const KIT_VERB = new RegExp(`(?<![\\w-])(?:${[...new Set([...Object.values(KIT_PUBLISH_WRITE_VERBS), ...Object.values(KIT_PUBLISH_APPLY_VERBS)].flat())].join("|")})(?![\\w-])`);
const CTX_CODE_PUBLISH_REASON = "tedy gate: this context-mode code names a kit publish script with a write verb, and code in a language other than shell is not something the gate or the user's permission rules can read, so it would write with no prompt. It is refused. Run the publish as a plain Bash command of its own, `node <plugin>/scripts/<script>.mjs <verb> …`, so the permission rule asks the user before it writes.";
const CTX_LANGUAGES = new Set(["javascript", "typescript", "python", "ruby", "go", "rust", "php", "perl", "r", "elixir", "csharp"]);

function graphQuery(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = ["-f", "-F", "--field", "--raw-field"].includes(token) ? args[index + 1] : token.match(/^(?:-[fF]|--(?:raw-)?field=)(.*)$/)?.[1];
    if (value?.startsWith("query=")) return value.slice("query=".length);
  }
  return null;
}

const GH_API_VALUE_FLAGS = new Set(["-H", "--header", "-q", "--jq", "-t", "--template", "-p", "--preview", "--hostname", "--cache"]);

function classifyGitHubApi(args) {
  let method = null;
  let hasFields = false;
  let endpoint = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index].replace(/^-i+(?=[A-Za-z])/, "-");
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
    } else if (GH_API_VALUE_FLAGS.has(token)) {
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

function commandWords(segment, keep) {
  const { tokens, quoted } = strippedWords(segment, keep);
  return { tokens: tokens.length && tokens[0].includes("/") ? [basename(tokens[0]), ...tokens.slice(1)] : tokens, quoted };
}

export const commandTokens = (segment, keep) => commandWords(segment, keep).tokens;

function strippedWords(segment, keep = new Set()) {
  const quoted = [];
  const all = tokenize(segment, quoted);
  let at = 0;
  for (;;) {
    for (let skip = 1; skip; at += skip) {
      while (at < all.length && (ENV_ASSIGNMENT.test(all[at]) || /^[({!]+$/.test(all[at]))) at += 1;
      const before = all[at];
      if (at < all.length) all[at] = all[at].replace(/^[({!]+/, "");
      skip = redirectLength(all, at, before !== all[at], quoted);
    }
    const flags = keep.has(basename(all[at] ?? "")) ? undefined : WRAPPERS.get(basename(all[at] ?? ""));
    if (!flags) break;
    let positionals = WRAPPER_ARGUMENTS.get(basename(all[at])) ?? 0;
    at += 1;
    while (at < all.length) {
      if (ENV_ASSIGNMENT.test(all[at])) at += 1;
      else if (redirectLength(all, at, false, quoted)) at += redirectLength(all, at, false, quoted);
      else if (all[at].startsWith("-")) at += flags.includes(all[at]) ? 2 : 1;
      else if (positionals > 0) {
        positionals -= 1;
        at += 1;
      } else break;
    }
  }
  return { tokens: all.slice(at), quoted: quoted.slice(at) };
}

const strippedTokens = (segment, keep) => strippedWords(segment, keep).tokens;

function unreadable(segment, piped = false) {
  const tokens = strippedTokens(segment);
  const [word = "", ...args] = tokens;
  if (NOT_LITERAL.test(word) || EVAL_WORDS.has(word)) return true;
  const program = basename(word);
  if (/\$'[^']*\\/.test(segment)) return true;
  const raw = tokenize(segment);
  if (raw.some((token, index) => RUNNERS.has(basename(token)) && raw.slice(index + 1).some((arg) => /\s/.test(arg) && /\bgh\b|github/i.test(arg)))) return true;
  const carries = (token) => token.split(/\s+/).some((part) => ["git", "gh"].includes(basename(part)) || SHELLS.has(basename(part)) || INTERPRETER.test(basename(part)));
  if (LOCAL_RUNNERS.has(program) && (program !== "find" || args.some((arg) => FIND_EXEC.test(arg))) && args.some(carries)) return true;
  if (raw.some((token, index) => basename(token) === "flock" && raw.slice(index + 1).some((arg) => arg === "-c" || /^--command(=|$)/.test(arg)))) return true;
  if ((!word || /^\d*[<>]/.test(word)) && raw.some((token, index) => ["sudo", "doas"].includes(basename(token)) && raw.slice(index + 1).some((arg) => SUDO_SHELL.test(arg)))) return true;
  if (SHELLS.has(program)) return args.some((arg) => /^-[a-zA-Z]*[cs]/.test(arg) || arg === "<<<" || arg === "<") || readsUnreadableCode(program, args, piped);
  if (INTERPRETER.test(program) && readsUnreadableCode(program, args, piped)) return true;
  const variable = INTERPRETER.test(program) ? variableScriptArguments(program, args) : null;
  if (variable?.some((_, at) => KIT_SCRIPTS.some((name) => PUBLISH.test(`${name} ${variable.slice(at).join(" ")}`)))) return true;
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

function searchOnly(segment) {
  const [program, ...args] = commandTokens(segment);
  if (program === "git") return classify(segment, "/").kind === "read";
  return SEARCH_TOOLS.has(program) && !args.some((arg) => SEARCH_EXEC.test(arg));
}

export function kitScriptCall(segment) {
  const all = tokenize(segment);
  const tokens = strippedTokens(segment);
  const [word = "", ...args] = tokens;
  const program = basename(word);
  const viaXargs = all.slice(0, all.length - tokens.length).some((token) => basename(token) === "xargs");
  if (KIT_SCRIPTS.includes(program)) return { words: [program, ...args], viaXargs };
  if (!INTERPRETER.test(program)) return null;
  const { script, index } = scriptOperand(program, args);
  return script !== undefined && KIT_SCRIPTS.includes(basename(script)) ? { words: [basename(script), ...args.slice(index + 1)], viaXargs } : null;
}

function dataOnly(segment) {
  if (substitutions(segment)?.length !== 0) return false;
  const [word, ...args] = tokenize(segment);
  if (word === "printf") return !args.some((arg) => arg.startsWith("-v"));
  return DATA_PROGRAMS.has(word);
}

function xargsUnreadable(segment) {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((token) => basename(token) === "xargs");
  if (at === -1) return false;
  const rest = tokens.slice(at + 1);
  return rest.some((token) => /^--[^=]+$/.test(token)) && rest.some((token) => KIT_SCRIPTS.includes(basename(token)));
}

function runsPublish(segment) {
  const call = kitScriptCall(segment);
  return (call !== null && (call.viaXargs || PUBLISH.test(call.words.join(" ")))) || xargsUnreadable(segment);
}

export const dataOnlyCommand = (command) => splitSegments(command, false).every(dataOnly);

export function publishingSegments(command) {
  const segments = splitSegments(command, false);
  const data = segments.every(dataOnly);
  return segments.filter((segment) => runsPublish(segment) || (!data && PUBLISH.test(shellWords(segment)) && !searchOnly(segment)));
}

function uncoveredPublish(command, settingsFile) {
  let rules;
  for (const segment of publishingSegments(command)) {
    rules ??= loadAskRules(settingsFile);
    if (rules === null) return "tedy gate: could not read the ask rules; approve only if you have seen the exact draft.";
    if (!rules.some((glob) => globMatches(glob, segment))) return `tedy gate: no permission rule covers this publish (\`${segment.slice(0, 120)}\`); approve only if you have seen the exact draft.`;
  }
  return null;
}

export function hiddenPublish(command) {
  for (const segment of publishingSegments(command)) {
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
  const { tokens, quoted } = commandWords(segment);
  const [program, ...rest] = tokens;
  const args = withoutRedirects(rest, quoted.slice(1));
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

const BODY_FLAG = /^(?:(--body|--body-file)(?:=([\s\S]*))?|(-b|-F)=?([\s\S]*))$/;

const bodyFlag = (token) => {
  const match = token.match(BODY_FLAG);
  if (!match) return null;
  const name = match[1] ?? match[3];
  const value = match[1] ? match[2] : match[4] || undefined;
  return { file: name === "--body-file" || name === "-F", value };
};

function editsOnlyBody(tokens) {
  const flags = tokens.slice(tokens.indexOf("edit") + 1);
  let body = false;
  for (let index = 0; index < flags.length; index += 1) {
    if (!flags[index].startsWith("-")) continue;
    const flag = bodyFlag(flags[index]);
    if (!flag) return false;
    body = true;
    if (flag.value === undefined) index += 1;
  }
  return body;
}

export function prBody(args, dir) {
  let body = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = bodyFlag(args[index]);
    if (!flag) continue;
    const value = flag.value ?? args[index + 1];
    if (flag.value === undefined) index += 1;
    if (value === undefined) body = null;
    else if (!flag.file) body = value;
    else if (value === "-") body = null;
    else {
      try {
        body = readFileSync(resolve(dir, value), "utf8");
      } catch {
        body = null;
      }
    }
  }
  return body;
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
  if (command.length > MAX_COMMAND) return { allow: false, reason: `tedy gate: this command is longer than ${MAX_COMMAND} characters, too long to check. ${REWRITE}` };
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
  const { parts, tooDeep } = walkCommands(command, cwd);
  if (tooDeep) rewriteFor(`tedy gate: this command nests command substitutions too deeply to check. ${REWRITE}`);
  for (const { text: segment, piped, dir } of parts) {
    const action = classify(segment, dir);
    if (action.kind === "cd") continue;
    if (unreadable(segment, piped)) rewriteFor(UNREADABLE_REASON);
    const call = BATCH_SCRIPT.test(segment) ? kitScriptCall(segment) : null;
    if (call?.words[0] === "publish-batch.mjs") {
      const batch = batchVerdict(call.words.slice(1), dir, { gates, projectsDir, settingsFile });
      if (batch.allow) continue;
      if (!batch.ask) return batch;
      asked = { allow: false, ask: true, reason: asked ? `${batch.reason}\n${asked.reason}` : batch.reason };
      continue;
    }
    if (action.kind === "push") {
      const risk = pushRisk(action.args, action.dir, gates.pushExempt);
      if (risk) askFor(`tedy gate: ${risk}, which belongs to the user. Allow it only if the user asked for this push.`);
      continue;
    }
    const workPackageCheck = (args, dir, verb) => {
      let found;
      try {
        found = projectsDir ? resolveMap(dir, projectsDir) : resolveMap(dir);
      } catch {
        askFor(`tedy gate: a project map could not be read, so the work-package check for this PR ${verb} did not run. Allow it only if this PR needs no work package, then fix the map.`);
        return null;
      }
      const body = found?.map?.tracker ? (prBody(args, dir) ?? "") : "";
      if (found?.map?.tracker && !/\bOP#\d+\b/.test(body) && !/^OP#none:[ \t]*\S/.test(body)) {
        return { allow: false, reason: `tedy gate: this project tracks work in OpenProject, so every PR body carries its work package as \`OP#<id>\`, and this ${verb} would leave it out. No work package yet: stop, ask the user whether to run /tedy:pm for one, and open or edit the PR once it exists. When the user chooses no work package, the body's first line is \`OP#none: <reason>\`. A body file must already exist when the command runs.` };
      }
      return null;
    };
    if (action.kind === "pr-create") {
      if (gates.draftPrOnly && !isDraft(action.args)) return { allow: false, reason: "tedy gate: open the PR as a draft with `--draft`; the user marks it ready." };
      const refusal = workPackageCheck(action.args, action.dir, "create");
      if (refusal) return refusal;
      continue;
    }
    if (action.kind === "github-write" && action.pr && action.verbs.length === 1 && action.verbs[0] === "edit") {
      const tokens = tokenize(segment);
      if (tokens.some((token) => BODY_FLAG.test(token))) {
        const refusal = workPackageCheck(tokens, action.dir, "body edit");
        if (refusal) return refusal;
      }
    }
    if (action.kind !== "github-write") {
      if (mentionsGhMerge(segment) || (commandTokens(segment)[0] !== "gh" && API_MERGE.test(shellWords(segment)) && /https?:\/\/|graphql/i.test(segment))) askFor(MERGE_REASON);
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
    if (action.pr && action.verbs.length === 1 && action.verbs[0] === "close") {
      const tokens = tokenize(segment);
      if (tokens.some((token) => token === "-c" || /^-c./.test(token) || token.startsWith("--comment"))) askFor("tedy gate: closing this PR also posts a comment under the user's name. Allow it only if the user approved that text.");
      else if (tokens.some((token) => token === "-d" || token === "--delete-branch")) askFor("tedy gate: closing this PR also deletes its branch. Allow it only if the user asked for that.");
      continue;
    }
    if (action.pr && action.verbs.length === 1 && action.verbs[0] === "edit" && editsOnlyBody(tokenize(segment))) continue;
    if (/\bgh\s+(pr|issue)\s+(merge|close|reopen|ready|edit|lock|unlock)\b/.test(shellWords(segment))) {
      return { allow: false, reason: "tedy gate: merging, closing or editing a PR or issue belongs to the user. Tell the user what is ready and let them do it." };
    }
    return { allow: false, reason: "tedy gate: publish to GitHub through github-write.mjs after the user approves the draft. Reading with gh (view, diff, list, GET, GraphQL queries) stays open." };
  }
  return rewrite ?? asked ?? { allow: true };
}

function batchVerdict(words, dir, options) {
  const { positional, flags } = parseArgs(words);
  const shows = shownSummary(words);
  const [file] = positional;
  if (shows === null && flags.summary === true) return { allow: true };
  let items;
  try {
    if (!file) throw new Error("no batch file was named");
    items = readBatch(resolve(dir, file));
  } catch (error) {
    return { allow: false, reason: `tedy gate: refused by publish-batch: ${error.message}; nothing was written.` };
  }
  for (const [index, item] of items.entries()) {
    const verdict = evaluate(itemCommand(item), dir, options);
    if (!verdict.allow && !verdict.ask) return { allow: false, reason: `tedy gate: refused by publish-batch: item ${index + 1}: ${verdict.reason}` };
  }
  const summary = batchSummary(items, dir);
  if (shows !== summary) return { allow: false, reason: `tedy gate: refused by publish-batch: ${SHOWS_REFUSAL}; nothing was written.` };
  return { allow: false, ask: true, reason: summary };
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
  if (input.tool_name === "Monitor") return { inputs: [{ ...input, tool_name: "Bash" }] };
  const tool = String(input.tool_name ?? "").match(CTX_TOOL)?.[1];
  if (!tool) return { inputs: [input] };
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object") return { malformed: "no tool input" };
  const own = tool === "execute_file" ? undefined : toolInput.cwd;
  if (own !== undefined && typeof own !== "string") return { malformed: "`cwd` is not a string" };
  if (own !== undefined && !isAbsolute(own)) return { malformed: "`cwd` is relative, and context-mode resolves it against its own install directory, which the gate cannot see; pass an absolute `cwd`" };
  const cwd = own ?? process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const shell = (command) => ({ ...input, tool_name: "Bash", cwd, tool_input: { command } });
  if (tool === "batch_execute") {
    const commands = batchCommands(toolInput.commands);
    return commands ? { inputs: commands.map(shell) } : { malformed: "`commands` is not a non-empty list of commands" };
  }
  if (typeof toolInput.language !== "string" || typeof toolInput.code !== "string") return { malformed: "`language` or `code` is not a string" };
  if (toolInput.language === "shell") return { inputs: [shell(toolInput.code)] };
  if ((KIT_WRITER.test(toolInput.code) && KIT_VERB.test(toolInput.code)) || BATCH_SCRIPT.test(toolInput.code)) return { refused: CTX_CODE_PUBLISH_REASON };
  if (CTX_LANGUAGES.has(toolInput.language)) return { inputs: [] };
  return { malformed: `language \`${toolInput.language.slice(0, 40)}\` is not one the gate knows` };
}

function judge(input, tool) {
  const command = input.tool_input?.command ?? "";
  const gates = gateSwitches();
  try {
    let result = CTX_TOOL.test(tool) && publishingSegments(command).length ? { allow: false, reason: CTX_PUBLISH_REASON } : evaluate(command, input.cwd ?? process.cwd(), { gates, settingsFile: CLAUDE_SETTINGS });
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
    if (!result.allow) logGate({ hook: "git-gate", decision: result.ask ? "ask" : "deny", tool, command: command.slice(0, 200), cwd: input.cwd, reason: result.reason });
    return result;
  } catch (error) {
    return checkFailed(command, tool, error);
  }
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

export function checkFailed(command, tool, error) {
  const message = errorText(error);
  let text;
  let publish;
  try {
    text = String(command);
    publish = publishingSegments(text).length > 0;
  } catch (unreadableError) {
    logGate({ hook: "git-gate", decision: "deny", tool, error: `${message}; ${errorText(unreadableError)}` });
    return { allow: false, reason: `tedy gate: could not read this command (${errorText(unreadableError)}), so it is refused unchecked. ${REWRITE}` };
  }
  logGate({ hook: "git-gate", decision: "ask", tool, command: text.slice(0, 200), error: message });
  return { allow: false, ask: true, reason: publish ? `tedy gate: could not check this publish command (${message}). Approve only if you have seen the exact draft.` : `tedy gate: could not check this command (${message}). Allow it only if the user asked for it.` };
}

export function run() {
  const input = readHookInput({ askOnFailure: true });
  const { inputs, malformed, refused } = bashInputs(input);
  if (refused) {
    logGate({ hook: "git-gate", decision: "deny", tool: input.tool_name, cwd: input.cwd, reason: refused });
    deny(refused);
    return;
  }
  if (malformed) {
    const reason = `tedy gate: could not read this context-mode call (${malformed}), so it is refused unchecked. Send shell code as \`code\` with \`language: "shell"\`, or batch commands as a list of \`{ label, command }\`.`;
    logGate({ hook: "git-gate", decision: "deny", tool: input.tool_name, cwd: input.cwd, reason });
    deny(reason);
    return;
  }
  const results = inputs.map((item) => judge(item, String(input.tool_name ?? "")));
  const result = results.find((item) => !item.allow && !item.ask) ?? results.find((item) => item.ask);
  if (result?.ask) ask(result.reason);
  else if (result) deny(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
