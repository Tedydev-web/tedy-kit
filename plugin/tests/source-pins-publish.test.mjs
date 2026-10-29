import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWithFakeGh } from "./fake-gh-for-tests.mjs";
import { commitFile, git, siblingRepo } from "./git-sibling-for-tests.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const LINT = new URL("../lib/draft-lint.mjs", import.meta.url).pathname;
const WRITE = new URL("../lib/github-write.mjs", import.meta.url).pathname;
const CLEAN_DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,2 +10,2 @@\n context line\n+added line\n";
const HEAD = "abc1234" + "0".repeat(33);
const draftWith = (body) => `# PR #701: comment line by line (head abc1234)\n\n## 1. \`src/a.ts:10\`\n${body}\n`;
const DRAFT = draftWith("The label is wrong.");
const POSTED = { diff: CLEAN_DIFF, head: HEAD, write: { id: 9, html_url: "https://x/review/9" }, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, commit_id: HEAD }] };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function project(draft = DRAFT) {
  const be = siblingRepo();
  const fe = siblingRepo();
  const prSha = fe.pr(701);
  const atHead = (text) => text.replaceAll("abc1234", prSha.slice(0, 7));
  const profileDir = profileWith({ language: { chat: "en" } });
  mkdirSync(join(profileDir, "projects"));
  const map = { name: "p", paths: [fe.clone], repos: [{ path: ".", role: "FE", branch: "dev" }, { path: be.clone, role: "BE", branch: "dev" }], language: { pr_review: "en" } };
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const work = tempDir("tedy-work-");
  writeFileSync(join(work, "pr.diff"), CLEAN_DIFF);
  writeFileSync(join(work, "d.md"), atHead(draft));
  const options = { cwd: fe.clone, stateDir: tempDir("tedy-pinstate-"), profileDir };
  const at = (name) => join(work, name);
  return {
    be,
    fe,
    at,
    prSha,
    stateDir: options.stateDir,
    short: prSha.slice(0, 7),
    beSha: git(be.clone, "rev-parse", "refs/remotes/origin/dev"),
    feSha: git(fe.clone, "rev-parse", "refs/remotes/origin/dev"),
    lint: (...args) => runWithFakeGh(LINT, args.includes("--pr") && !args.includes("--repo") ? [...args, "--repo", "o/r"] : args, options),
    write: (args, fixture = { ...POSTED, head: prSha }) => runWithFakeGh(WRITE, args, { ...options, fixture }),
    rewrite: (name, text) => writeFileSync(join(work, name), atHead(text)),
  };
}

test("draft-lint pins the other map repos and the PR head, with full shas, and says they were pinned at lint", () => {
  const p = project();
  const pushed = p.be.push("src/c.ts", "c1\n", "feat: pushed after the clone fetched");
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, new RegExp(`^clean: 1 comments, PR #701, head ${p.short}$`, "m"));
  assert.ok(result.out.includes(`pinned: ${p.be.clone} origin/dev@${pushed} (at lint)\npinned: . pull/701/head@${p.prSha} (at lint)\n`), result.out);
  assert.doesNotMatch(result.out, /^pinned: \. origin\/dev@/m);
  assert.equal(git(p.be.clone, "rev-parse", "refs/remotes/origin/dev"), pushed);
  assert.equal(git(p.fe.clone, "rev-parse", "refs/pr/701"), p.prSha);
});

test("a merge into the reviewed repo's own branch does not stop a post on its PR, even when a cite names that branch, unless pin-sources --branch pinned it; the other repos still refuse", () => {
  for (const body of ["The label is wrong, src/a.ts sets it.", "The label is wrong, `src/a.ts:1@dev` sets it."]) {
    const merged = project(draftWith(body));
    assert.equal(merged.lint("pr-comment", merged.at("d.md"), "--diff", merged.at("pr.diff")).status, 0, body);
    merged.fe.push("src/a.ts", "a2\n", "fix: another PR merged into dev");
    const posted = merged.write(["post", merged.at("d.md"), "--repo", "o/r"]);
    assert.equal(posted.status, 0, `${body}\n${posted.out}`);
    assert.equal(posted.writes.length, 1, body);
  }
  const cited = project(draftWith("The label is wrong, `src/a.ts:1@dev` sets it."));
  assert.equal(cited.lint("pin-sources", cited.at("d.md"), "--pr", "701", "--branch", ".:dev").status, 0);
  cited.rewrite("d.md", draftWith("The label is wrong, `src/a.ts:1@dev` sets it."));
  assert.equal(cited.lint("pr-comment", cited.at("d.md"), "--diff", cited.at("pr.diff")).status, 0);
  cited.fe.push("src/a.ts", "a2\n", "fix: another PR merged into dev");
  const refused = cited.write(["post", cited.at("d.md"), "--repo", "o/r"]);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /^refused: \. origin\/dev moved from .* and changed a file the text being posted names$/m);
  const be = project(draftWith("The label is wrong, src/a.ts sets it."));
  assert.equal(be.lint("pr-comment", be.at("d.md"), "--diff", be.at("pr.diff")).status, 0);
  be.be.push("src/a.ts", "a2\n", "fix: the backend writer changed");
  assert.equal(be.write(["post", be.at("d.md"), "--repo", "o/r"]).status, 1);
});

