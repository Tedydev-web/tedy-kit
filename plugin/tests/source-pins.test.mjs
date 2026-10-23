import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchTokens, lsRemoteHeads, mapRepos, namedIn, pinRepos, recheckRepos, runGit } from "../lib/source-pin-git.mjs";
import { linkedDocs, nodeId } from "../lib/source-pin-links.mjs";
import { pinnedSources, sourcesPath, versionCheck, writeSources } from "../lib/source-pins.mjs";
import { git, siblingRepo } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const repoOf = (clone, branches = ["dev"]) => [{ name: "../backend", dir: clone, branches }];
const RECHECK = "re-read the changed sources, fix the draft, lint it again and ask the user again";

test("namedIn finds a changed path by its full path or its basename wherever the text names it", async () => {
  const path = "src/wallet/fee-service.ts";
  const named = [
    "The fee is set in\n```ts\n// src/wallet/fee-service.ts\n```\n",
    "The writer `see src/wallet/fee-service.ts:3,12@dev for the call` sets it.",
    "Writer https://github.com/o/be/blob/dev/src/wallet/fee-service.ts#L10-L12 sets it.",
    "Only fee-service.ts sets it.",
    "It ends in fee-service.ts.",
    "Cited as src/wallet/fee-service.ts#L10@dev.",
    "Cited as (fee-service.ts:10,12@dev).",
    "Encoded https://github.com/o/be/blob/dev/src%2Fwallet%2Ffee-service.ts",
  ];
  for (const text of named) assert.equal(namedIn([text], path), true, text);
  for (const text of ["fee-service.tsx sets it.", "old-fee-service.ts sets it.", "fee-service.ts2 sets it.", "fee_service.ts sets it.", "nothing here"]) assert.equal(namedIn([text], path), false, text);
  assert.equal(namedIn(["one", "two names tài-liệu.md here"], "docs/tài-liệu.md"), true);
  assert.equal(namedIn(["https://github.com/o/be/blob/dev/docs/t%C3%A0i-li%E1%BB%87u.md"], "docs/tài-liệu.md"), true);
});

test("namedIn matches a lowercase file with no extension by its full path only, and reads through markdown escapes and emphasis", async () => {
  assert.equal(namedIn(["The api changed."], "docs/api"), false);
  assert.equal(namedIn(["See docs/api for the routes."], "docs/api"), true);
  assert.equal(namedIn(["The Makefile target."], "Makefile"), true);
  for (const text of ["Set in fee\\_service.ts.", "Set in _fee_service.ts_.", "Set in *fee_service.ts*.", "Set in __fee_service.ts__."]) assert.equal(namedIn([text], "src/fee_service.ts"), true, text);
  assert.equal(namedIn(["Set in _fee.ts_ today."], "src/fee.ts"), true);
});

test("namedIn matches a capitalised file with no extension by its name, a basename in any case, and a cited folder by every changed path under it", async () => {
  assert.equal(namedIn(["The `Dockerfile` copies the env too early."], "docker/Dockerfile"), true);
  assert.equal(namedIn(["Makefile target `test` skips lint."], "backend/Makefile"), true);
  assert.equal(namedIn(["The deploy stage of the Jenkinsfile."], "ci/Jenkinsfile"), true);
  assert.equal(namedIn(["See `UserService.ts:42`."], "src/services/userService.ts"), true);
  assert.equal(namedIn(["a.ts"], "src/A.ts"), true);
  assert.equal(namedIn(["The `src/auth/` module trusts the header."], "src/auth/guard.ts"), true);
  assert.equal(namedIn(["The auth/ module trusts the header."], "src/auth/guard.ts"), true);
  assert.equal(namedIn(["The `src/auth/` module trusts the header."], "src/authz/guard.ts"), false);
  assert.equal(namedIn(["The core changed."], "libs/core"), false);
  assert.equal(namedIn(["See `foo.tsx:3`."], "src/foo.ts"), false);
  assert.equal(namedIn(["The backup `guard.ts.bak` is stale."], "src/auth/guard.ts"), false);
  assert.equal(namedIn(["See `./src/auth/` for the guard."], "src/auth/guard.ts"), true);
});

