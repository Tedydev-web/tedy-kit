import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction, decide, roleCard, roleOf, sessionName } from "./role-gate.mjs";

const map = {
  name: "tonpass-family-wallet",
  paths: ["/w/tonpass"],
  repos: [{ path: "tonpass-wallet-fe" }, { path: "tonpass-wallet-be", readonly: true }, { path: "tonpass-wallet-admin-be" }],
  sessions: [
    { name: "PM - Family Wallet", role: "pm" },
    { name: "Review PR - Family Wallet", role: "review" },
    { name: "Dev TMA - Family Wallet", role: "dev", repos: ["tonpass-wallet-fe"] },
    { name: "Dev Admin - Family Wallet", role: "dev", repos: ["tonpass-wallet-admin-be"] },
    { name: "DevOps - Family Wallet", role: "devops" },
    { name: "Điều phối - Family Wallet", role: "dispatch" },
  ],
};
const bash = (command, cwd = "/w/tonpass") => classifyAction({ tool_name: "Bash", cwd, tool_input: { command } }, map);
const edit = (file_path) => classifyAction({ tool_name: "Edit", cwd: "/w/tonpass", tool_input: { file_path } }, map);

test("code edits are edits inside a mapped repository or worktree, outside plans and markdown", () => {
  assert.deepEqual(edit("/w/tonpass/tonpass-wallet-fe/apps/family/a.tsx"), { kind: "code", repo: "tonpass-wallet-fe" });
  assert.deepEqual(edit("/w/tonpass/tonpass-wallet-fe/.claude/worktrees/fix-x/apps/a.ts"), { kind: "code", repo: "tonpass-wallet-fe" });
  assert.deepEqual(edit("/w/tonpass/worktrees/rv701/src/a.ts"), { kind: "code", repo: null });
  assert.equal(edit("/w/tonpass/tonpass-wallet-fe/plans/reports/dev-x.md"), null);
  assert.equal(edit("/w/tonpass/plans/reports/pm-x.json"), null);
  assert.equal(edit("/w/tonpass/tonpass-wallet-fe/README.md"), null);
  assert.equal(edit("/home/u/Documents/workspace/tedy-kit/plugin/a.mjs"), null);
});

test("writes through the tracker, Doc, Figma and review scripts are classified; previews are not", () => {
  assert.equal(bash("node /k/scripts/openproject.mjs apply d.json").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed --apply --lock 3").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs preview d.json"), null);
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed"), null);
  assert.equal(bash("python3 ~/.agents/skills/pg-project-management/scripts/pg.py set 183 21298 --status Closed").kind, "tracker");
  assert.equal(bash("cd plans && node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/gdoc-comments.mjs edit AAA --reply BBB --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/figma-comments.mjs post 1:2 --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/doc-comment-file.mjs items.json").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/figma-comments.mjs list --since 2026-10-07"), null);
  assert.equal(bash("node /k/scripts/github-write.mjs post plans/reports/review-x.md").kind, "pr-review");
  assert.equal(bash("node /k/scripts/github-write.mjs reply 701 123 --body-file r.txt"), null);
});

test("commits and pushes count as code only inside a mapped repository", () => {
  assert.deepEqual(bash("cd tonpass-wallet-fe && git add -A && git commit -m x"), { kind: "code", repo: "tonpass-wallet-fe" });
  assert.deepEqual(bash("git -C /w/tonpass/tonpass-wallet-admin-be push -u origin feat/x"), { kind: "code", repo: "tonpass-wallet-admin-be" });
  assert.equal(bash("git commit -m x", "/w/tonpass"), null);
  assert.equal(bash("git -C /home/u/tedy-kit push origin main"), null);
  assert.equal(bash("cd tonpass-wallet-fe && git log --oneline -3"), null);
});

test("a map without sessions has nothing for the role gate to judge, so the fleet list is never read", () => {
  const noSessions = { ...map, sessions: undefined };
  assert.equal(classifyAction({ tool_name: "Bash", cwd: "/w/tonpass", tool_input: { command: "cd tonpass-wallet-fe && git commit -m x" } }, noSessions), null);
  assert.equal(classifyAction({ tool_name: "Edit", cwd: "/w/tonpass", tool_input: { file_path: "/w/tonpass/tonpass-wallet-fe/src/a.ts" } }, { ...map, sessions: [] }), null);
});

test("each role is asked only about the other roles' writes, and the owner session is named", () => {
  const prd = { kind: "doc-figma", repo: null };
  const code = { kind: "code", repo: "tonpass-wallet-admin-be" };
  assert.match(decide(map, "Dev TMA - Family Wallet", prd), /the dev session; Doc or Figma comments belongs to the pm session "PM - Family Wallet"/);
  assert.equal(decide(map, "Dev TMA - Family Wallet", { kind: "code", repo: "tonpass-wallet-fe" }), null);
  assert.match(decide(map, "PM - Family Wallet", code), /belongs to the dev session "Dev Admin - Family Wallet"/);
  assert.match(decide(map, "Review PR - Family Wallet", { kind: "code", repo: null }), /belongs to the dev session\. Hand it over/);
  assert.equal(decide(map, "Review PR - Family Wallet", { kind: "pr-review", repo: null }), null);
  assert.match(decide(map, "DevOps - Family Wallet", { kind: "tracker", repo: null }), /pm session "PM - Family Wallet"/);
  assert.equal(decide(map, "DevOps - Family Wallet", code), null);
  assert.equal(decide(map, "Agent Assistant", prd), null);
  assert.equal(decide(map, "PM - Family Wallet", null), null);
});

test("the session name comes from the fleet list, and the role card names the session and its siblings", () => {
  const list = [{ sessionId: "a-1", name: "PM - Family Wallet" }, { sessionId: "b-2", name: "work-17" }];
  assert.equal(sessionName("a-1", list), "PM - Family Wallet");
  assert.equal(sessionName("zz", list), null);
  assert.equal(roleOf(map, "work-17"), null);
  const card = roleCard(map, "Dev TMA - Family Wallet");
  assert.match(card, /^Role: this session is "Dev TMA - Family Wallet", the dev session of tonpass-family-wallet for tonpass-wallet-fe\./);
  assert.match(card, /"PM - Family Wallet" \(pm\)/);
  assert.match(card, /stop looking into it/);
  assert.equal(roleCard(map, "Agent Assistant"), "");
});

test("the dispatch session writes nothing itself and its card routes every request", () => {
  const name = "Điều phối - Family Wallet";
  for (const kind of ["code", "tracker", "doc-figma", "pr-review"]) assert.match(decide(map, name, { kind, repo: null }), /the dispatch session; .* belongs to the (dev|pm|review) session/);
  const card = roleCard(map, name);
  assert.match(card, /^Role: this session is "Điều phối - Family Wallet", the dispatch session of tonpass-family-wallet\. It does no role work itself/);
  assert.match(card, /"PM - Family Wallet" \(pm\)/);
  assert.match(card, /without the Chuyển việc question/);
  assert.doesNotMatch(roleCard(map, "PM - Family Wallet"), /dispatch section/);
});