test("a cite of another branch of the reviewed repo pins that branch, and a push to it refuses the post", () => {
  const body = "The label is wrong, `src/a.ts:1@feature/x` sets it.";
  const p = project(draftWith(body));
  git(p.fe.root, "--git-dir", p.fe.origin, "branch", "feature/x", "dev");
  const lint = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(lint.status, 0, lint.out);
  assert.match(lint.out, new RegExp(`^pinned: \\. origin/feature/x@${p.feSha} \\(at lint\\)$`, "m"));
  assert.doesNotMatch(lint.out, /pins nothing/);
  commitFile(p.fe.upstream, "src/a.ts", "a2\n", "fix: the label writer changed");
  git(p.fe.upstream, "push", "-q", "origin", "dev:feature/x");
  const refused = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /^refused: \. origin\/feature\/x moved from .* and changed a file the text being posted names$/m);
  const read = project(draftWith(body));
  git(read.fe.root, "--git-dir", read.fe.origin, "branch", "feature/x", "dev");
  assert.equal(read.lint("pin-sources", read.at("d.md"), "--pr", "701").status, 0);
  read.rewrite("d.md", draftWith(body));
  const warned = read.lint("pr-comment", read.at("d.md"), "--diff", read.at("pr.diff"));
  assert.equal(warned.status, 0, warned.out);
  assert.ok(warned.out.includes(`warning: . origin/feature/x was not pinned by draft-lint.mjs pin-sources ${read.at("d.md")}, so it was pinned now, at lint\n`), warned.out);
});

test("draft-lint fails when a map repo or the PR head cannot be pinned, and passes a bare cite now that cites are not parsed", () => {
  const p = project(draftWith("The label is wrong, the writer at src/a.ts:1-3@dev sets it."));
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  git(p.be.clone, "remote", "set-url", "origin", join(p.be.root, "gone.git"));
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 1);
  assert.match(result.out, new RegExp(`^sources: cannot pin ${escape(p.be.clone)}: its origin cannot be reached \\(.+\\); check the network and git -C ${escape(p.be.clone)} remote -v, or fix the repo path in the project map$`, "m"));
  assert.doesNotMatch(result.out, /^clean:/m);
  const noPr = project(draftWith("The label is wrong.").replace("#701", "#702"));
  const missing = noPr.lint("pr-comment", noPr.at("d.md"), "--diff", noPr.at("pr.diff"));
  assert.equal(missing.status, 1);
  assert.match(missing.out, /^sources: cannot pin the head of PR #702: GitHub reports no head for o\/r#702$/m);
});

test("post refuses a draft that was never linted, and one edited after its pins were taken", () => {
  const p = project();
  const unlinted = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(unlinted.status, 1);
  assert.ok(unlinted.out.includes(`refused: ${p.at("d.md")} has no pinned sources; run draft-lint.mjs pr-comment ${p.at("d.md")} --repo o/r [--pinned-at <file pin-sources ran for>], then ask the user again\n`), unlinted.out);
  assert.equal(unlinted.writes.length, 0);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  p.rewrite("d.md", DRAFT.replace("wrong", "off"));
  const edited = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.match(edited.out, /^refused: .*d\.md changed after its sources were pinned; run draft-lint\.mjs pr-comment .*d\.md --repo o\/r \[--pinned-at <file pin-sources ran for>\], then ask the user again$/m);
  assert.equal(edited.writes.length, 0);
});

test("post goes ahead silently when no pinned repo moved", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /notice|refused/);
  assert.equal(result.writes.length, 1);
});