test("namedIn reads a cited folder through a sibling path, the repo's name, its clone path and a GitHub tree link", async () => {
  const roots = ["../backend", "backend", "/work/backend"];
  for (const text of ["check `../backend/src/auth/` again", "check `../../x/backend/src/auth/` again", "see backend/src/auth/ for the guard", "see /work/backend/src/auth/ there", "https://github.com/o/be/tree/dev/src/auth", "https://github.com/o/be/tree/dev/src/auth/"]) {
    assert.equal(namedIn([text], "src/auth/guard.ts", roots), true, text);
    assert.equal(namedIn([text], "src/authz/guard.ts", roots), false, text);
  }
  assert.equal(namedIn(["see /elsewhere/backend2/src/auth/ there"], "src/auth/guard.ts", roots), false);
});

test("branchTokens reads only the branch of a path:line@branch cite, so mentions, mail and decorators are not branches", async () => {
  assert.deepEqual(branchTokens("See `src/a.ts:3@feature/v2`, `b.go:3-4@release-1.` and src/b.ts#L4@hotfix, mail me@example.com, ask @dev, use @Injectable() or @types/node."), ["feature/v2", "release-1"]);
});

test("a lint asks each repo's origin once for all its heads, and asks every repo at the same time", async () => {
  const one = siblingRepo();
  const two = siblingRepo();
  git(one.root, "--git-dir", one.origin, "branch", "feature/v2", "dev");
  const calls = [];
  let open = 0;
  let most = 0;
  const heads = async (dir) => {
    calls.push(dir);
    open += 1;
    most = Math.max(most, open);
    await new Promise((done) => setTimeout(done, 30));
    try {
      return await lsRemoteHeads(dir);
    } finally {
      open -= 1;
    }
  };
  const repos = [{ name: "one", dir: one.clone, branches: ["dev"] }, { name: "two", dir: two.clone, branches: ["dev"] }];
  const { pins, problems } = await pinRepos(repos, "`src/a.ts:1@feature/v2` and `src/b.ts:2@dev`", { heads });
  assert.deepEqual(problems, []);
  assert.deepEqual(pins.map((pin) => `${pin.repo} ${pin.ref}`), ["one origin/dev", "one origin/feature/v2", "two origin/dev"]);
  assert.deepEqual(calls.sort(), [one.clone, two.clone].sort());
  assert.equal(most, 2);
});

test("pin-sources --branch pins a branch the map does not name, and fails on a repo the map lacks or a branch origin lacks", async () => {
  const sibling = siblingRepo();
  git(sibling.root, "--git-dir", sibling.origin, "branch", "feature/x", "dev");
  const { pins, problems } = await pinRepos(repoOf(sibling.clone), "", { extra: ["../backend:feature/x"] });
  assert.deepEqual(problems, []);
  assert.deepEqual(pins.map((pin) => pin.ref), ["origin/dev", "origin/feature/x"]);
  assert.deepEqual((await pinRepos(repoOf(sibling.clone), "", { extra: ["../frontend:dev"] })).problems, ["--branch ../frontend:dev names ../frontend, which is not a repo in the project map; use the repo path as the map writes it, such as ../backend"]);
  assert.deepEqual((await pinRepos(repoOf(sibling.clone), "", { extra: ["../backend:gone"] })).problems, ["--branch ../backend:gone: origin of ../backend has no branch gone"]);
  assert.deepEqual((await pinRepos(repoOf(sibling.clone), "", { extra: ["dev"] })).problems, ["--branch dev is not <repo>:<branch>, such as ../backend:feature/x"]);
});

