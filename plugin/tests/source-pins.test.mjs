import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cites, linkedDocs, mapRepos, pinnedSources, pinRepos, recheckRepos, runGit, sourcesPath, versionCheck, writeSources } from "../lib/source-pins.mjs";
import { git, siblingRepo } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const repoOf = (clone) => [{ name: "../backend", dir: clone, branch: "dev" }];

test("cites reads every backticked path:line@branch whole, ranges included, and skips the placeholder", () => {
  const text = "Writer `src/a.ts:12@dev`, guard `src/b.ts:3-9@dev`. Again `src/a.ts:40@dev`; contract (`lib/x.sol:5@feature/v2`) and `path:line@branch`.";
  assert.deepEqual(cites(text), [
    { path: "src/a.ts", branch: "dev" },
    { path: "src/b.ts", branch: "dev" },
    { path: "lib/x.sol", branch: "feature/v2" },
  ]);
  const odd = "`app/(auth)/login/page.tsx:12@dev`, `pages/users/[id].tsx:5@dev`, `src/@types/user.d.ts:3@dev` and `internal/wallet service.go:3-4@dev`";
  assert.deepEqual(cites(odd), [
    { path: "app/(auth)/login/page.tsx", branch: "dev" },
    { path: "pages/users/[id].tsx", branch: "dev" },
    { path: "src/@types/user.d.ts", branch: "dev" },
    { path: "internal/wallet service.go", branch: "dev" },
  ]);
});

test("a cite path is read literally, so brackets, parentheses, @ and spaces pin the file they name and nothing else", () => {
  const sibling = siblingRepo();
  const paths = ["app/(auth)/login/page.tsx", "pages/users/[id].tsx", "src/@types/user.d.ts", "internal/wallet service.go"];
  for (const path of paths) sibling.push(path, "x\n", `add ${path}`);
  sibling.push("pages/users/i.tsx", "decoy\n", "add a file the bracket glob would match");
  git(sibling.clone, "fetch", "-q", "origin");
  const { pins, problems } = pinRepos(paths.map((path) => ({ path, branch: "dev" })), repoOf(sibling.clone));
  assert.deepEqual(problems, []);
  assert.deepEqual(pins[0].paths, paths);
  const glob = pinRepos([{ path: "pages/users/[a-z].tsx", branch: "dev" }, { path: "src/*.ts", branch: "dev" }], repoOf(sibling.clone));
  assert.deepEqual(glob.pins, []);
  assert.equal(glob.problems.length, 2);
  sibling.push("pages/users/i.tsx", "decoy 2\n", "chore: change the decoy only");
  const decoy = recheckRepos(pins, repoOf(sibling.clone));
  assert.deepEqual(decoy.refusals, []);
  assert.equal(decoy.notices.length, 1);
  const cited = sibling.push("pages/users/[id].tsx", "y\n", "fix: change the bracket page");
  assert.match(recheckRepos(pins, repoOf(sibling.clone)).refusals[0], new RegExp(`files: pages/users/\\[id\\]\\.tsx\\n  commit ${cited.slice(0, 7)} fix: change the bracket page`));
});

test("mapRepos resolves map repos against the first path and defaults the branch to dev", () => {
  const map = { paths: ["/w/fe"], repos: [{ path: "../be", role: "backend" }, { path: "/abs/sc", role: "contract", branch: "main" }] };
  assert.deepEqual(mapRepos(map), [
    { name: "../be", dir: "/w/be", branch: "dev" },
    { name: "/abs/sc", dir: "/abs/sc", branch: "main" },
  ]);
  assert.deepEqual(mapRepos(undefined), []);
});