test("post goes ahead with a notice when a repo moved but no changed file is named in the comments", () => {
  const p = project(draftWith("The label is wrong, the writer `src/a.ts:1@dev` sets it."));
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  const moved = p.be.push("src/b.ts", "b2\n", "chore: unrelated");
  const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 0, result.out);
  assert.ok(result.out.includes(`notice: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${moved.slice(0, 8)} since it was pinned; no changed file is named in the text being posted, so it posts as drafted\n`), result.out);
  assert.equal(result.writes.length, 1);
});

test("post refuses when a changed file is named in a comment, however it is cited, in the FE or the BE repo", () => {
  const bodies = [
    "The label is wrong, `see src/a.ts:3,5@dev for the writer` sets it.",
    "The label is wrong, https://github.com/o/be/blob/dev/src/a.ts#L3 sets it.",
    "The label is wrong, a.ts sets it.",
    "The label is wrong, `src/a.ts#L10@dev` sets it.",
  ];
  for (const body of bodies) {
    const p = project(draftWith(body));
    assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0, body);
    const moved = p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
    const result = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
    assert.equal(result.status, 1, body);
    assert.ok(result.out.includes(`refused: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${moved.slice(0, 8)} since it was pinned and changed a file the text being posted names\n  files: src/a.ts\n  commit ${moved.slice(0, 7)} fix: writer sets the field\n`), `${body}\n${result.out}`);
    assert.equal(result.writes.length, 0, body);
  }
  const fe = project(draftWith("The label is wrong, `src/b.ts:1@dev` sets it."));
  assert.equal(fe.lint("pin-sources", fe.at("d.md"), "--pr", "701", "--branch", ".:dev").status, 0);
  fe.rewrite("d.md", draftWith("The label is wrong, `src/b.ts:1@dev` sets it."));
  assert.equal(fe.lint("pr-comment", fe.at("d.md"), "--diff", fe.at("pr.diff")).status, 0);
  fe.fe.push("src/b.ts", "b2\n", "fix: merged into dev");
  const result = fe.write(["post", fe.at("d.md"), "--repo", "o/r"]);
  assert.equal(result.status, 1);
  assert.match(result.out, /^refused: \. origin\/dev moved from .* and changed a file the text being posted names\n {2}files: src\/b\.ts$/m);
});

test("reply and edit need a pr-reply lint with --pr, then refuse when a changed file is named in the body or the PR head moved", () => {
  const p = project();
  writeFileSync(p.at("r.txt"), "The label is still wrong, see src/a.ts.\n");
  const reply = ["reply", "701", "123", "--repo", "o/r", "--body-file", p.at("r.txt")];
  const unlinted = p.write(reply, { write: { id: 5, html_url: "u" } });
  assert.match(unlinted.out, /^refused: .*r\.txt has no pinned sources; run draft-lint\.mjs pr-reply .*r\.txt --pr 701 --repo o\/r \[--pinned-at <file pin-sources ran for>\], then ask the user again$/m);
  assert.equal(unlinted.writes.length, 0);
  assert.match(p.lint("pr-reply", p.at("r.txt")).out, /pr-reply and pin-sources for a review need --pr <number>/);
  assert.match(runWithFakeGh(LINT, ["pr-reply", p.at("r.txt"), "--pr", "701"], { cwd: p.fe.clone }).out, /^draft-lint: --pr 701 needs --repo <owner\/repo>, the repository the reply or review goes to, so the PR head is pinned from that repository only$/m);
  const lint = p.lint("pr-reply", p.at("r.txt"), "--pr", "701");
  assert.equal(lint.status, 0, lint.out);
  assert.ok(lint.out.includes(`clean: pr-reply\npinned: ${p.be.clone} origin/dev@${p.beSha} (at lint)\npinned: . pull/701/head@${p.prSha} (at lint)\n`), lint.out);
  const posted = p.write(reply, { write: { id: 5, html_url: "u" }, head: p.prSha });
  assert.equal(posted.status, 0, posted.out);
  assert.equal(posted.writes.length, 1);
  p.be.push("src/a.ts", "a3\n", "fix: again");
  const edit = p.write(["edit", "123", "--repo", "o/r", "--body-file", p.at("r.txt")], { write: { body: "The label is still wrong, see src/a.ts.", html_url: "u" }, head: p.prSha, comment: commentOn("o/r", 701) });
  assert.equal(edit.status, 1);
  assert.match(edit.out, /^refused: .* and changed a file the text being posted names$/m);
  assert.equal(edit.writes.length, 0);
  const head = project();
  writeFileSync(head.at("r.txt"), "The label is still wrong.\n");
  assert.equal(head.lint("pr-reply", head.at("r.txt"), "--pr", "701").status, 0);
  head.fe.push("src/z.ts", "z\n", "fix: the author pushed");
  head.fe.pr(701);
  const stale = head.write(["reply", "701", "123", "--repo", "o/r", "--body-file", head.at("r.txt")], { write: { id: 5, html_url: "u" } });
  assert.equal(stale.status, 1);
  assert.match(stale.out, /^refused: \. pull\/701\/head moved from [0-9a-f]{8} to [0-9a-f]{8} since it was pinned, so the PR under review changed$/m);
  assert.equal(stale.writes.length, 0);
});

