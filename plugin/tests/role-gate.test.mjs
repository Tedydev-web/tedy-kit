import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAction, decide, roleCard, roleOf, sessionName } from "../gates/role-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const map = {
  name: "acme-shop",
  paths: ["/w/acme"],
  repos: [{ path: "acme-shop-fe" }, { path: "acme-shop-be", readonly: true }, { path: "acme-shop-admin-be" }],
  sessions: [
    { name: "PM - Shop", role: "pm" },
    { name: "Review PR - Shop", role: "review" },
    { name: "Dev TMA - Shop", role: "dev", repos: ["acme-shop-fe"] },
    { name: "Dev Admin - Shop", role: "dev", repos: ["acme-shop-admin-be"] },
    { name: "DevOps - Shop", role: "devops" },
    { name: "Dispatch - Shop", role: "dispatch" },
  ],
};
const bash = (command, cwd = "/w/acme") => classifyAction({ tool_name: "Bash", cwd, tool_input: { command } }, map);
const edit = (file_path) => classifyAction({ tool_name: "Edit", cwd: "/w/acme", tool_input: { file_path } }, map);

test("code edits are edits inside a mapped repository or worktree, outside plans and markdown", () => {
  assert.deepEqual(edit("/w/acme/acme-shop-fe/apps/family/a.tsx"), { kind: "code", repo: "acme-shop-fe" });
  assert.deepEqual(edit("/w/acme/acme-shop-fe/.claude/worktrees/fix-x/apps/a.ts"), { kind: "code", repo: "acme-shop-fe" });
  assert.deepEqual(edit("/w/acme/worktrees/rv701/src/a.ts"), { kind: "code", repo: null });
  assert.equal(edit("/w/acme/acme-shop-fe/plans/reports/dev-x.md"), null);
  assert.equal(edit("/w/acme/plans/reports/pm-x.json"), null);
  assert.equal(edit("/w/acme/acme-shop-fe/README.md"), null);
  assert.equal(edit("/srv/u/Documents/workspace/tedy-kit/plugin/a.mjs"), null);
});