test("mapRepos resolves map repos against the first path; an unset branch means origin/HEAD, as the project map doctor reads it", async () => {
  const sibling = siblingRepo();
  git(sibling.clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const map = { paths: ["/w/fe"], repos: [{ path: "../be", role: "BE" }, { path: "/abs/sc", role: "contract", branch: "main" }, { path: sibling.clone, role: "FE" }] };
  assert.deepEqual(mapRepos(map), [
    { name: "../be", dir: "/w/be", branches: [] },
    { name: "/abs/sc", dir: "/abs/sc", branches: ["main"] },
    { name: sibling.clone, dir: sibling.clone, branches: ["main"] },
  ]);
  assert.deepEqual(mapRepos(undefined), []);
  git(sibling.clone, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.deepEqual(await pinRepos(mapRepos({ paths: ["/w"], repos: [{ path: sibling.clone, role: "FE" }] }), ""), { pins: [], problems: [`${sibling.clone} has no branch in the project map and origin/HEAD is unset; set its branch in the map or run git -C ${sibling.clone} remote set-head origin --auto`] });
});

test("a lint pins every map repo at the tip origin has now, not the clone's stale remote ref, and adds branches the draft names", async () => {
  const sibling = siblingRepo();
  const pushed = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  git(sibling.root, "--git-dir", sibling.origin, "branch", "feature/v2", "dev");
  const stale = git(sibling.clone, "rev-parse", "refs/remotes/origin/dev");
  assert.notEqual(stale, pushed);
  const { pins, problems } = await pinRepos(repoOf(sibling.clone), "Writer `src/a.ts:1@feature/v2`, mail me@example.com.");
  assert.deepEqual(problems, []);
  assert.deepEqual(pins, [
    { kind: "git", repo: "../backend", ref: "origin/dev", remote: "refs/heads/dev", local: "refs/remotes/origin/dev", sha: pushed },
    { kind: "git", repo: "../backend", ref: "origin/feature/v2", remote: "refs/heads/feature/v2", local: "refs/remotes/origin/feature/v2", sha: pushed },
  ]);
  git(sibling.clone, "cat-file", "-e", `${pushed}^{commit}`);
});

test("a pin moves the remote-tracking ref to the pinned tip even when the commit was already in the clone, so origin/<branch> reads what was pinned", async () => {
  const sibling = siblingRepo();
  const before = git(sibling.clone, "rev-parse", "refs/remotes/origin/dev");
  const tip = sibling.push("src/a.ts", "a2\n", "fix: backend writer changed");
  git(sibling.upstream, "checkout", "-q", "-b", "feature/y");
  git(sibling.upstream, "push", "-q", "origin", "feature/y");
  git(sibling.clone, "fetch", "-q", "origin", "feature/y:refs/heads/local-y");
  assert.equal(git(sibling.clone, "rev-parse", "refs/remotes/origin/dev"), before);
  const { pins } = await pinRepos(repoOf(sibling.clone), "");
  assert.equal(pins[0].sha, tip);
  assert.equal(git(sibling.clone, "rev-parse", "refs/remotes/origin/dev"), tip);
  assert.equal(git(sibling.clone, "show", "origin/dev:src/a.ts"), "a2");
});

test("a PR head pin refuses any move of the head, whatever the text names", async () => {
  const sibling = siblingRepo();
  const first = sibling.pr(701);
  const pin = { kind: "git", repo: "fe", dir: sibling.clone, pr: 701, ref: "pull/701/head", remote: "refs/pull/701/head", local: "refs/pr/701", sha: first };
  assert.deepEqual(recheckRepos([pin], [], ["nothing named"]), { refusals: [], notices: [] });
  sibling.push("src/b.ts", "b2\n", "fix: the author pushes during the read");
  const moved = sibling.pr(701);
  const { refusals } = recheckRepos([pin], [], ["nothing named"]);
  assert.match(refusals[0], new RegExp(`^refused: fe pull/701/head moved from ${first.slice(0, 8)} to ${moved.slice(0, 8)} since it was pinned, so the PR under review changed\\n  commit ${moved.slice(0, 7)} fix: the author pushes during the read\\n`));
});

test("a lint fails on a map repo whose branch origin does not have, or whose origin cannot be reached", async () => {
  const sibling = siblingRepo();
  const missing = await pinRepos(repoOf(sibling.clone, ["main"]), "");
  assert.deepEqual(missing.pins, []);
  assert.deepEqual(missing.problems, ["../backend has no origin/main; fix the branch in the project map or fetch the repo"]);
  git(sibling.clone, "remote", "set-url", "origin", join(sibling.root, "gone.git"));
  assert.match((await pinRepos(repoOf(sibling.clone), "")).problems[0], new RegExp(`^cannot pin \\.\\./backend: its origin cannot be reached \\(.+\\); check the network and git -C ${sibling.clone} remote -v, or fix the repo path in the project map$`));
});

test("the recheck: unchanged is silent, a change no posted text names is a notice, a named change refuses with files and commits", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  const sha = pins[0].sha.slice(0, 8);
  assert.deepEqual(recheckRepos(pins, repos, ["The writer `src/a.ts:1@dev` sets it."]), { refusals: [], notices: [] });
  const other = sibling.push("src/b.ts", "b2\n", "chore: touch another file");
  assert.deepEqual(recheckRepos(pins, repos, ["The writer `src/a.ts:1@dev` sets it."]), {
    refusals: [],
    notices: [`notice: ../backend origin/dev moved from ${sha} to ${other.slice(0, 8)} since it was pinned; no changed file is named in the text being posted, so it posts as drafted`],
  });
  const cited = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  for (const text of ["```\nsrc/a.ts\n```", "`see src/a.ts:3,5@dev here`", "https://github.com/o/be/blob/dev/src/a.ts#L3", "only a.ts sets it", "src/a.ts#L10@dev"]) {
    const { refusals, notices } = recheckRepos(pins, repos, ["The label is wrong.", text]);
    assert.deepEqual(notices, [], text);
    assert.equal(
      refusals[0],
      [`refused: ../backend origin/dev moved from ${sha} to ${cited.slice(0, 8)} since it was pinned and changed a file the text being posted names`, "  files: src/a.ts", `  commit ${cited.slice(0, 7)} fix: change the writer`, `  ${RECHECK}`].join("\n"),
      text,
    );
  }
});

test("a rename lists both names, so text naming either the old or the new one refuses", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  git(sibling.upstream, "mv", "src/a.ts", "src/fee.ts");
  git(sibling.upstream, "commit", "-q", "-m", "refactor: rename the writer");
  git(sibling.upstream, "push", "-q", "origin", "dev");
  assert.match(recheckRepos(pins, repos, ["see a.ts"]).refusals[0], /files: src\/a\.ts\n/);
  assert.match(recheckRepos(pins, repos, ["see src/fee.ts"]).refusals[0], /files: src\/fee\.ts\n/);
});

