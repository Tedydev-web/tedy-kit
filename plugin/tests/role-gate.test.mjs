import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyAction, decide, roleCard, roleOf, sessionName } from "../gates/role-gate.mjs";
import * as gate from "../gates/role-gate.mjs";
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
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed --apply --lock 3").kind, "tracker-status");
  assert.equal(bash('node /k/scripts/openproject.mjs set 21298 --status "Fixed (Dev Done)" --assignee "Tess Ter" --apply --lock 3').kind, "tracker-status");
  assert.equal(bash("node /k/scripts/openproject.mjs set 21298 --status Closed --estimate 4 --apply --lock 3").kind, "tracker");
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

test("shell sent through the context-mode tools is classified like the same Bash command", () => {
  const ctx = (tool, tool_input) => classifyAction({ tool_name: `mcp__plugin_context-mode_context-mode__${tool}`, cwd: "/w/acme", tool_input }, map);
  assert.deepEqual(ctx("ctx_execute", { language: "shell", code: "cd acme-shop-fe && git commit -m x" }), { kind: "code", repo: "acme-shop-fe" });
  assert.deepEqual(ctx("ctx_execute", { language: "shell", code: "git commit -m x", cwd: "/w/acme/acme-shop-fe" }), { kind: "code", repo: "acme-shop-fe" });
  assert.deepEqual(ctx("ctx_execute_file", { path: "x", language: "shell", code: "git -C /w/acme/acme-shop-admin-be push" }), { kind: "code", repo: "acme-shop-admin-be" });
  assert.equal(ctx("ctx_batch_execute", { commands: [{ label: "a", command: "git status" }, { label: "b", command: "node /k/scripts/openproject.mjs apply d.json" }] }).kind, "tracker");
  assert.equal(ctx("ctx_execute", { language: "python", code: "import os" }), null);
  assert.equal(ctx("ctx_batch_execute", { commands: [{ label: "a", command: "git status" }] }), null);
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
  const status = { kind: "tracker-status", repo: null };
  assert.equal(decide(map, "Dev TMA - Shop", status), null);
  assert.equal(decide(map, "Review PR - Shop", status), null);
  assert.match(decide(map, "Dispatch - Shop", status) ?? "", /changing a work package's status or assignee belongs to the pm session/);
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

const noSessions = { ...map, sessions: undefined };
const roleFile = (id) => join(process.env.TEDY_STATE_DIR, "session-roles", id);
const editCode = { tool_name: "Edit", cwd: "/w/acme", tool_input: { file_path: "/w/acme/acme-shop-fe/src/a.ts" } };
const shell = (command) => ({ tool_name: "Bash", cwd: "/w/acme", tool_input: { command } });
const comment = shell("node /k/scripts/openproject.mjs comment 1 --body-file b --apply");
const postReview = shell("node /k/scripts/github-write.mjs post plans/reports/review-x.md");
function counted(rows = []) {
  const list = () => {
    list.calls += 1;
    return rows;
  };
  list.calls = 0;
  return list;
}
const job = (agent_type, session_id = randomUUID()) => ({ agent_type, session_id });

test("a review job asks before editing product code in a map with no sessions, and never reads the fleet list", () => {
  const list = counted();
  const verdict = gate.judge({ ...editCode, ...job("tedy:review") }, noSessions, list);
  assert.match(verdict.reason, /^tedy role gate: this is a review job \(tedy:review\); changing or committing product code belongs to the dev role\. Leave a draft under plans\/drafts for it, unless the user allows this one here\.$/);
  assert.equal(verdict.role, "review");
  assert.equal(list.calls, 0);
});

test("a dev job asks before a tracker comment but may move a work package's status", () => {
  const list = counted();
  assert.match(gate.judge({ ...comment, ...job("tedy:dev") }, noSessions, list).reason, /this is a dev job \(tedy:dev\); writing to the tracker belongs to the pm role/);
  const status = gate.judge({ ...shell("node /k/scripts/openproject.mjs set 1 --status X --apply --lock 3"), ...job("tedy:dev") }, noSessions, list);
  assert.equal(status.kind, "tracker-status");
  assert.equal(status.reason, null);
  assert.equal(list.calls, 0);
});

test("a devops job asks before a tracker comment and may edit product code", () => {
  assert.match(gate.judge({ ...comment, ...job("tedy:devops") }, noSessions, counted()).reason, /this is a devops job \(tedy:devops\); writing to the tracker belongs to the pm role/);
  assert.equal(gate.judge({ ...editCode, ...job("tedy:devops") }, noSessions, counted()).reason, null);
});

test("the first main-thread call of a job records its role even when it classifies to nothing", () => {
  const id = randomUUID();
  assert.equal(gate.judge({ tool_name: "Read", cwd: "/w/acme", tool_input: { file_path: "/w/acme/a.ts" }, ...job("tedy:dev", id) }, noSessions, counted()), null);
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
  assert.deepEqual(gate.agentRole(job("tedy:pm", id)), { role: "pm", label: "tedy:pm" });
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
  assert.deepEqual(gate.agentRole(job("tedy:dev", "../escape")), { role: "dev", label: "tedy:dev" });
  assert.equal(existsSync(join(process.env.TEDY_STATE_DIR, "escape")), false);
});

test("a reviewer subagent of a job is a reader, and every write kind asks", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const reviewer = { agent_type: "tedy:reviewer", agent_id: "a-1", session_id: id };
  const writes = [editCode, comment, postReview, shell("node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt"), shell("node /k/scripts/openproject.mjs set 1 --status X --apply --lock 3")];
  for (const write of writes) assert.match(gate.judge({ ...write, ...reviewer }, noSessions, counted())?.reason ?? "", /^tedy role gate: this is a reader job \(tedy:reviewer\); /, write.tool_input.command ?? write.tool_name);
});

test("any other subagent of a job takes the job's role", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const verdict = gate.judge({ ...postReview, agent_type: "Explore", agent_id: "a-2", session_id: id }, noSessions, counted());
  assert.match(verdict.reason, /this is a dev job \(Explore\); posting or resolving PR review comments belongs to the review role/);
  assert.equal(gate.agentRole({ agent_type: "Explore", agent_id: "a-3", session_id: randomUUID() }), null);
});

test("another plugin's agent on the main thread has no tedy role, so a map without sessions judges nothing", () => {
  const id = randomUUID();
  assert.equal(gate.agentRole(job("other:dev", id)), null);
  assert.equal(gate.judge({ ...editCode, ...job("other:dev", id) }, noSessions, counted()), null);
  assert.equal(existsSync(roleFile(id)), false);
});

test("a call without agent_type in a map with sessions gets today's result through one fleet read, and an unclassified one reads nothing", () => {
  const id = randomUUID();
  const list = counted([{ sessionId: id, name: "Dev TMA - Shop" }]);
  const prd = shell("node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt");
  const verdict = gate.judge({ ...prd, session_id: id }, map, list);
  assert.equal(verdict.reason, decide(map, "Dev TMA - Shop", { kind: "doc-figma", repo: null }));
  assert.equal(verdict.session, "Dev TMA - Shop");
  assert.equal(list.calls, 1);
  assert.equal(gate.judge({ ...shell("git status"), session_id: id }, map, list), null);
  assert.equal(list.calls, 1);
});

test("a reviewer subagent of a legacy session gets its parent session's result", () => {
  const id = randomUUID();
  const list = counted([{ sessionId: id, name: "Dev TMA - Shop" }]);
  const verdict = gate.judge({ ...postReview, agent_type: "tedy:reviewer", agent_id: "a-4", session_id: id }, map, list);
  assert.equal(verdict.reason, decide(map, "Dev TMA - Shop", { kind: "pr-review", repo: null }));
  assert.equal(list.calls, 1);
});

test("recording a session's role prunes role files older than a week", () => {
  mkdirSync(join(process.env.TEDY_STATE_DIR, "session-roles"), { recursive: true });
  const old = randomUUID();
  const fresh = randomUUID();
  writeFileSync(roleFile(old), "pm");
  writeFileSync(roleFile(fresh), "pm");
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(roleFile(old), eightDaysAgo, eightDaysAgo);
  gate.agentRole(job("tedy:review"));
  assert.equal(existsSync(roleFile(old)), false);
  assert.equal(existsSync(roleFile(fresh)), true);
});

test("the gate entry asks a job from its agent_type without a fleet lookup and logs the agent type and role", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [{ path: "fe", role: "FE" }] })}\n\`\`\`\n`);
  const bin = tempDir("tedy-role-bin-");
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "claude"), 0o755);
  const stateDir = tempDir("tedy-role-state-");
  const input = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(root, "fe", "src", "a.ts") }, cwd: root, session_id: "sess-9", agent_type: "tedy:review" });
  const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir },
  });
  const decision = JSON.parse(out).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, /this is a review job \(tedy:review\); changing or committing product code belongs to the dev role/);
  const logged = readFileSync(join(stateDir, "gate-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(logged.map(({ hook, decision: verdict, agent_type, role, kind }) => ({ hook, verdict, agent_type, role, kind })), [{ hook: "role-gate", verdict: "ask", agent_type: "tedy:review", role: "review", kind: "code" }]);
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
