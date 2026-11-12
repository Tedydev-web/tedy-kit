import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluate } from "../gates/git-gate.mjs";
import { card, cardCheck, cardStart } from "../lib/pending.mjs";
import { git } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPTS = new URL("../scripts/", import.meta.url).pathname.replace(/\/$/, "");
const JOB = "plans/jobs/261112-1600-review-pr-963.md";

function project() {
  const root = tempDir("tedy-cards-merge-");
  mkdirSync(join(root, "plans", "drafts"), { recursive: true });
  mkdirSync(join(root, "plans", "jobs"), { recursive: true });
  writeFileSync(join(root, JOB), "to: tedy:review\nfrom: cockpit\nstatus: done\ncreated: c\ntitle: Review 963\n\nx\n");
  const draft = join(root, "plans", "drafts", "reply-963.md");
  writeFileSync(draft, "Fixed it.\n");
  const repos = ["fe", "be"].map((name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", `https://github.com/o/r-${name}.git`);
    return { path: name, role: name.toUpperCase() };
  });
  return { root, draft, map: { name: "shop", paths: [root], repos } };
}

const publish = (map, body, extra = {}) => card(map, "publish", { title: "T", preview: "ready", body: `${body}\n`, ...extra });

test("a ready card with no draft holds verbs that read no file, such as resolve, and runs through card-check and card-start", () => {
  const { map } = project();
  const gw = `node ${SCRIPTS}/github-write.mjs`;
  const file = publish(map, `### 1\n${gw} resolve PRRT_a PRRT_b --job ${JOB.split("/").pop()}\nthreads a and b\n\n### 2\n${gw} unresolve PRRT_c --job ${JOB.split("/").pop()}\n\n### 3\n${gw} minimize IC_x --job ${JOB.split("/").pop()}`, { job: JOB });
  assert.equal(cardCheck(file, map), 3);
  assert.equal(cardStart(file, map), 3);
});

test("a ready card with no draft refuses a block whose verb reads a file, naming the block and the verb", () => {
  const { draft, map } = project();
  const gw = `node ${SCRIPTS}/github-write.mjs`;
  assert.throws(() => publish(map, `### 1\n${gw} resolve PRRT_a\n\n### 2\n${gw} reply 963 9 --body-file ${draft} --repo o/r`), /a preview: ready card needs draft: because block 2 runs github-write\.mjs reply, which reads a file/);
  assert.throws(() => publish(map, `### 1\n${gw} post ${draft} --repo o/r`), /needs draft: because block 1 runs github-write\.mjs post/);
  assert.throws(() => publish(map, `### 1\n${gw} resolve PRRT_a`, { draft }), /block 1 does not read its draft .*: github-write\.mjs resolve reads no file, so write the card without --draft/);
});

test("a card block may be exactly gh pr merge <n> --repo <owner/repo> --merge, --squash or --rebase, with no --job, and git-gate asks before it runs", () => {
  const { map } = project();
  for (const method of ["merge", "squash", "rebase"]) {
    const command = `gh pr merge 963 --repo o/r-fe --${method}`;
    const file = publish(map, `### 1\n${command}\nmerge PR #963`, { job: JOB });
    assert.equal(cardCheck(file, map), 1);
    const verdict = evaluate(command, "/tmp");
    assert.equal(verdict.ask, true, method);
    assert.match(verdict.reason, /belongs to the user/);
  }
  const withStatus = publish(map, `### 1\ngh pr merge 963 --repo o/r-fe --squash\n\n### 2\nnode ${SCRIPTS}/openproject.mjs set 21298 --status Closed --apply --lock 4 --job ${JOB.split("/").pop()}\n- #21298 In review → Closed`, { job: JOB });
  assert.equal(cardCheck(withStatus, map), 2);
  for (const command of [
    "gh pr merge 963 --repo o/r --squash --admin",
    "gh pr merge 963 --repo o/r --squash --auto",
    "gh pr merge 963 --repo o/r --squash --delete-branch",
    "gh pr merge 963 --squash",
    "gh pr merge 963 --repo o/r --fast",
    "gh pr merge abc --repo o/r --squash",
    "gh pr merge 963 --squash --repo o/r",
    "gh pr view 963 --repo o/r",
  ]) assert.throws(() => publish(map, `### 1\n${command}`), /block 1 is not exactly gh pr merge <n> --repo <owner\/repo> --merge\|--squash\|--rebase, the one gh command a card may hold/, command);
  assert.throws(() => card(map, "publish", { title: "T", preview: "run", body: "### 1\ngh pr merge 963 --repo o/r-fe --squash\n" }), /block 1 merges a PR, so it belongs on a preview: ready card/);
});

test("a merge block must be block 1, only one per card, and merge a repo of the project map", () => {
  const { map } = project();
  const set = `node ${SCRIPTS}/openproject.mjs set 21298 --status Closed --apply --lock 4`;
  assert.throws(() => publish(map, `### 1\n${set}\n\n### 2\ngh pr merge 963 --repo o/r-fe --squash`), /block 2 merges a PR, so it must be block 1 of its card, before any other write/);
  assert.throws(() => publish(map, "### 1\ngh pr merge 963 --repo o/r-fe --squash\n\n### 2\ngh pr merge 964 --repo o/r-be --squash"), /block 2 is a second merge; a card holds at most one/);
  assert.throws(() => publish(map, "### 1\ngh pr merge 963 --repo o/other --squash"), /block 1 merges o\/other, which is not a repo of the project map \(o\/r-fe, o\/r-be\)/);
  assert.ok(publish(map, "### 1\ngh pr merge 963 --repo O/R-BE --squash"));
});