test("a lint outside every project map fails and says so, instead of pinning nothing", () => {
  const dir = tempDir("tedy-nomap-");
  writeFileSync(join(dir, "r.txt"), "The label is still wrong.\n");
  for (const args of [["pr-reply", join(dir, "r.txt"), "--pr", "701", "--repo", "o/r"], ["doc-comment", join(dir, "r.txt")], ["pin-sources", join(dir, "r.txt")]]) {
    const result = runWithFakeGh(LINT, args, { cwd: dir });
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /^sources: no project map covers .+, so its repos cannot be pinned; run this from a folder of a mapped project, or map it with \/tedy:setup$/m, args[0]);
    assert.doesNotMatch(result.out, /^(clean|pinned|read pins)/m, args[0]);
  }
});

function twoRepos(cwdOf) {
  const be = siblingRepo({ slug: "o/be" });
  const fe = siblingRepo({ slug: "o/fe" });
  fe.pr(701);
  be.pr(701);
  fe.pr(702);
  const profileDir = profileWith({ language: { chat: "en" } });
  mkdirSync(join(profileDir, "projects"));
  const map = { name: "p", paths: [fe.clone, be.clone], repos: [{ path: fe.clone, role: "FE", branch: "dev" }, { path: be.clone, role: "BE", branch: "dev" }], language: { pr_review: "en" } };
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const work = tempDir("tedy-work-");
  const file = join(work, "r.txt");
  writeFileSync(file, "The label is still wrong.\n");
  const options = { cwd: cwdOf({ fe, be }), stateDir: tempDir("tedy-pinstate-"), profileDir };
  return { fe, be, file, lint: (...args) => runWithFakeGh(LINT, args, options), write: (args, fixture) => runWithFakeGh(WRITE, args, { ...options, fixture: { write: { id: 5, body: "The label is still wrong.", html_url: "u" }, ...fixture } }) };
}

const commentOn = (repo, pr) => ({ pull_request_url: `https://api.github.com/repos/${repo}/pulls/${pr}` });

