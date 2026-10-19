import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommits } from "../lib/prior-art.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const env = { ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@users.noreply.github.com", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@users.noreply.github.com" };
const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8", env });

function repoWithTag() {
  const repo = tempDir("tedy-trailer-");
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  mkdirSync(join(repo, "docs", "prior-art"), { recursive: true });
  writeFileSync(join(repo, "docs", "adr", "0009-fact-based-ablation-evals.md"), "# 0009\n");
  writeFileSync(join(repo, "docs", "prior-art", "superpowers.md"), "# card\n");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "build: release 0.0.1");
  git(repo, "tag", "v0.0.1");
  return repo;
}

const commit = (repo, message) => git(repo, "commit", "-q", "--allow-empty", "-m", message);
const errorsFor = (message) => {
  const repo = repoWithTag();
  commit(repo, message);
  return checkCommits(repo).map((problem) => problem.error);
};

test("an empty range since the latest tag passes", () => {
  assert.deepEqual(checkCommits(repoWithTag()), []);
});

test("a repository without a tag fails loudly", () => {
  const repo = tempDir("tedy-trailer-untagged-");
  git(repo, "init", "-q");
  commit(repo, "feat: x");
  assert.match(checkCommits(repo)[0].error, /no tag/);
});

test("a non-version tag after the release tag does not shrink the checked range", () => {
  const repo = repoWithTag();
  commit(repo, "feat: add x");
  git(repo, "tag", "pre-split");
  commit(repo, "build: y");
  assert.match(checkCommits(repo).map((problem) => problem.error).join("\n"), /feat: add x: no ADR: or Prior-art: trailer/);
});

test("feat and fix commits need an ADR or Prior-art trailer; other types do not", () => {
  assert.match(errorsFor("feat: add x").join("\n"), /no ADR: or Prior-art: trailer/);
  assert.match(errorsFor("fix(gate)!: block y").join("\n"), /no ADR: or Prior-art: trailer/);
  assert.deepEqual(errorsFor("build: release 0.0.2"), []);
  assert.deepEqual(errorsFor("test: cover z"), []);
});

test("ADR, card, URL and none-with-two-channels trailers pass", () => {
  assert.deepEqual(errorsFor("feat: x\n\nADR: 0009"), []);
  assert.deepEqual(errorsFor("feat: x\n\nPrior-art: superpowers"), []);
  assert.deepEqual(errorsFor("feat: x\n\nPrior-art: https://github.com/o/r/issues/3"), []);
  assert.deepEqual(errorsFor('feat: x\n\nPrior-art: none (github: "adr template"; x: "prior art adr")'), []);
});

test("n/a is allowed for fix only, with a reason", () => {
  assert.deepEqual(errorsFor("fix(x)!: y\n\nPrior-art: n/a (off-by-one in our own parser)"), []);
  assert.match(errorsFor("feat: y\n\nPrior-art: n/a (internal)").join("\n"), /n\/a is for fix commits only/);
  assert.match(errorsFor("fix: y\n\nPrior-art: n/a ()").join("\n"), /invalid Prior-art/);
});

test("a trailer naming a missing ADR or card, or none with one channel, fails", () => {
  assert.match(errorsFor("feat: x\n\nADR: 0099").join("\n"), /ADR 0099 not found/);
  assert.match(errorsFor("feat: x\n\nPrior-art: nowhere").join("\n"), /card "nowhere" not found/);
  assert.match(errorsFor('feat: x\n\nPrior-art: none (github: "a")').join("\n"), /at least two channels/);
});

test("the kit's own commits since its latest tag carry their trailers", () => {
  assert.deepEqual(checkCommits(REPO), []);
});
