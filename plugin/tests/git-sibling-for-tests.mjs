import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./temp-dir-for-tests.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

export function commitFile(dir, path, text, subject = `change ${path}`) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(dir, "add", path);
  git(dir, "commit", "-q", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

export function siblingRepo() {
  const root = tempDir("tedy-sibling-");
  const upstream = join(root, "upstream");
  git(root, "init", "-q", "-b", "dev", upstream);
  commitFile(upstream, "src/a.ts", "a1\n");
  commitFile(upstream, "src/b.ts", "b1\n");
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", upstream, origin);
  git(upstream, "remote", "add", "origin", origin);
  const clone = join(root, "backend");
  git(root, "clone", "-q", origin, clone);
  const push = (path, text, subject) => {
    const sha = commitFile(upstream, path, text, subject);
    git(upstream, "push", "-q", "origin", "dev");
    return sha;
  };
  return { root, upstream, clone, push };
}