test("a cited folder refuses a change under it however the text spells the folder, and a status letter is never read as a path", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  sibling.push("src/auth/guard.ts", "g2\n", "fix: the guard trusts the header");
  for (const text of ["Check `../backend/src/auth/` again.", "See backend/src/auth/ for the guard.", `See ${sibling.clone}/src/auth/ there.`, "See https://github.com/o/be/tree/dev/src/auth for it.", "See `./src/auth/` for it."]) {
    const { refusals } = await recheckRepos(pins, repos, [text]);
    assert.match(refusals[0] ?? "", /files: src\/auth\/guard\.ts\n/, text);
  }
  const { refusals, notices } = await recheckRepos(pins, repos, ["A label is wrong, M and D say so, see a ticket."]);
  assert.deepEqual(refusals, []);
  assert.equal(notices.length, 1);
});

test("a cite path is matched literally, so brackets, parentheses, @ and spaces name the file they spell and nothing else", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  sibling.push("pages/users/i.tsx", "decoy\n", "chore: add a file the bracket glob would match");
  assert.deepEqual(recheckRepos(pins, repos, ["`pages/users/[id].tsx:5@dev`"]).refusals, []);
  sibling.push("pages/users/[id].tsx", "y\n", "fix: change the bracket page");
  sibling.push("internal/wallet service.go", "y\n", "fix: change the spaced file");
  assert.match(recheckRepos(pins, repos, ["`pages/users/[id].tsx:5@dev`"]).refusals[0], /files: pages\/users\/\[id\]\.tsx\n/);
  assert.match(recheckRepos(pins, repos, ["`internal/wallet service.go:3-4@dev`"]).refusals[0], /files: internal\/wallet service\.go\n/);
});