test("reply and edit write only to the repository and PR the lint pinned, while GitHub shows the pinned head", () => {
  const wrongCwd = twoRepos(({ be }) => be.clone);
  const mismatch = wrongCwd.lint("pr-reply", wrongCwd.file, "--pr", "701", "--repo", "o/fe");
  assert.equal(mismatch.status, 1, mismatch.out);
  assert.match(mismatch.out, new RegExp(`^sources: cannot pin the head of PR #701: --repo o/fe is not the repository checked out at ${escape(wrongCwd.be.clone)}, whose origin is .*o/be\\.git; run from the checkout of o/fe$`, "m"));
  assert.equal(wrongCwd.lint("pr-reply", wrongCwd.file, "--pr", "701", "--repo", "o/be").status, 0);
  const feHead = wrongCwd.fe.pr(701);
  const repoRefusal = new RegExp(`^refused: ${escape(wrongCwd.file)} was linted for o/be#701, not o/fe#701; run draft-lint\\.mjs pr-reply ${escape(wrongCwd.file)} --pr 701 --repo o/fe from the checkout of o/fe, then ask the user again$`, "m");
  const reply = wrongCwd.write(["reply", "701", "123", "--repo", "o/fe", "--body-file", wrongCwd.file], { head: feHead });
  assert.equal(reply.status, 1, reply.out);
  assert.match(reply.out, repoRefusal);
  assert.equal(reply.writes.length, 0);
  const edit = wrongCwd.write(["edit", "5", "--repo", "o/fe", "--body-file", wrongCwd.file], { head: feHead, comment: commentOn("o/fe", 701) });
  assert.equal(edit.status, 1, edit.out);
  assert.match(edit.out, repoRefusal);
  assert.equal(edit.writes.length, 0);

  const wrongPr = twoRepos(({ fe }) => fe.clone);
  assert.equal(wrongPr.lint("pr-reply", wrongPr.file, "--pr", "701", "--repo", "o/fe").status, 0);
  const pinned = wrongPr.fe.pr(701);
  const prRefusal = /^refused: .*r\.txt was linted for o\/fe#701, not o\/fe#702; run draft-lint\.mjs pr-reply .*r\.txt --pr 702 --repo o\/fe from the checkout of o\/fe, then ask the user again$/m;
  const other = wrongPr.write(["reply", "702", "123", "--repo", "o/fe", "--body-file", wrongPr.file], { head: wrongPr.fe.pr(702) });
  assert.equal(other.status, 1, other.out);
  assert.match(other.out, prRefusal);
  const otherEdit = wrongPr.write(["edit", "5", "--repo", "o/fe", "--body-file", wrongPr.file], { head: pinned, comment: commentOn("o/fe", 702) });
  assert.equal(otherEdit.status, 1, otherEdit.out);
  assert.match(otherEdit.out, prRefusal);
  const noPr = wrongPr.write(["edit", "5", "--repo", "o/fe", "--body-file", wrongPr.file], { head: pinned, comment: {} });
  assert.equal(noPr.status, 1, noPr.out);
  assert.match(noPr.out, /^refused: review comment 5 in o\/fe names no pull request; nothing edited$/m);
  for (const head of [`${pinned.slice(0, 8)}${"0".repeat(32)}`, ""]) {
    const near = wrongPr.write(["reply", "701", "123", "--repo", "o/fe", "--body-file", wrongPr.file], { head });
    assert.equal(near.status, 1, near.out);
    assert.match(near.out, /^refused: \S+ pull\/701\/head (moved from [0-9a-f]{8} to [0-9a-f]{0,8} since it was pinned, so the PR under review changed|no longer exists on origin)/m);
    assert.equal(near.writes.length, 0);
  }
  const moved = wrongPr.write(["reply", "701", "123", "--repo", "o/fe", "--body-file", wrongPr.file], { head: "f".repeat(40) });
  assert.equal(moved.status, 1, moved.out);
  assert.match(moved.out, new RegExp(`^refused: \\S+ pull/701/head moved from ${pinned.slice(0, 8)} to ffffffff since it was pinned, so the PR under review changed$`, "m"));
  for (const result of [other, otherEdit, noPr, moved]) assert.equal(result.writes.length, 0);
  const posted = wrongPr.write(["reply", "701", "123", "--repo", "O/FE", "--body-file", wrongPr.file], { head: pinned });
  assert.equal(posted.status, 0, posted.out);
  assert.equal(posted.writes.length, 1);
  const edited = wrongPr.write(["edit", "5", "--repo", "o/fe", "--body-file", wrongPr.file], { head: pinned, comment: commentOn("o/fe", 701) });
  assert.equal(edited.status, 0, edited.out);
  assert.equal(edited.writes.length, 1);
});

test("post writes only to the repository and PR the lint pinned, while GitHub shows the pinned head", () => {
  const wrongCwd = twoRepos(({ be }) => be.clone);
  const feHead = wrongCwd.fe.pr(701);
  const draftAt = (sha) => `# PR #701: comment line by line (head ${sha.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\nThe label is wrong.\n`;
  writeFileSync(wrongCwd.file, draftAt(feHead));
  writeFileSync(join(wrongCwd.file, "..", "pr.diff"), CLEAN_DIFF);
  assert.equal(wrongCwd.lint("pr-comment", wrongCwd.file, "--diff", join(wrongCwd.file, "..", "pr.diff"), "--repo", "o/be").status, 0);
  const posted = wrongCwd.write(["post", wrongCwd.file, "--repo", "o/fe"], { diff: CLEAN_DIFF, head: feHead });
  assert.equal(posted.status, 1, posted.out);
  assert.match(posted.out, new RegExp(`^refused: ${escape(wrongCwd.file)} was linted for o/be#701, not o/fe#701; run draft-lint\\.mjs pr-comment ${escape(wrongCwd.file)} --repo o/fe from the checkout of o/fe, then ask the user again$`, "m"));
  assert.equal(posted.writes.length, 0);
});

test("without a read pin the lint pins at lint time and its warning names what it pinned", () => {
  const p = project();
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 0, result.out);
  assert.ok(result.out.includes(`warning: no read pins for ${p.at("d.md")}, so these were pinned now, at lint, and a change made while you read them is not seen: ${p.be.clone} origin/dev; . pull/701/head; next time run draft-lint.mjs pin-sources ${p.at("d.md")} before reading\n`), result.out);
});

