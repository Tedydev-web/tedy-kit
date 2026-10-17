import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { archive, draftFiles, gitWaiting, repoDirs, stub, waitingText } from "../lib/pending.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });

function project() {
  const root = tempDir("tedy-pending-");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", join(root, "fe")]);
  const fe = join(root, "fe");
  writeFileSync(join(fe, "a.txt"), "a\n");
  git(fe, "add", "a.txt");
  git(fe, "commit", "-q", "-m", "a");
  git(fe, "remote", "add", "origin", remote);
  git(fe, "push", "-q", "-u", "origin", "main");
  writeFileSync(join(fe, "b.txt"), "b\n");
  git(fe, "add", "b.txt");
  git(fe, "commit", "-q", "-m", "b");
  git(fe, "switch", "-q", "-c", "feat");
  writeFileSync(join(fe, "c.txt"), "c\n");
  git(fe, "add", "c.txt");
  git(fe, "commit", "-q", "-m", "c");
  git(fe, "switch", "-q", "-c", "old", "main~1");
  git(fe, "switch", "-q", "-c", "backup/x");
  writeFileSync(join(fe, "d.txt"), "d\n");
  git(fe, "add", "d.txt");
  git(fe, "commit", "-q", "-m", "d");
  git(fe, "switch", "-q", "feat");
  mkdirSync(join(root, "be"));
  for (const dir of [join(root, "plans", "drafts"), join(fe, "plans", "drafts"), join(root, "be", "plans", "drafts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "plans", "drafts", "doc-comments.md"), "x\n");
  writeFileSync(join(fe, "plans", "drafts", "review-pr12.md"), "x\n");
  writeFileSync(join(root, "be", "plans", "drafts", "ignored.md"), "x\n");
  const map = { name: "shop", paths: [root], repos: [{ path: "fe", role: "FE" }, { path: "be", role: "BE", readonly: true }], sessions: [{ name: "PM - Shop", role: "pm" }] };
  return { root, fe, map };
}

test("the waiting list covers drafts in the project and its writable repos, and unpushed work on checked-out or tracking branches", () => {
  const { root, fe, map } = project();
  assert.deepEqual(repoDirs(map), [root, fe]);
  assert.deepEqual(draftFiles(repoDirs(map)), [join(root, "plans", "drafts", "doc-comments.md"), join(fe, "plans", "drafts", "review-pr12.md")]);
  assert.deepEqual(gitWaiting(fe), ["feat: 2 commits on no remote", "main: 1 commit ahead of origin/main"]);
  assert.deepEqual(gitWaiting(root), []);
});

test("done moves a file under plans into plans/archive and logs the move", () => {
  const { root, map } = project();
  const from = join(root, "plans", "drafts", "doc-comments.md");
  const to = archive(from, map);
  assert.equal(to, join(root, "plans", "archive", "drafts", "doc-comments.md"));
  assert.ok(existsSync(to) && !existsSync(from));
  assert.equal(readFileSync(join(root, "plans", "archive", "MOVES.tsv"), "utf8"), `from\tto\n${from}\t${to}\n`);
  writeFileSync(join(root, "outside.md"), "x\n");
  assert.throws(() => archive(join(root, "outside.md"), map), /not under plans\/ of this project/);
});

test("stub writes a one-line draft for an action with no file of its own", () => {
  const { root, map } = project();
  const file = stub(map, "Nhắn PM chốt màn Đổi tên");
  assert.match(file, new RegExp(`^${join(root, "plans", "drafts")}/\\d{6}-\\d{4}-nhan-pm-chot-man-doi-ten\\.md$`));
  assert.equal(readFileSync(file, "utf8"), "Nhắn PM chốt màn Đổi tên\n");
});

test("list prints every group from the project directory, offline skipping GitHub", () => {
  const { root, map } = project();
  const profile = profileWith({});
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# Shop\n\n\`\`\`json\n${JSON.stringify(map)}\n\`\`\`\n`);
  const out = spawnSync("node", [new URL("../lib/pending.mjs", import.meta.url).pathname, "list", "--offline"], { cwd: root, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Drafts waiting on the user:\n- .*doc-comments\.md\n- .*review-pr12\.md$/m);
  assert.match(out.stdout, /^Unpushed work:\n- fe feat: 2 commits on no remote\n- fe main: 1 commit ahead of origin\/main$/m);
  assert.doesNotMatch(out.stdout, /Draft PRs/);
});

test("the session-start notice lists local drafts and unpushed work, leaving hand-offs to their own notice", async () => {
  const { waitingNotice } = await import("../lib/session-hooks.mjs");
  const { map } = project();
  const notice = waitingNotice(map);
  assert.match(notice, /^Waiting on the user in this project/);
  assert.match(notice, /review-pr12\.md/);
  assert.match(notice, /fe main: 1 commit ahead of origin\/main/);
  assert.doesNotMatch(notice, /Hand-offs not taken yet|Draft PRs/);
});

test("stub never overwrites another stub and refuses an action with no words", () => {
  const { map } = project();
  const first = stub(map, "Gọi PM");
  const second = stub(map, "Gọi PM!");
  assert.notEqual(first, second);
  assert.equal(readFileSync(first, "utf8"), "Gọi PM\n");
  assert.throws(() => stub(map, "!!!"), /no words/);
});

test("done refuses to overwrite a file already archived under the same name", () => {
  const { root, map } = project();
  const from = join(root, "plans", "drafts", "doc-comments.md");
  archive(from, map);
  writeFileSync(from, "again\n");
  assert.throws(() => archive(from, map), /already archived/);
  assert.ok(existsSync(from));
});

test("a waiting list that cannot be read leaves the other session-start notices alone", async () => {
  const { waitingNotice } = await import("../lib/session-hooks.mjs");
  const { root, map } = project();
  const { rmSync } = await import("node:fs");
  rmSync(join(root, "plans", "drafts"), { recursive: true });
  writeFileSync(join(root, "plans", "drafts"), "not a directory\n");
  assert.equal(waitingNotice(map), "");
});

test("the session-start notice shows at most ten drafts and counts the rest", async () => {
  const { waitingNotice } = await import("../lib/session-hooks.mjs");
  const { root, map } = project();
  for (let n = 0; n < 12; n += 1) writeFileSync(join(root, "plans", "drafts", `extra-${String(n).padStart(2, "0")}.md`), "x\n");
  const notice = waitingNotice(map);
  assert.match(notice, /^- … 4 more$/m);
  assert.equal(waitingText(map, { offline: true }).split("\n").filter((line) => line.includes("extra-")).length, 12);
});

test("done archives only a file under plans/ of this project, and never a hand-off", () => {
  const { root, map } = project();
  const other = tempDir("tedy-pending-other-");
  mkdirSync(join(other, "plans", "x"), { recursive: true });
  writeFileSync(join(other, "plans", "x", "keep.md"), "x\n");
  assert.throws(() => archive(join(other, "plans", "x", "keep.md"), map), /not under plans\/ of this project/);
  assert.throws(() => archive(join(root, "plans", "drafts"), map), /not a file/);
  mkdirSync(join(root, "plans", "reports"), { recursive: true });
  writeFileSync(join(root, "plans", "reports", "handoff-1.md"), "to: a\nstatus: pending\n");
  assert.throws(() => archive(join(root, "plans", "reports", "handoff-1.md"), map), /handoff\.mjs done/);
  assert.ok(existsSync(join(other, "plans", "x", "keep.md")));
});

test("a checked-out branch whose upstream is gone, and a repo reached through a symlink, still show unpushed work", async () => {
  const { symlinkSync } = await import("node:fs");
  const { root, fe } = project();
  git(fe, "push", "-q", "-u", "origin", "feat");
  writeFileSync(join(fe, "e.txt"), "e\n");
  git(fe, "add", "e.txt");
  git(fe, "commit", "-q", "-m", "e");
  git(fe, "push", "-q", "origin", "--delete", "feat");
  git(fe, "fetch", "-q", "--prune");
  assert.deepEqual(gitWaiting(fe), ["feat: 3 commits on no remote", "main: 1 commit ahead of origin/main"]);
  symlinkSync(fe, join(root, "fe-link"));
  assert.deepEqual(gitWaiting(join(root, "fe-link")), gitWaiting(fe));
});

test("a GitHub read that fails is reported, not shown as an empty list", async () => {
  const { map } = project();
  const bin = tempDir("tedy-pending-bin-");
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n", { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    assert.match(waitingText(map), /^Could not check:\n- fe draft PRs: To get started with GitHub CLI/m);
  } finally {
    process.env.PATH = saved;
  }
});

test("a checked-out branch named like a directory still shows its unpushed commits", () => {
  const { fe } = project();
  mkdirSync(join(fe, "docs"));
  git(fe, "switch", "-q", "-c", "docs", "main~1");
  writeFileSync(join(fe, "docs", "a.md"), "a\n");
  git(fe, "add", "docs/a.md");
  git(fe, "commit", "-q", "-m", "docs");
  assert.ok(gitWaiting(fe).includes("docs: 1 commit on no remote"), gitWaiting(fe).join("; "));
});

test("done refuses a file that reaches plans/ only through a symlink to somewhere else", async () => {
  const { symlinkSync } = await import("node:fs");
  const { root, map } = project();
  const outside = tempDir("tedy-pending-outside-");
  writeFileSync(join(outside, "secret.txt"), "x\n");
  symlinkSync(outside, join(root, "plans", "link"));
  assert.throws(() => archive(join(root, "plans", "link", "secret.txt"), map), /not under plans\/ of this project/);
  assert.ok(existsSync(join(outside, "secret.txt")));
});

test("a tag named like the checked-out branch does not hide the branch's unpushed commits", () => {
  const { fe } = project();
  git(fe, "tag", "feat", "main");
  assert.deepEqual(gitWaiting(fe), ["feat: 2 commits on no remote", "main: 1 commit ahead of origin/main"]);
});

test("done archives into the project's own plans/archive even when a folder below plans is also named plans", () => {
  const { root, map } = project();
  mkdirSync(join(root, "plans", "drafts", "plans"), { recursive: true });
  writeFileSync(join(root, "plans", "drafts", "plans", "x.md"), "x\n");
  assert.equal(archive(join(root, "plans", "drafts", "plans", "x.md"), map), join(root, "plans", "archive", "drafts", "plans", "x.md"));
});

test("done refuses a pending hand-off reached through a symlinked alias of the project", async () => {
  const { symlinkSync } = await import("node:fs");
  const { root, map } = project();
  mkdirSync(join(root, "plans", "reports"), { recursive: true });
  writeFileSync(join(root, "plans", "reports", "handoff-1-to-pm.md"), "to: PM - Shop\nstatus: pending\n");
  const alias = join(tempDir("tedy-pending-alias-"), "link");
  symlinkSync(root, alias);
  assert.throws(() => archive(join(alias, "plans", "reports", "handoff-1-to-pm.md"), map), /handoff\.mjs done/);
  assert.ok(existsSync(join(root, "plans", "reports", "handoff-1-to-pm.md")));
});
