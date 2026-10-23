import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const GIT_TIMEOUT_MS = 60_000;
export const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";
const NAME_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}_.-])";
const NAME_AFTER = "(?![\\p{L}\\p{N}\\p{M}_-]|\\.[\\p{L}\\p{N}])";

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

export function namedIn(texts, path) {
  const base = path.split("/").pop();
  const name = (base.includes(".") ? base : path).normalize("NFC");
  const pattern = new RegExp(`${NAME_BEFORE}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${NAME_AFTER}`, "u");
  return texts.some((text) => readings(text).some((candidate) => pattern.test(candidate)));
}

export const branchTokens = (text) => unique([...text.matchAll(/@(\w[\w./-]*)/g)].map((match) => match[1].replace(/[./-]+$/, "")));

export const runGit = (dir, args) => execFileSync("git", ["--literal-pathspecs", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }).trim();

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

const gitReason = (error) => (error.code === "ETIMEDOUT" ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : (error.stderr?.toString().trim() || error.message).split("\n")[0]);

const branchPin = (repo, branch, sha) => ({ kind: "git", repo: repo.name, ref: `origin/${branch}`, remote: `refs/heads/${branch}`, local: `refs/remotes/origin/${branch}`, sha });

const remoteOf = (pin) => pin.remote ?? `refs/heads/${pin.ref.replace(/^origin\//, "")}`;

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

export function pinRepos(repos, text, git = runGit) {
  const tokens = branchTokens(text);
  const pins = [];
  const problems = [];
  for (const repo of repos) {
    if (!repo.branches.length) {
      problems.push(`${repo.name} has no branch in the project map and origin/HEAD is unset; set its branch in the map or run git -C ${repo.dir} remote set-head origin --auto`);
      continue;
    }
    let found = false;
    let failed = false;
    for (const branch of unique([...repo.branches, ...tokens])) {
      try {
        const sha = remoteTip(git, repo.dir, `refs/heads/${branch}`);
        if (!sha) continue;
        pins.push(takeTip(git, repo.dir, branchPin(repo, branch, sha)));
        found ||= repo.branches.includes(branch);
      } catch (error) {
        problems.push(`cannot pin ${repo.name} origin/${branch}: ${gitReason(error)}`);
        failed = true;
        break;
      }
    }
    if (!found && !failed) problems.push(`${repo.name} has no ${repo.branches.map((branch) => `origin/${branch}`).join(" or ")}; fix the branch in the project map or fetch the repo`);
  }
  return { pins, problems };
}

const realPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function pinPullHead(pr, repos, git = runGit) {
  let top;
  try {
    top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  } catch {
    return { pins: [], problems: [`cannot pin the head of PR #${pr}: ${process.cwd()} is not inside the reviewed repository; run from its checkout`] };
  }
  const name = repos.find((repo) => realPath(repo.dir) === realPath(top))?.name ?? top;
  const pin = { kind: "git", repo: name, dir: top, pr: Number(pr), ref: `pull/${pr}/head`, remote: `refs/pull/${pr}/head`, local: `refs/pr/${pr}` };
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

function recheckRepo(pin, dir, texts, git) {
  const remote = remoteOf(pin);
  const now = remoteTip(git, dir, remote);
  if (!now) return { refusal: `refused: ${pin.repo} ${pin.ref} no longer exists on origin; ${RECHECK}` };
  if (now === pin.sha) return {};
  fetchCommit(git, dir, remote, now);
  if (!hasCommit(git, dir, pin.sha)) return { refusal: `refused: ${pin.repo} ${pin.ref}: the pinned commit ${pin.sha.slice(0, 8)} is not in the clone, so what changed cannot be listed; fetch it or lint again, then ask the user again` };
  const moved = `${pin.repo} ${pin.ref} moved from ${pin.sha.slice(0, 8)} to ${now.slice(0, 8)} since it was pinned`;
  if (pin.pr) return { refusal: [`refused: ${moved}, so the PR under review changed`, ...commitLines(git, dir, pin.sha, now, []), `  ${RECHECK}`].join("\n") };
  const named = changedPaths(git, dir, pin.sha, now).filter((path) => namedIn(texts, path));
  if (!named.length) return { notice: `notice: ${moved}; no changed file is named in the text being posted, so it posts as drafted` };
  return { refusal: [`refused: ${moved} and changed a file the text being posted names`, `  files: ${named.join(", ")}`, ...commitLines(git, dir, pin.sha, now, named), `  ${RECHECK}`].join("\n") };
}

export function recheckRepos(pins, repos, texts, git = runGit) {
  const refusals = [];
  const notices = [];
  for (const pin of pins.filter((candidate) => candidate.kind === "git")) {
    const dir = pin.dir ?? repos.find((candidate) => candidate.name === pin.repo)?.dir;
    if (!dir) {
      refusals.push(`refused: ${pin.repo} is pinned but the project map no longer lists it; ${RECHECK}`);
      continue;
    }
    let verdict;
    try {
      verdict = recheckRepo(pin, dir, texts, git);
    } catch (error) {
      verdict = { refusal: `refused: ${pin.repo} ${pin.ref} could not be rechecked (${gitReason(error)}); fetch it, then publish again` };
    }
    if (verdict.refusal) refusals.push(verdict.refusal);
    if (verdict.notice) notices.push(verdict.notice);
  }
  return { refusals, notices };
}
