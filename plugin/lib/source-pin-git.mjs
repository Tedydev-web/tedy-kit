import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const GIT_TIMEOUT_MS = 60_000;
const GIT_BUFFER = 64 * 1024 * 1024;
export const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";
const NAME_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}_.-])";
const NAME_AFTER = "(?![\\p{L}\\p{N}\\p{M}_-]|\\.[\\p{L}\\p{N}])";
const FOLDER = /(?<![\p{L}\p{N}\p{M}_.\/-])(\/?(?:[\p{L}\p{N}\p{M}_.-]+\/)+)(?=$|[\s`'"()<>,;:!?*_]|\.(?![\p{L}\p{N}]))/gu;
const TREE_LINK = /\/tree\/([^\s?#)"'`<>]+)/g;
const execFileAsync = promisify(execFile);

const unique = (list) => [...new Set(list)];

const decodeRuns = (text) =>
  text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

const readings = (text) => {
  const unescaped = text.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
  const plain = unescaped.replace(/(^|[^\p{L}\p{N}_])[_*]+(?=[\p{L}\p{N}])/gu, "$1").replace(/(?<=[\p{L}\p{N}])[_*]+(?=[^\p{L}\p{N}_]|$)/gu, "");
  return unique([text, unescaped, plain].flatMap((candidate) => [candidate, decodeRuns(candidate)])).map((candidate) => candidate.normalize("NFC"));
};