test("a pinned repo the map no longer lists refuses", async () => {
  const { refusals } = recheckRepos([{ kind: "git", repo: "../gone", ref: "origin/dev", sha: "a".repeat(40) }], [], []);
  assert.match(refusals[0], /^refused: \.\.\/gone is pinned but the project map no longer lists it/);
});

test("a deleted branch, an unreachable origin and a lost pinned commit refuse with a clear message", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  const lost = [{ ...pins[0], sha: "f".repeat(40) }];
  assert.match(recheckRepos(lost, repos, []).refusals[0], /^refused: \.\.\/backend origin\/dev: the pinned commit ffffffff is not in the clone, so what changed cannot be listed; fetch it or lint again, then ask the user again$/);
  git(sibling.root, "--git-dir", sibling.origin, "update-ref", "-d", "refs/heads/dev");
  assert.match(recheckRepos(pins, repos, []).refusals[0], /^refused: \.\.\/backend origin\/dev no longer exists on origin; /);
  git(sibling.clone, "remote", "set-url", "origin", join(sibling.root, "gone.git"));
  assert.match(recheckRepos(pins, repos, []).refusals[0], /^refused: \.\.\/backend origin\/dev could not be rechecked \(.+\); fetch it, then publish again$/);
});

test("a failing git diff or log is reported as a refusal, not thrown", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const broken = (verb) => (dir, args) => {
    if (args[0] === verb) throw Object.assign(new Error("boom"), { stderr: `fatal: ${verb} failed` });
    return runGit(dir, args);
  };
  assert.match(recheckRepos(pins, repos, ["a.ts"], broken("diff")).refusals[0], /^refused: \.\.\/backend origin\/dev could not be rechecked \(fatal: diff failed\); fetch it, then publish again$/);
  assert.match(recheckRepos(pins, repos, ["a.ts"], broken("log")).refusals[0], /^refused: \.\.\/backend origin\/dev could not be rechecked \(fatal: log failed\); fetch it, then publish again$/);
});

test("the recheck takes the branch tip from ls-remote, so another process rewriting FETCH_HEAD cannot hide a change", async () => {
  const sibling = siblingRepo();
  const repos = repoOf(sibling.clone);
  const { pins } = await pinRepos(repos, "");
  const cited = sibling.push("src/a.ts", "a2\n", "fix: change the writer");
  const racing = (dir, args) => {
    const out = runGit(dir, args);
    if (args[0] === "fetch") writeFileSync(join(dir, ".git", "FETCH_HEAD"), `${pins[0].sha}\t\tbranch 'dev' of elsewhere\n`);
    return out;
  };
  const { refusals } = recheckRepos(pins, repos, ["a.ts"], racing);
  assert.match(refusals[0], new RegExp(`moved from ${pins[0].sha.slice(0, 8)} to ${cited.slice(0, 8)}`));
});

test("a version source: unchanged is silent, changed refuses unless the cited part is provably untouched", async () => {
  assert.deepEqual(versionCheck("Figma F1 lastModified", "1", "1"), {});
  assert.deepEqual(versionCheck("Figma F1 lastModified", "1", "2", { kept: "node 1:2 is unchanged" }), { notice: "notice: Figma F1 lastModified changed from 1 to 2 since it was pinned; node 1:2 is unchanged, so it posts as drafted" });
  assert.deepEqual(versionCheck("Figma F1 lastModified", "1", "2", { changed: "the draft links the whole file" }), { refusal: `refused: Figma F1 lastModified changed from 1 to 2 since it was pinned and the draft links the whole file; ${RECHECK}` });
});