test("a read pin taken before the read holds: a push before the lint fails it when the draft names a changed file, else prints a notice, and post diffs from the read", () => {
  const draft = draftWith("The label is wrong, `src/a.ts:1@dev` sets it.");
  const p = project(draft);
  const pinned = p.lint("pin-sources", p.at("d.md"), "--pr", "701", "--branch", ".:dev");
  assert.equal(pinned.status, 0, pinned.out);
  assert.match(pinned.out, new RegExp(`^read pins for ${escape(p.at("d.md"))}:\\npinned: \\. origin/dev@${p.feSha} \\(read \\S+\\)\\npinned: ${escape(p.be.clone)} origin/dev@${p.beSha} \\(read \\S+\\)\\npinned: \\. pull/701/head@${p.prSha} \\(read \\S+\\)$`, "m"));
  const early = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(early.status, 1, early.out);
  assert.match(early.out, /^sources: the read pins for .*d\.md were taken at \S+, after .*d\.md was last written: pin-sources ran again but the draft was not re-read and rewritten; re-read the sources, update .*d\.md, then lint it again$/m);
  p.rewrite("d.md", draft);
  const other = p.be.push("src/b.ts", "b2\n", "chore: unrelated, pushed during the read");
  const noted = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(noted.status, 0, noted.out);
  assert.ok(noted.out.includes(`notice: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${other.slice(0, 8)} since it was pinned; no changed file is named in the text being posted, so it posts as drafted\n`), noted.out);
  assert.match(noted.out, new RegExp(`^pinned: ${escape(p.be.clone)} origin/dev@${p.beSha} \\(read \\S+\\)$`, "m"));
  assert.doesNotMatch(noted.out, /warning:/);
  const posted = p.write(["post", p.at("d.md"), "--repo", "o/r"]);
  assert.equal(posted.status, 0, posted.out);
  assert.match(posted.out, new RegExp(`^notice: .* moved from ${p.beSha.slice(0, 8)} to ${other.slice(0, 8)} since it was pinned;`, "m"));
  const cited = p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
  const failed = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(failed.status, 1, failed.out);
  assert.ok(failed.out.includes(`sources: refused: ${p.be.clone} origin/dev moved from ${p.beSha.slice(0, 8)} to ${cited.slice(0, 8)} since it was pinned and changed a file the text being posted names\n`), failed.out);
  assert.ok(failed.out.includes(`sources: a source changed while it was being read; run draft-lint.mjs pin-sources ${p.at("d.md")} again, re-read what changed, fix the draft and lint it again\n`), failed.out);
  assert.doesNotMatch(failed.out, /^clean:/m);
  assert.equal(p.lint("pin-sources", p.at("d.md"), "--pr", "701", "--branch", ".:dev").status, 0);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 1);
  p.rewrite("d.md", draft);
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
});

test("a post refused for a moved PR head is redrafted on the same path: pin-sources again, rewrite, lint, post", () => {
  const fe = siblingRepo({ slug: "o/fe" });
  const first = fe.pr(701);
  const profileDir = profileWith({ language: { chat: "en" } });
  mkdirSync(join(profileDir, "projects"));
  writeFileSync(join(profileDir, "projects", "p.md"), `\`\`\`json\n${JSON.stringify({ name: "p", paths: [fe.clone], repos: [{ path: ".", role: "FE", branch: "dev" }], language: { pr_review: "en" } })}\n\`\`\`\n`);
  const work = tempDir("tedy-work-");
  const draft = join(work, "d.md");
  const draftAt = (sha) => `# PR #701: comment line by line (head ${sha.slice(0, 7)})\n\n## 1. \`src/a.ts:10\`\nThe label is wrong.\n`;
  writeFileSync(join(work, "pr.diff"), CLEAN_DIFF);
  const options = { cwd: fe.clone, stateDir: tempDir("tedy-pinstate-"), profileDir };
  const lint = (...args) => runWithFakeGh(LINT, args, options);
  assert.equal(lint("pin-sources", draft, "--pr", "701", "--repo", "o/fe").status, 0);
  writeFileSync(draft, draftAt(first));
  assert.equal(lint("pr-comment", draft, "--diff", join(work, "pr.diff"), "--repo", "o/fe").status, 0);
  fe.push("src/z.ts", "z\n", "fix: the author pushed");
  const second = fe.pr(701);
  const refused = runWithFakeGh(WRITE, ["post", draft, "--repo", "o/fe"], { ...options, fixture: { diff: CLEAN_DIFF, head: second } });
  assert.equal(refused.status, 1, refused.out);
  assert.equal(refused.writes.length, 0);
  const again = lint("pin-sources", draft, "--pr", "701", "--repo", "o/fe");
  assert.equal(again.status, 0, again.out);
  writeFileSync(draft, draftAt(second));
  const relinted = lint("pr-comment", draft, "--diff", join(work, "pr.diff"), "--repo", "o/fe");
  assert.equal(relinted.status, 0, relinted.out);
  assert.match(relinted.out, /^original frozen for the edit log: /m);
  const posted = runWithFakeGh(WRITE, ["post", draft, "--repo", "o/fe"], { ...options, fixture: { diff: CLEAN_DIFF, head: second, write: { id: 9, html_url: "u" }, reviewComments: [{ id: 1, path: "src/a.ts", line: 10, commit_id: second }] } });
  assert.equal(posted.status, 0, posted.out);
  assert.equal(posted.writes.length, 1);
});