test("a pin records the local origin/<branch> the agent read, never a fresh fetch", () => {
  const sibling = siblingRepo();
  const read = pinRepos([{ path: "src/a.ts", branch: "dev" }], repoOf(sibling.clone));
  const pushed = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const again = pinRepos([{ path: "src/a.ts", branch: "dev" }], repoOf(sibling.clone));
  assert.deepEqual(read.problems, []);
  assert.equal(again.pins[0].sha, read.pins[0].sha);
  assert.notEqual(read.pins[0].sha, pushed);
  assert.deepEqual(read.pins, [{ kind: "git", repo: "../backend", ref: "origin/dev", sha: read.pins[0].sha, paths: ["src/a.ts"] }]);
});

test("a cite no map repo holds at its branch is a lint problem", () => {
  const sibling = siblingRepo();
  const { pins, problems } = pinRepos([{ path: "src/missing.ts", branch: "dev" }, { path: "src/a.ts", branch: "main" }], repoOf(sibling.clone));
  assert.deepEqual(pins, []);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /`src\/missing\.ts@dev` is cited, but no repo in the project map has src\/missing\.ts at origin\/dev/);
});

test("the recheck fetches: unchanged is silent, an uncited change is a notice, a cited change refuses with files and commits", () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = pinRepos([{ path: "src/a.ts", branch: "dev" }], repos);
  assert.deepEqual(recheckRepos(pins, repos), { refusals: [], notices: [] });
  const other = sibling.push("src/b.ts", "b2\n", "chore: touch another file");
  const notice = recheckRepos(pins, repos);
  assert.deepEqual(notice.refusals, []);
  assert.deepEqual(notice.notices, [`notice: ../backend origin/dev moved from ${pins[0].sha.slice(0, 8)} to ${other.slice(0, 8)} since the draft was linted; no cited path changed, so it posts as drafted`]);
  const cited = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const refusal = recheckRepos(pins, repos);
  assert.deepEqual(refusal.notices, []);
  assert.equal(
    refusal.refusals[0],
    [
      `refused: ../backend origin/dev moved from ${pins[0].sha.slice(0, 8)} to ${cited.slice(0, 8)} since the draft was linted and changed what the draft cites`,
      "  files: src/a.ts",
      `  commit ${cited.slice(0, 7)} fix: change the writer`,
      "  re-read the changed sources, fix the draft, lint it again and ask the user again",
    ].join("\n"),
  );
});

test("a pinned repo the map no longer lists refuses", () => {
  const { refusals } = recheckRepos([{ kind: "git", repo: "../gone", ref: "origin/dev", sha: "a".repeat(40), paths: ["x.ts"] }], []);
  assert.match(refusals[0], /^refused: \.\.\/gone is pinned but the project map no longer lists it/);
});

test("a version source: unchanged is silent, changed refuses unless the cited part is provably untouched", () => {
  assert.deepEqual(versionCheck("Figma F1 version", "1", "1"), {});
  assert.deepEqual(versionCheck("Figma F1 version", "1", "2", { kept: "node 1:2 is unchanged" }), { notice: "notice: Figma F1 version changed from 1 to 2 since the draft was linted; node 1:2 is unchanged, so it posts as drafted" });
  assert.deepEqual(versionCheck("Figma F1 version", "1", "2", { changed: "node 1:2 changed" }), { refusal: "refused: Figma F1 version changed from 1 to 2 since the draft was linted and node 1:2 changed; re-read the changed sources, fix the draft, lint it again and ask the user again" });
  assert.deepEqual(versionCheck("Google Doc D revisionId", "r1", "r2"), { refusal: "refused: Google Doc D revisionId changed from r1 to r2 since the draft was linted; re-read the changed sources, fix the draft, lint it again and ask the user again" });
});