test("the sources record is required at publish and refuses when missing, corrupt, for another file or stale", async () => {
  const dir = tempDir("tedy-pins-");
  const file = join(dir, "d.md");
  writeFileSync(file, "draft one\n");
  const relint = "draft-lint.mjs pr-comment d.md";
  const unknown = `${relint} [--pinned-at <file pin-sources ran for>]`;
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} has no pinned sources; run ${unknown}, then ask the user again` });
  writeSources(file, [{ kind: "figma", file: "F" }], "draft one\n");
  assert.deepEqual(pinnedSources(file, relint), { sources: [{ kind: "figma", file: "F" }], warnings: [], pinnedAt: undefined });
  writeFileSync(file, "draft two\n");
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} changed after its sources were pinned; run ${unknown}, then ask the user again` });
  writeSources(file, []);
  assert.deepEqual(pinnedSources(file, relint), { refusal: `refused: ${file} has a sources record with no digest of its text; run ${unknown}, then ask the user again` });
  writeFileSync(sourcesPath(file), "{ not json");
  assert.match(pinnedSources(file, relint).refusal, new RegExp(`^refused: the sources record for ${file} cannot be read \\(.+\\); run ${unknown.replace(/[[\]]/g, "\\$&")}, then ask the user again$`));
  writeSources(file, [], "draft two\n");
  assert.deepEqual(pinnedSources(file, relint), { sources: [], warnings: [], pinnedAt: undefined });
});

test("the sources record keeps the lint's warnings and where the read pins came from, and a relint hint names that file", async () => {
  const dir = tempDir("tedy-pins-");
  const file = join(dir, "c.md");
  const ledger = join(dir, "ledger.md");
  writeFileSync(file, "comment\n");
  const warning = "warning: Figma F file was not pinned by draft-lint.mjs pin-sources ledger.md, so it was pinned now, at lint";
  writeSources(file, [], "comment\n", { warnings: [warning], pinnedAt: ledger });
  assert.deepEqual(pinnedSources(file, "relint"), { sources: [], warnings: [warning], pinnedAt: ledger });
  writeFileSync(file, "comment, edited\n");
  assert.deepEqual(pinnedSources(file, "relint"), { refusal: `refused: ${file} changed after its sources were pinned; run relint --pinned-at ${ledger}, then ask the user again` });
  writeFileSync(file, "comment\n");
  writeFileSync(sourcesPath(file), JSON.stringify({ file, at: "2026-10-23T00:00:00Z", sha256: JSON.parse(readFileSync(sourcesPath(file), "utf8")).sha256, sources: [] }));
  assert.deepEqual(pinnedSources(file, "relint"), { refusal: `refused: the sources record for ${file} has no list of the lint's warnings; run relint [--pinned-at <file pin-sources ran for>], then ask the user again` });
});

test("a sources record serves only the file it was written for, even when two paths share its name", async () => {
  const dir = tempDir("tedy-pins-");
  const first = join(dir, "a_b", "c");
  const second = join(dir, "a", "b_c");
  mkdirSync(join(dir, "a_b"));
  mkdirSync(join(dir, "a"));
  writeFileSync(first, "same text\n");
  writeFileSync(second, "same text\n");
  assert.equal(sourcesPath(first), sourcesPath(second));
  writeSources(first, [{ kind: "figma", file: "F" }], "same text\n");
  assert.deepEqual(pinnedSources(second, "relint"), { refusal: `refused: the sources record for ${second} was written for ${first}; run relint [--pinned-at <file pin-sources ran for>], then ask the user again` });
  assert.deepEqual(pinnedSources(first, "relint"), { sources: [{ kind: "figma", file: "F" }], warnings: [], pinnedAt: undefined });
});