test("a pin-sources that fails keeps the draft's frozen original", () => {
  const p = project();
  assert.equal(p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff")).status, 0);
  const frozen = join(p.stateDir, "drafts", p.at("d.md").replace(/\//g, "_"));
  assert.ok(existsSync(frozen));
  git(p.be.clone, "remote", "set-url", "origin", join(p.be.root, "gone.git"));
  const failed = p.lint("pin-sources", p.at("d.md"), "--pr", "701");
  assert.equal(failed.status, 1, failed.out);
  assert.doesNotMatch(failed.out, /frozen original/);
  assert.ok(existsSync(frozen));
});

function originCalls(env = {}) {
  const p = project();
  assert.equal(p.lint("pin-sources", p.at("d.md"), "--pr", "701", "--branch", ".:dev").status, 0);
  p.rewrite("d.md", DRAFT);
  p.be.push("src/c.ts", "c1\n", "chore: pushed after the read, so the lint fetches it");
  git(p.fe.clone, "config", "core.sshCommand", "ssh -i /keys/review");
  const bin = tempDir("tedy-gitlog-");
  const log = join(bin, "calls.log");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, \`\${process.env.GIT_TERMINAL_PROMPT ?? "-"} [\${process.env.GIT_SSH_COMMAND ?? "-"}] {\${process.env.GIT_SSH ?? "-"}} \${args.join(" ")}\\n\`);\nprocess.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" }).status ?? 1);\n`);
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(log, "");
  const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  Object.assign(process.env, env, { PATH: `${bin}:${saved.PATH}` });
  try {
    const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
    assert.equal(result.status, 0, result.out);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { p, remote: readFileSync(log, "utf8").split("\n").filter((line) => / (ls-remote|fetch) /.test(line)) };
}

test("ssh runs in batch mode with GIT_SSH_COMMAND over core.sshCommand, and a GIT_SSH alone is left to git", () => {
  const forced = originCalls({ GIT_SSH_COMMAND: "ssh -p 2222" });
  assert.ok(forced.remote.length && forced.remote.every((line) => line.startsWith("0 [ssh -p 2222 -o BatchMode=yes] ")), forced.remote.join("\n"));
  const wrapper = originCalls({ GIT_SSH: "/usr/local/bin/ssh-wrapper" });
  assert.ok(wrapper.remote.some((line) => line.startsWith("0 [ssh -i /keys/review -o BatchMode=yes] {/usr/local/bin/ssh-wrapper} ") && line.includes(`-C ${wrapper.p.fe.clone} `)), wrapper.remote.join("\n"));
  const beLines = wrapper.remote.filter((line) => line.includes(`-C ${wrapper.p.be.clone} `));
  assert.ok(beLines.length && beLines.every((line) => line.startsWith("0 [-] {/usr/local/bin/ssh-wrapper} ")), wrapper.remote.join("\n"));
});

test("a lint with read pins asks origin only once per ref it pins, and git never prompts for credentials", () => {
  const { p, remote } = originCalls();
  assert.deepEqual(remote.filter((line) => line.includes("ls-remote")).length, 2, remote.join("\n"));
  assert.ok(remote.every((line) => line.startsWith("0 ")), remote.join("\n"));
  assert.ok(remote.some((line) => line.startsWith("0 [ssh -i /keys/review -o BatchMode=yes] {-} ") && line.includes(`-C ${p.fe.clone} `)), remote.join("\n"));
  assert.ok(remote.some((line) => line.startsWith("0 [ssh -o BatchMode=yes] {-} ") && line.includes(`-C ${p.be.clone} `)), remote.join("\n"));
  assert.ok(remote.some((line) => / fetch /.test(line)), remote.join("\n"));
  assert.ok(remote.every((line) => line.includes("-o BatchMode=yes] ")), remote.join("\n"));
});

test("a branch or PR the read pins lack is pinned at lint with a warning the record keeps, and a --branch read pin the draft does not cite is kept", () => {
  const p = project(draftWith("The label is wrong, `src/a.ts:1@feature/y` sets it."));
  git(p.be.root, "--git-dir", p.be.origin, "branch", "feature/x", "dev");
  git(p.be.root, "--git-dir", p.be.origin, "branch", "feature/y", "dev");
  assert.equal(p.lint("pin-sources", p.at("ledger.md"), "--pr", "701", "--branch", `${p.be.clone}:feature/x`).status, 0);
  p.rewrite("d.md", draftWith("The label is wrong, `src/a.ts:1@feature/y` sets it."));
  const lint = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"), "--pinned-at", p.at("ledger.md"));
  assert.equal(lint.status, 0, lint.out);
  const warning = `warning: ${p.be.clone} origin/feature/y was not pinned by draft-lint.mjs pin-sources ${p.at("ledger.md")}, so it was pinned now, at lint`;
  assert.ok(lint.out.includes(`${warning}\n`), lint.out);
  assert.match(lint.out, new RegExp(`^pinned: ${escape(p.be.clone)} origin/feature/x@${p.beSha} \\(read \\S+\\)$`, "m"));
  const record = (file) => JSON.parse(readFileSync(join(p.stateDir, "drafts", `${file.replace(/\//g, "_")}.sources.json`), "utf8"));
  assert.deepEqual(record(p.at("d.md")).warnings, [warning]);
  assert.ok(record(p.at("d.md")).sources.some((pin) => pin.ref === "origin/feature/x" && pin.stage === "read"));
  p.fe.pr(702);
  p.rewrite("r.txt", "The label is still wrong.\n");
  const other = p.lint("pr-reply", p.at("r.txt"), "--pr", "702", "--pinned-at", p.at("ledger.md"));
  assert.equal(other.status, 0, other.out);
  assert.deepEqual(record(p.at("r.txt")).warnings, [`warning: . pull/702/head was not pinned by draft-lint.mjs pin-sources ${p.at("ledger.md")}, so it was pinned now, at lint`]);
});

test("a push to the PR head during the read fails the lint", () => {
  const p = project();
  assert.equal(p.lint("pin-sources", p.at("d.md"), "--pr", "701").status, 0);
  p.rewrite("d.md", DRAFT);
  p.fe.push("src/z.ts", "z\n", "fix: the author pushed during the review");
  p.fe.pr(701);
  const result = p.lint("pr-comment", p.at("d.md"), "--diff", p.at("pr.diff"));
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^sources: refused: \. pull\/701\/head moved from .* since it was pinned, so the PR under review changed$/m);
});

test("a reply lint reads the read pins of another file with --pinned-at", () => {
  const p = project();
  assert.equal(p.lint("pin-sources", p.at("ledger.md"), "--pr", "701").status, 0);
  p.rewrite("r.txt", "The label is still wrong, see src/a.ts.\n");
  p.be.push("src/a.ts", "a2\n", "fix: writer sets the field");
  const result = p.lint("pr-reply", p.at("r.txt"), "--pr", "701", "--pinned-at", p.at("ledger.md"));
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /^sources: refused: .* since it was pinned and changed a file the text being posted names$/m);
  assert.ok(result.out.includes(`run draft-lint.mjs pin-sources ${p.at("ledger.md")} again`), result.out);
});

test("pr-reply lints the body like a review comment and writes no pin when it fails", () => {
  const p = project();
  writeFileSync(p.at("r.txt"), "thanks, still wrong\n");
  const result = p.lint("pr-reply", p.at("r.txt"), "--pr", "701");
  assert.equal(result.status, 1);
  assert.match(result.out, /the first line must end with "\."/);
  writeFileSync(p.at("r.txt"), "The label is still wrong.\n");
  assert.match(p.write(["reply", "701", "123", "--repo", "o/r", "--body-file", p.at("r.txt")]).out, /^refused: .*r\.txt has no pinned sources/m);
});