const folderPrefixes = (folder, roots) => {
  const plain = folder.replace(/^(?:\.\/)+/, "").toLowerCase();
  const sibling = plain.replace(/^(?:\.\.\/)+[^/]+\//, "");
  const rooted = [plain, sibling].flatMap((form) => roots.filter((root) => form.startsWith(root)).map((root) => form.slice(root.length)));
  return unique([plain, plain.replace(/^\/+/, ""), sibling, ...rooted]).filter(Boolean);
};

const treeFolders = (candidate) =>
  [...candidate.matchAll(TREE_LINK)].flatMap((match) => {
    const segments = match[1].replace(/[.,;:!?]+$/, "").split("/").filter(Boolean);
    return segments.slice(1).map((_, cut) => `${segments.slice(cut + 1).join("/")}/`);
  });

const underFolder = (candidate, path, roots) =>
  [...[...candidate.matchAll(FOLDER)].map((match) => match[1]), ...treeFolders(candidate)].some((folder) =>
    folderPrefixes(folder, roots).some((prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`)),
  );

export function namedIn(texts, path, roots = []) {
  const base = path.split("/").pop();
  const name = (base.includes(".") || /\p{Lu}/u.test(base) ? base : path).normalize("NFC");
  const pattern = new RegExp(`${NAME_BEFORE}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${NAME_AFTER}`, "iu");
  const lower = path.normalize("NFC").toLowerCase();
  const prefixes = unique(roots.map((root) => `${root.replace(/\/+$/, "")}/`.toLowerCase()));
  return texts.some((text) => readings(text).some((candidate) => pattern.test(candidate) || underFolder(candidate, lower, prefixes)));
}

const rootsOf = (pin, dir) => [...(pin.repo === "." ? [] : [pin.repo]), basename(dir), dir, realPath(dir)];

export const branchTokens = (text) => unique([...text.matchAll(/:\d+(?:[-,]\d+)*@(\w[\w./-]*)/g)].map((match) => match[1].replace(/[./-]+$/, "")));

const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

function sshCommand(dir) {
  if (process.env.GIT_SSH_COMMAND) return process.env.GIT_SSH_COMMAND;
  try {
    return execFileSync("git", ["-C", dir, "config", "--get", "core.sshCommand"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS }).trim() || "ssh";
  } catch {
    return "ssh";
  }
}

const networkEnv = (dir) => ({ ...gitEnv(), GIT_SSH_COMMAND: `${sshCommand(dir)} -o BatchMode=yes` });

export const runGit = (dir, args) => execFileSync("git", ["--literal-pathspecs", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER, env: ["fetch", "ls-remote"].includes(args[0]) ? networkEnv(dir) : gitEnv() }).trim();

async function lsRemote(dir, args) {
  const { stdout } = await execFileAsync("git", ["-C", dir, "ls-remote", ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER, env: networkEnv(dir) });
  return new Map(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").reverse()),
  );
}

export async function lsRemoteHeads(dir) {
  return new Map([...(await lsRemote(dir, ["--heads", "origin"]))].map(([ref, sha]) => [ref.replace(/^refs\/heads\//, ""), sha]));
}

export async function remoteTips(dir, refs) {
  const found = await lsRemote(dir, ["origin", ...refs]);
  return new Map(refs.map((ref) => [ref, found.get(ref) ?? null]));
}

function originHead(dir, git) {
  try {
    return git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    return null;
  }
}

export const mapRepos = (map, git = runGit) =>
  (map?.repos ?? []).map((repo) => {
    const dir = isAbsolute(repo.path) ? repo.path : resolve(map.paths?.[0] ?? process.cwd(), repo.path);
    const head = repo.branch ? null : originHead(dir, git);
    return { name: repo.path, dir, branches: repo.branch ? [repo.branch] : head ? [head] : [] };
  });

const gitReason = (error) => (error.code === "ETIMEDOUT" || error.killed ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : (error.stderr?.toString().trim() || error.message).split("\n")[0]);

const branchPin = (repo, branch, sha) => ({ kind: "git", repo: repo.name, ref: `origin/${branch}`, remote: `refs/heads/${branch}`, local: `refs/remotes/origin/${branch}`, sha });

const remoteOf = (pin) => pin.remote ?? `refs/heads/${pin.ref.replace(/^origin\//, "")}`;

export const tipKey = (pin) => `${pin.repo}\0${remoteOf(pin)}`;

function remoteTip(git, dir, ref) {
  const line = git(dir, ["ls-remote", "origin", ref]).split("\n").find((entry) => entry.split("\t")[1] === ref);
  return line ? line.split("\t")[0] : null;
}

function hasCommit(git, dir, sha) {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function fetchCommit(git, dir, remote, sha) {
  if (hasCommit(git, dir, sha)) return;
  git(dir, ["fetch", "-q", "origin", remote]);
  git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
}

function takeTip(git, dir, pin) {
  fetchCommit(git, dir, pin.remote, pin.sha);
  git(dir, ["update-ref", pin.local, pin.sha]);
  return pin;
}

function askedBranches(repos, extra) {
  const asked = new Map(repos.map((repo) => [repo.name, []]));
  const problems = [];
  for (const item of extra) {
    const at = item.lastIndexOf(":");
    if (at <= 0 || at === item.length - 1) {
      problems.push(`--branch ${item} is not <repo>:<branch>, such as ${repos[0]?.name ?? "../backend"}:feature/x`);
      continue;
    }
    const name = item.slice(0, at);
    if (!asked.has(name)) {
      problems.push(`--branch ${item} names ${name}, which is not a repo in the project map; use the repo path as the map writes it, such as ${repos.map((repo) => repo.name).join(", ") || "../backend"}`);
      continue;
    }
    asked.get(name).push(item.slice(at + 1));
  }
  return { asked, problems };
}

async function pinRepo(repo, asked, tokens, heads, git) {
  if (repo.reviewed && !asked.length && !tokens.length) return { pins: [], problems: [] };
  if (!repo.reviewed && !repo.branches.length) return { pins: [], problems: [`${repo.name} has no branch in the project map and origin/HEAD is unset; set its branch in the map or run git -C ${repo.dir} remote set-head origin --auto`] };
  let tips;
  try {
    tips = await heads(repo.dir);
  } catch (error) {
    return { pins: [], problems: [`cannot pin ${repo.name}: its origin cannot be reached (${gitReason(error)}); check the network and git -C ${repo.dir} remote -v, or fix the repo path in the project map`] };
  }
  const problems = asked.filter((branch) => !tips.has(branch)).map((branch) => `--branch ${repo.name}:${branch}: origin of ${repo.name} has no branch ${branch}`);
  if (!repo.reviewed && !repo.branches.some((branch) => tips.has(branch))) problems.push(`${repo.name} has no ${repo.branches.map((branch) => `origin/${branch}`).join(" or ")}; fix the branch in the project map or fetch the repo`);
  const pins = [];
  for (const branch of unique([...(repo.reviewed ? [] : repo.branches), ...asked, ...tokens]).filter((candidate) => tips.has(candidate))) {
    try {
      pins.push(takeTip(git, repo.dir, branchPin(repo, branch, tips.get(branch))));
    } catch (error) {
      problems.push(`cannot pin ${repo.name} origin/${branch}: ${gitReason(error)}`);
      break;
    }
  }
  return { pins, problems };
}

export async function pinRepos(repos, text, { extra = [], reviewed, heads = lsRemoteHeads, git = runGit } = {}) {
  const tokens = branchTokens(text);
  const { asked, problems } = askedBranches(repos, extra);
  const results = await Promise.all(repos.map((repo) => pinRepo({ ...repo, reviewed: repo.name === reviewed }, asked.get(repo.name), tokens, heads, git)));
  return { pins: results.flatMap((result) => result.pins), problems: [...problems, ...results.flatMap((result) => result.problems)] };
}

export function repoSlug(url) {
  const match = url.trim().replace(/\/+$/, "").replace(/\.git$/, "").match(/([^/:]+)\/([^/:]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function pinPullHead(pr, repos, { repo } = {}, git = runGit) {
  let top;
  try {
    top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  } catch {
    return { pins: [], problems: [`cannot pin the head of PR #${pr}: ${process.cwd()} is not inside the reviewed repository; run from its checkout`] };
  }
  const name = repos.find((candidate) => realPath(candidate.dir) === realPath(top))?.name ?? top;
  let url;
  try {
    url = git(top, ["remote", "get-url", "origin"]);
  } catch (error) {
    return { pins: [], problems: [`cannot pin the head of PR #${pr}: ${top} has no origin (${gitReason(error)})`] };
  }
  const github = repoSlug(url);
  if (repo !== undefined && github?.toLowerCase() !== repo.toLowerCase()) return { pins: [], problems: [`cannot pin the head of PR #${pr}: --repo ${repo} is not the repository checked out at ${top}, whose origin is ${url}; run from the checkout of ${repo}`] };
  const pin = { kind: "git", repo: name, dir: top, github, pr: Number(pr), ref: `pull/${pr}/head`, remote: `refs/pull/${pr}/head`, local: `refs/pr/${pr}` };
  try {
    const sha = remoteTip(git, top, pin.remote);
    if (!sha) return { pins: [], problems: [`cannot pin the head of PR #${pr}: origin of ${name} has no ${pin.remote}`] };
    return { pins: [takeTip(git, top, { ...pin, sha })], problems: [] };
  } catch (error) {
    return { pins: [], problems: [`cannot pin the head of PR #${pr}: ${gitReason(error)}`] };
  }
}

function changedPaths(git, dir, from, to) {
  const fields = git(dir, ["diff", "--name-status", "--no-renames", "-z", from, to]).split("\0");
  const paths = [];
  for (let index = 1; index < fields.length; index += 2) if (fields[index]) paths.push(fields[index]);
  return paths;
}

const commitLines = (git, dir, from, to, paths) => git(dir, ["log", "--format=%h %s", `${from}..${to}`, "--", ...paths]).split("\n").filter(Boolean).map((line) => `  commit ${line}`);

function recheckRepo(pin, dir, texts, git, now) {
  const remote = remoteOf(pin);
  if (!now) return { refusal: `refused: ${pin.repo} ${pin.ref} no longer exists on origin; ${RECHECK}` };
  if (now === pin.sha) return {};
  fetchCommit(git, dir, remote, now);
  if (!hasCommit(git, dir, pin.sha)) return { refusal: `refused: ${pin.repo} ${pin.ref}: the pinned commit ${pin.sha.slice(0, 8)} is not in the clone, so what changed cannot be listed; fetch it or lint again, then ask the user again` };
  const moved = `${pin.repo} ${pin.ref} moved from ${pin.sha.slice(0, 8)} to ${now.slice(0, 8)} since it was pinned`;
  if (pin.pr) return { refusal: [`refused: ${moved}, so the PR under review changed`, ...commitLines(git, dir, pin.sha, now, []), `  ${RECHECK}`].join("\n") };
  const named = changedPaths(git, dir, pin.sha, now).filter((path) => namedIn(texts, path, rootsOf(pin, dir)));
  if (!named.length) return { notice: `notice: ${moved}; no changed file is named in the text being posted, so it posts as drafted` };
  return { refusal: [`refused: ${moved} and changed a file the text being posted names`, `  files: ${named.join(", ")}`, ...commitLines(git, dir, pin.sha, now, named), `  ${RECHECK}`].join("\n") };
}

export async function recheckRepos(pins, repos, texts, git = runGit, { tips = new Map(), ask = remoteTips } = {}) {
  const located = pins.filter((candidate) => candidate.kind === "git").map((pin) => ({ pin, dir: pin.dir ?? repos.find((candidate) => candidate.name === pin.repo)?.dir }));
  const answers = new Map(
    await Promise.all(
      unique(located.flatMap(({ dir }) => (dir ? [dir] : []))).map(async (dir) => {
        const refs = unique(located.filter((entry) => entry.dir === dir && !tips.has(tipKey(entry.pin))).map((entry) => remoteOf(entry.pin)));
        try {
          return [dir, refs.length ? await ask(dir, refs) : new Map()];
        } catch (error) {
          return [dir, error];
        }
      }),
    ),
  );
  const refusals = [];
  const notices = [];
  for (const { pin, dir } of located) {
    if (!dir) {
      refusals.push(`refused: ${pin.repo} is pinned but the project map no longer lists it; ${RECHECK}`);
      continue;
    }
    let verdict;
    try {
      const answer = answers.get(dir);
      if (answer instanceof Error) throw answer;
      verdict = recheckRepo(pin, dir, texts, git, tips.has(tipKey(pin)) ? tips.get(tipKey(pin)) : answer.get(remoteOf(pin)));
    } catch (error) {
      verdict = { refusal: `refused: ${pin.repo} ${pin.ref} could not be rechecked (${gitReason(error)}); fetch it, then publish again` };
    }
    if (verdict.refusal) refusals.push(verdict.refusal);
    if (verdict.notice) notices.push(verdict.notice);
  }
  return { refusals, notices };
}