test("nodeId accepts 12-34, 12:34 and 12%3A34, instance paths included, and nothing else", async () => {
  assert.equal(nodeId("12-34"), "12:34");
  assert.equal(nodeId("12:34"), "12:34");
  assert.equal(nodeId("12%3A34"), "12:34");
  assert.equal(nodeId("I1-2%3B3-4"), "I1:2;3:4");
  assert.equal(nodeId("abc"), null);
  assert.equal(nodeId("%E0%A4%A"), null);
});

test("linkedDocs finds Figma files with their nodes, branch files, and Google Docs in every link shape", async () => {
  const text = "See https://www.figma.com/design/AbC123/App?node-id=1-2&m=dev and https://www.figma.com/file/AbC123/x, (https://www.figma.com/design/Zz9/B?node-id=30%3A4) PRD https://docs.google.com/document/d/1x-Y_z/edit#heading";
  assert.deepEqual(linkedDocs(text), { figma: [{ file: "AbC123", nodes: ["1:2"], whole: true }, { file: "Zz9", nodes: ["30:4"], whole: false }], docs: ["1x-Y_z"], problems: [] });
  const more = "Flow https://figma.com/proto/Pp1/z?node-id=3-4, board https://www.figma.com/board/Bd2/y, branch https://www.figma.com/design/Main1/branch/Br2/App?node-id=5:6 and PRD https://docs.google.com/document/u/0/d/D9-x/edit, https://docs.google.com/document/u/12/d/D10/view, https://docs.google.com/a/example.com/document/d/D11/edit, https://drive.google.com/open?id=D12 and https://drive.google.com/open?usp=x&id=D13";
  assert.deepEqual(linkedDocs(more), {
    figma: [{ file: "Pp1", nodes: ["3:4"], whole: false }, { file: "Bd2", nodes: [], whole: true }, { file: "Br2", nodes: ["5:6"], whole: false }],
    docs: ["D9-x", "D10", "D11", "D12", "D13"],
    problems: [],
  });
  assert.deepEqual(linkedDocs("https://FIGMA.com/design/Up1/N?node-id=1-2, https://WWW.Figma.COM/embed?url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FUp2%2FX, https://Docs.Google.com/document/d/UpD/edit and https://DRIVE.google.com/file/d/UpF/view"), {
    figma: [{ file: "Up1", nodes: ["1:2"], whole: false }, { file: "Up2", nodes: [], whole: true }],
    docs: ["UpD", "UpF"],
    problems: [],
  });
  const published = linkedDocs("Read https://docs.google.com/document/d/e/2PACX-1vT/pub please");
  assert.deepEqual(published.docs, []);
  assert.deepEqual(published.problems, ["https://docs.google.com/document/d/e/2PACX-1vT/pub is a published-to-web copy of a Google Doc, which cannot be pinned; link the Doc itself (docs.google.com/document/d/<id>)"]);
});

test("linkedDocs reads slides, make, site and embed Figma links, &amp; in a link, and Drive file and open links", async () => {
  const text = [
    "https://www.figma.com/slides/Sl1/Deck?node-id=1-2",
    "https://www.figma.com/make/Mk1/App",
    "https://www.figma.com/site/St1/Site",
    "https://www.figma.com/embed?embed_host=share&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FEm1%2FX%3Fnode-id%3D7-8",
    "https://www.figma.com/design/Am1/X?t=zz&amp;node-id=3-4",
    "https://drive.google.com/file/d/Df1/view",
    "https://docs.google.com/open?id=Do1",
    "https://docs.google.com/document/d/Dt1/edit?tab=t.0",
  ].join(" and ");
  assert.deepEqual(linkedDocs(text), {
    figma: [{ file: "Sl1", nodes: ["1:2"], whole: false }, { file: "Mk1", nodes: [], whole: true }, { file: "St1", nodes: [], whole: true }, { file: "Am1", nodes: ["3:4"], whole: false }, { file: "Em1", nodes: ["7:8"], whole: false }],
    docs: ["Df1", "Do1", "Dt1"],
    problems: [],
  });
});