test("writes through the tracker, Doc, Figma and review scripts are classified; previews are not", () => {
  assert.equal(bash("node /k/scripts/openproject.mjs apply d.json").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed --apply --lock 3").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs preview d.json"), null);
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed"), null);
  assert.equal(bash("python3 ~/.agents/skills/pg-project-management/scripts/pg.py set 183 21298 --status Closed").kind, "tracker");
  assert.equal(bash("cd plans && node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/gdoc-comments.mjs edit AAA --reply BBB --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/gdoc-comments.mjs delete AAA --reply BBB").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/gdoc-comments.mjs changed --since 2026-10-13"), null);
  assert.equal(bash("node /k/scripts/openproject.mjs comment-edit 991 --body-file b.txt --apply").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs comment-edit 991 --body-file b.txt"), null);
  assert.equal(bash("node /k/scripts/openproject.mjs relation 21448 21450 --type blocks --apply").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs relation-delete 1000 --apply").kind, "tracker");
  assert.equal(bash("node /k/scripts/openproject.mjs relation 21448 21450 --type blocks"), null);
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --due 2026-10-20 --apply --lock 3").kind, "tracker");
  assert.equal(bash("node /k/scripts/github-write.mjs unresolve PRRT_1").kind, "pr-review");
  assert.equal(bash("node /k/scripts/figma-comments.mjs post 1:2 --body-file b.txt").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/doc-comment-file.mjs items.json").kind, "doc-figma");
  assert.equal(bash("node /k/scripts/figma-comments.mjs list --since 2026-10-07"), null);
  assert.equal(bash("node /k/scripts/github-write.mjs post plans/reports/review-x.md").kind, "pr-review");
  assert.equal(bash("node /k/scripts/github-write.mjs reply 701 123 --body-file r.txt"), null);
});

test("commits and pushes count as code only inside a mapped repository", () => {
  assert.deepEqual(bash("cd acme-shop-fe && git add -A && git commit -m x"), { kind: "code", repo: "acme-shop-fe" });
  assert.deepEqual(bash("git -C /w/acme/acme-shop-admin-be push -u origin feat/x"), { kind: "code", repo: "acme-shop-admin-be" });
  assert.equal(bash("git commit -m x", "/w/acme"), null);
  assert.equal(bash("git -C /srv/u/tedy-kit push origin main"), null);
  assert.equal(bash("cd acme-shop-fe && git log --oneline -3"), null);
});

test("a map without sessions has nothing for the role gate to judge, so the fleet list is never read", () => {
  const noSessions = { ...map, sessions: undefined };
  assert.equal(classifyAction({ tool_name: "Bash", cwd: "/w/acme", tool_input: { command: "cd acme-shop-fe && git commit -m x" } }, noSessions), null);
  assert.equal(classifyAction({ tool_name: "Edit", cwd: "/w/acme", tool_input: { file_path: "/w/acme/acme-shop-fe/src/a.ts" } }, { ...map, sessions: [] }), null);
});

test("each role is asked only about the other roles' writes, and the owner session is named", () => {
  const prd = { kind: "doc-figma", repo: null };
  const code = { kind: "code", repo: "acme-shop-admin-be" };
  assert.match(decide(map, "Dev TMA - Shop", prd), /the dev session; Doc or Figma comments belongs to the pm session "PM - Shop"/);
  assert.equal(decide(map, "Dev TMA - Shop", { kind: "code", repo: "acme-shop-fe" }), null);
  assert.match(decide(map, "PM - Shop", code), /belongs to the dev session "Dev Admin - Shop"/);
  assert.match(decide(map, "Review PR - Shop", { kind: "code", repo: null }), /belongs to the dev session\. Hand it over/);
  assert.equal(decide(map, "Review PR - Shop", { kind: "pr-review", repo: null }), null);
  assert.match(decide(map, "DevOps - Shop", { kind: "tracker", repo: null }), /pm session "PM - Shop"/);
  assert.equal(decide(map, "DevOps - Shop", code), null);
  assert.equal(decide(map, "Agent Assistant", prd), null);
  assert.equal(decide(map, "PM - Shop", null), null);
});

test("the session name comes from the fleet list, and the role card names the session and its siblings", () => {
  const list = [{ sessionId: "a-1", name: "PM - Shop" }, { sessionId: "b-2", name: "work-17" }];
  assert.equal(sessionName("a-1", list), "PM - Shop");
  assert.equal(sessionName("zz", list), null);
  assert.equal(roleOf(map, "work-17"), null);
  const card = roleCard(map, "Dev TMA - Shop");
  assert.match(card, /^Role: this session is "Dev TMA - Shop", the dev session of acme-shop for acme-shop-fe\./);
  assert.match(card, /"PM - Shop" \(pm\)/);
  assert.match(card, /stop looking into it/);
  assert.equal(roleCard(map, "Agent Assistant"), "");
});

test("the role card promises a prompt only when the role gate is on", () => {
  assert.match(roleCard(map, "PM - Shop"), /asks the user first/);
  assert.doesNotMatch(roleCard(map, "PM - Shop", false), /asks the user first/);
});

test("the dispatch session writes nothing itself and its card routes every request", () => {
  const name = "Dispatch - Shop";
  for (const kind of ["code", "tracker", "doc-figma", "pr-review"]) assert.match(decide(map, name, { kind, repo: null }), /the dispatch session; .* belongs to the (dev|pm|review) session/);
  const card = roleCard(map, name);
  assert.match(card, /^Role: this session is "Dispatch - Shop", the dispatch session of acme-shop\. It does no role work itself/);
  assert.match(card, /"PM - Shop" \(pm\)/);
  assert.match(card, /without the hand-off question/);
  assert.doesNotMatch(roleCard(map, "PM - Shop"), /dispatch section/);
});

test("the gate entry asks and names the owning session when a write belongs to another role", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  const data = {
    name: "acme-shop",
    paths: [root],
    repos: [{ path: "fe", role: "FE" }],
    sessions: [{ name: "Dev - Shop", role: "dev", repos: ["fe"] }, { name: "PM - Shop", role: "pm" }],
  };
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`);
  const bin = tempDir("tedy-role-bin-");
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{ sessionId: "sess-1", name: "Dev - Shop" }]));\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const stateDir = tempDir("tedy-role-state-");
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "node /k/openproject.mjs apply d.json" }, cwd: root, session_id: "sess-1" });
  const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir },
  });
  const decision = JSON.parse(out).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, /this is "Dev - Shop", the dev session; writing to the tracker belongs to the pm session "PM - Shop"/);
});

test("role-gate asks when it cannot read the project maps", () => {
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "broken.md"), "# no json block\n");
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: "/tmp", session_id: "s" });
  const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: tempDir("tedy-state-") } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});