test("the sources record is required at publish and goes stale when the linted file changes", () => {
  const dir = tempDir("tedy-pins-");
  const file = join(dir, "d.md");
  writeFileSync(file, "draft one\n");
  const relint = "draft-lint.mjs pr-comment d.md";
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} has no pinned sources; run ${relint}, then ask the user again` });
  writeSources(file, [{ kind: "figma", file: "F", version: "1" }], "draft one\n");
  assert.deepEqual(pinnedSources(file, relint), { sources: [{ kind: "figma", file: "F", version: "1" }] });
  writeFileSync(file, "draft two\n");
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} changed after its sources were pinned; run ${relint}, then ask the user again` });
  writeSources(file, []);
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} has a sources record with no digest of its text; run ${relint}, then ask the user again` });
  writeSources(file, [], "draft two\n");
  assert.deepEqual(pinnedSources(file, relint), { sources: [] });
});

test("a sources record serves only the file it was written for, even when two paths share its name", () => {
  const dir = tempDir("tedy-pins-");
  const first = join(dir, "a_b", "c");
  const second = join(dir, "a", "b_c");
  mkdirSync(join(dir, "a_b"));
  mkdirSync(join(dir, "a"));
  writeFileSync(first, "same text\n");
  writeFileSync(second, "same text\n");
  assert.equal(sourcesPath(first), sourcesPath(second));
  writeSources(first, [{ kind: "figma", file: "F", version: "1" }], "same text\n");
  assert.deepEqual(pinnedSources(second, "relint"), { refusal: `refused: the sources record for ${second} was written for ${first}; run relint, then ask the user again` });
  assert.deepEqual(pinnedSources(first, "relint"), { sources: [{ kind: "figma", file: "F", version: "1" }] });
});

test("the recheck compares with what the fetch returned, so a clone that keeps no remote-tracking ref still refuses", () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = pinRepos([{ path: "src/a.ts", branch: "dev" }], repos);
  git(sibling.clone, "config", "--unset-all", "remote.origin.fetch");
  const cited = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const { refusals } = recheckRepos(pins, repos);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], new RegExp(`moved from ${pins[0].sha.slice(0, 8)} to ${cited.slice(0, 8)} since the draft was linted and changed what the draft cites`));
  git(sibling.clone, "remote", "set-url", "origin", join(sibling.root, "gone.git"));
  assert.match(recheckRepos(pins, repos).refusals[0], /^refused: \.\.\/backend origin\/dev could not be fetched to recheck the pin \(.+\); fetch it, then publish again$/);
});

test("the recheck takes the branch tip from ls-remote, so another process rewriting FETCH_HEAD cannot hide a change", () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = pinRepos([{ path: "src/a.ts", branch: "dev" }], repos);
  const cited = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const racing = (dir, args) => {
    const out = runGit(dir, args);
    if (args[0] === "fetch") writeFileSync(join(dir, ".git", "FETCH_HEAD"), `${pins[0].sha}\t\tbranch 'dev' of elsewhere\n`);
    return out;
  };
  const { refusals } = recheckRepos(pins, repos, racing);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], new RegExp(`moved from ${pins[0].sha.slice(0, 8)} to ${cited.slice(0, 8)}`));
  git(sibling.root, "--git-dir", join(sibling.root, "origin.git"), "update-ref", "-d", "refs/heads/dev");
  assert.match(recheckRepos(pins, repos).refusals[0], /^refused: \.\.\/backend origin\/dev no longer exists on origin; /);
});

test("linkedDocs finds the Figma files and Google Docs a tracker draft links", () => {
  const text = "See https://www.figma.com/design/AbC123/App?node-id=1-2&m=dev and https://www.figma.com/file/AbC123/x, (https://www.figma.com/design/Zz9/B?node-id=30-4) PRD https://docs.google.com/document/d/1x-Y_z/edit#heading";
  assert.deepEqual(linkedDocs(text), { figma: [{ file: "AbC123", nodes: ["1:2"] }, { file: "Zz9", nodes: ["30:4"] }], docs: ["1x-Y_z"] });
  const more = "Flow https://figma.com/proto/Pp1/z?node-id=3-4, board https://www.figma.com/board/Bd2/y and PRD https://docs.google.com/document/u/0/d/D9-x/edit, https://docs.google.com/document/u/12/d/D10/view";
  assert.deepEqual(linkedDocs(more), { figma: [{ file: "Pp1", nodes: ["3:4"] }, { file: "Bd2", nodes: [] }], docs: ["D9-x", "D10"] });
});
