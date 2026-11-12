import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyAction } from "../gates/role-gate.mjs";
import * as gate from "../gates/role-gate.mjs";
import { isReviewer } from "../gates/reviewer-gate.mjs";
import { recordLaunch } from "../lib/job-files.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const map = {
  name: "acme-shop",
  paths: ["/w/acme"],
  repos: [{ path: "acme-shop-fe" }, { path: "acme-shop-be", readonly: true }, { path: "acme-shop-admin-be" }],
};
const JOBS_DOC = new URL("../shared/jobs.md", import.meta.url).pathname;
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

test("a write is classified in every map, with or without the legacy sessions and jobs keys", () => {
  const commit = { tool_name: "Bash", cwd: "/w/acme", tool_input: { command: "cd acme-shop-fe && git commit -m x" } };
  for (const extra of [{}, { sessions: [{ name: "PM - Shop", role: "pm" }] }, { jobs: false }, { jobs: true }]) assert.deepEqual(classifyAction(commit, { ...map, ...extra }), { kind: "code", repo: "acme-shop-fe" }, JSON.stringify(extra));
});

const roleFile = (id) => join(process.env.TEDY_STATE_DIR, "session-roles", id);
const editCode = { tool_name: "Edit", cwd: "/w/acme", tool_input: { file_path: "/w/acme/acme-shop-fe/src/a.ts" } };
const shell = (command) => ({ tool_name: "Bash", cwd: "/w/acme", tool_input: { command } });
const comment = shell("node /k/scripts/openproject.mjs comment 1 --body-file b --apply");
const postReview = shell("node /k/scripts/github-write.mjs post plans/reports/review-x.md");
const job = (agent_type, session_id = randomUUID()) => ({ agent_type, session_id });

test("a review job asks before editing product code", () => {
  const verdict = gate.judge({ ...editCode, ...job("tedy:review") }, map);
  assert.equal(verdict.reason, `tedy role gate: this is a review job (tedy:review); changing or committing product code belongs to the dev role. Write a card, or a question card to start a dev job, per ${JOBS_DOC}, unless the user allows this one here.`);
  assert.equal(verdict.role, "review");
});

test("a dev job asks before a tracker comment but may move a work package's status", () => {
  assert.match(gate.judge({ ...comment, ...job("tedy:dev") }, map).reason, /this is a dev job \(tedy:dev\); writing to the tracker belongs to the pm role/);
  const status = gate.judge({ ...shell("node /k/scripts/openproject.mjs set 1 --status X --apply --lock 3"), ...job("tedy:dev") }, map);
  assert.equal(status.kind, "tracker-status");
  assert.equal(status.reason, null);
});

test("a devops job asks before a tracker comment and may edit product code", () => {
  assert.match(gate.judge({ ...comment, ...job("tedy:devops") }, map).reason, /this is a devops job \(tedy:devops\); writing to the tracker belongs to the pm role/);
  assert.equal(gate.judge({ ...editCode, ...job("tedy:devops") }, map).reason, null);
});

test("the first main-thread call of a job records its role even when it classifies to nothing", () => {
  const id = randomUUID();
  assert.equal(gate.judge({ tool_name: "Read", cwd: "/w/acme", tool_input: { file_path: "/w/acme/a.ts" }, ...job("tedy:dev", id) }, map), null);
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
  assert.deepEqual(gate.agentRole(job("tedy:pm", id)), { role: "pm", label: "tedy:pm" });
  assert.equal(readFileSync(roleFile(id), "utf8"), "pm");
  assert.deepEqual(gate.agentRole(job("tedy:dev", "../escape")), { role: "dev", label: "tedy:dev" });
  assert.equal(existsSync(join(process.env.TEDY_STATE_DIR, "escape")), false);
  assert.match(readFileSync(join(process.env.TEDY_STATE_DIR, "gate-log.jsonl"), "utf8"), /"decision":"session-role-unsafe-id","agent_type":"tedy:dev","session":"\.\.\/escape"/);
});

test("a role file that names no job role gives a subagent no role", () => {
  for (const content of ["x", "dispatch", "reader", ""]) {
    const id = randomUUID();
    mkdirSync(join(process.env.TEDY_STATE_DIR, "session-roles"), { recursive: true });
    writeFileSync(roleFile(id), content);
    assert.equal(gate.agentRole({ agent_type: "Explore", agent_id: "a-7", session_id: id }), null, content);
  }
});

test("a subagent whose role file cannot be read is a reader: reads pass, writes ask, and the failure is logged", () => {
  const id = randomUUID();
  mkdirSync(roleFile(id), { recursive: true });
  const sub = { agent_type: "Explore", agent_id: "a-9", session_id: id };
  assert.deepEqual(gate.agentRole(sub), { role: "reader", label: "Explore" });
  assert.equal(gate.judge({ ...shell("git status --short"), ...sub }, map), null);
  assert.match(gate.judge({ ...editCode, ...sub }, map).reason, /this is a reader job/);
  assert.match(readFileSync(join(process.env.TEDY_STATE_DIR, "gate-log.jsonl"), "utf8"), /"decision":"session-role-unreadable"/);
});

test("a role change replaces the role file by rename, so a reader never sees it half written", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const before = `${roleFile(id)}.before`;
  linkSync(roleFile(id), before);
  gate.agentRole(job("tedy:pm", id));
  assert.equal(readFileSync(roleFile(id), "utf8"), "pm");
  assert.equal(readFileSync(before, "utf8"), "dev");
  assert.deepEqual(readdirSync(dirname(roleFile(id))).filter((name) => name.startsWith(id) && name.endsWith(".tmp")), []);
});

test("a compact SessionStart without agent_id keeps the job's recorded role", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  gate.agentRole({ ...job("tedy:pm", id), hook_event_name: "SessionStart", source: "compact" });
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
});

test("a running job's main-thread calls keep its role file fresh, so another job's prune keeps it", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(roleFile(id), eightDaysAgo, eightDaysAgo);
  gate.agentRole(job("tedy:dev", id));
  gate.agentRole(job("tedy:pm"));
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
});

test("the job card promises a prompt only when the role gate is on", () => {
  const who = { role: "pm", label: "tedy:pm" };
  assert.match(gate.jobCard(map, who), /asks the user first/);
  assert.doesNotMatch(gate.jobCard(map, who, false), /asks the user first/);
});

test("a reviewer subagent of a job is a reader, and every write kind asks", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const reviewer = { agent_type: "tedy:reviewer", agent_id: "a-1", session_id: id };
  const writes = [editCode, comment, postReview, shell("node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt"), shell("node /k/scripts/openproject.mjs set 1 --status X --apply --lock 3")];
  for (const write of writes) assert.match(gate.judge({ ...write, ...reviewer }, map)?.reason ?? "", /^tedy role gate: this is a reader job \(tedy:reviewer\); /, write.tool_input.command ?? write.tool_name);
});

test("any other subagent of a job takes the job's role", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const verdict = gate.judge({ ...postReview, agent_type: "Explore", agent_id: "a-2", session_id: id }, map);
  assert.match(verdict.reason, /this is a dev job \(Explore\); posting or resolving PR review comments belongs to the review role/);
  assert.equal(gate.agentRole({ agent_type: "Explore", agent_id: "a-3", session_id: randomUUID() }), null);
});

test("a subagent named after another job role keeps its parent job's role, and only a reviewer narrows it", () => {
  const id = randomUUID();
  gate.agentRole(job("tedy:dev", id));
  const sub = (agent_type) => ({ agent_type, agent_id: "a-5", session_id: id });
  assert.match(gate.judge({ ...comment, ...sub("tedy:pm") }, map).reason, /^tedy role gate: this is a dev job \(tedy:pm\); writing to the tracker belongs to the pm role/);
  assert.match(gate.judge({ ...postReview, ...sub("tedy:review") }, map).reason, /^tedy role gate: this is a dev job \(tedy:review\); posting or resolving PR review comments belongs to the review role/);
  assert.equal(gate.judge({ ...editCode, ...sub("tedy:review") }, map).reason, null);
  assert.match(gate.judge({ ...editCode, ...sub("tedy:reviewer") }, map).reason, /^tedy role gate: this is a reader job \(tedy:reviewer\); changing or committing product code/);
});

test("another plugin's agent on the main thread has no tedy role, so it is judged as the cockpit", () => {
  const id = randomUUID();
  assert.equal(gate.agentRole(job("other:dev", id)), null);
  assert.equal(gate.judge({ ...editCode, ...job("other:dev", id) }, map).role, "cockpit");
  assert.equal(existsSync(roleFile(id)), false);
});

test("an agent_type named after an Object prototype member is no tedy role, so the session is judged as the cockpit", () => {
  const id = randomUUID();
  for (const agent_type of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(gate.agentRole(job(agent_type, id)), null, agent_type);
    assert.match(gate.judge({ ...editCode, ...job(agent_type, id) }, map).reason, /^tedy role gate: this is the cockpit of acme-shop; /, agent_type);
  }
  assert.equal(existsSync(roleFile(id)), false);
});

test("a subagent spawn on a job's main thread judges nothing and records the role, so a forked session's first subagent is gated", () => {
  const id = randomUUID();
  assert.equal(gate.judge({ tool_name: "Agent", cwd: "/w/acme", tool_input: { subagent_type: "Explore", prompt: "look" }, ...job("tedy:dev", id) }, map), null);
  assert.equal(readFileSync(roleFile(id), "utf8"), "dev");
  assert.match(gate.judge({ ...postReview, agent_type: "Explore", agent_id: "a-6", session_id: id }, map).reason, /this is a dev job \(Explore\)/);
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

test("a job whose role file cannot be written is still judged from agent_type, and the failure is logged", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [{ path: "fe", role: "FE" }] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-role-state-");
  writeFileSync(join(stateDir, "session-roles"), "not a folder");
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "node /k/scripts/openproject.mjs comment 1 --body-file b --apply" }, cwd: root, session_id: "sess-10", agent_type: "tedy:dev" });
  const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input, encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  const decision = JSON.parse(out).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, /this is a dev job \(tedy:dev\); writing to the tracker belongs to the pm role/);
  const log = readFileSync(join(stateDir, "gate-log.jsonl"), "utf8");
  assert.match(log, /"decision":"session-role-unwritten"/);
  assert.match(log, /"hook":"role-gate","decision":"ask"/);
});

const prBody = shell("node /k/scripts/github-write.mjs pr-body 744 --body-file b.md --job /w/acme/plans/jobs/j.md");

test("a session with no agent_type is the cockpit: it asks before code and may run an approved write", () => {
  const code = gate.judge({ ...editCode, session_id: randomUUID() }, map);
  assert.equal(code.role, "cockpit");
  assert.equal(code.reason, `tedy role gate: this is the cockpit of acme-shop; changing or committing product code belongs to the dev role. Start a dev job per ${JOBS_DOC}, unless the user allows this one here.`);
  assert.equal(gate.judge({ ...comment, session_id: randomUUID() }, map).reason, null);
  assert.equal(gate.judge({ ...postReview, session_id: randomUUID() }, map).reason, null);
  const card = gate.judge({ ...prBody, session_id: randomUUID() }, map);
  assert.equal(card.kind, "code");
  assert.equal(card.reason, null);
  const commit = gate.judge({ ...shell("cd acme-shop-fe && git commit -m x"), session_id: randomUUID() }, map);
  assert.equal(commit.role, "cockpit");
  assert.match(commit.reason, /this is the cockpit of acme-shop/);
});

test("a job's ask points at jobs.md whether or not the map still holds the legacy sessions and jobs keys", () => {
  const expected = `tedy role gate: this is a review job (tedy:review); changing or committing product code belongs to the dev role. Write a card, or a question card to start a dev job, per ${JOBS_DOC}, unless the user allows this one here.`;
  for (const extra of [{}, { jobs: false, sessions: [{ name: "Review PR - Shop", role: "review" }] }]) assert.equal(gate.judge({ ...editCode, ...job("tedy:review") }, { ...map, ...extra }).reason, expected, JSON.stringify(extra));
});

test("every segment of a command is judged, so a commit or a forbidden script after an allowed kit write still asks", () => {
  const chained = shell("node /k/scripts/openproject.mjs comment 1 --body-file b --apply && git -C /w/acme/acme-shop-fe commit -am x");
  const cockpit = gate.judge({ ...chained, session_id: randomUUID() }, map);
  assert.equal(cockpit.kind, "code");
  assert.match(cockpit.reason, /this is the cockpit of acme-shop; changing or committing product code/);
  const card = gate.judge({ ...shell("node /k/scripts/github-write.mjs pr-body 3 --body-file b && git -C /w/acme/acme-shop-fe commit -am x"), session_id: randomUUID() }, map);
  assert.match(card.reason ?? "", /cockpit of acme-shop/);
  const pm = gate.judge({ ...chained, ...job("tedy:pm") }, map);
  assert.equal(pm.kind, "code");
  assert.match(pm.reason, /this is a pm job \(tedy:pm\); changing or committing product code belongs to the dev role/);
  const second = gate.judge({ ...shell("git -C /w/acme/acme-shop-fe commit -m x && node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt"), ...job("tedy:dev") }, map);
  assert.equal(second.kind, "doc-figma");
  assert.match(second.reason, /this is a dev job \(tedy:dev\); Doc or Figma comments belongs to the pm role/);
});

test("only kit script writes are marked as scripts", () => {
  assert.equal(bash("node /k/scripts/github-write.mjs pr-body 744 --body-file b.md").script, true);
  assert.equal(bash("cd acme-shop-fe && git commit -m x").script, undefined);
});

test("a job's role card names jobs.md and never a hand-off, and the cockpit card tells it to ask the jobs' open cards", () => {
  const card = gate.jobCard(map, { role: "dev", label: "tedy:dev" });
  assert.ok(card.startsWith(`Role: this session is a dev job (tedy:dev) of acme-shop. Work it per ${JOBS_DOC}, section "Job":`), card);
  assert.match(card, /decide each local, reversible choice yourself and record it with its reason in the outcome, turn each decision the user must make into a question card and each write that needs approval into a publish card/);
  assert.doesNotMatch(card, /never call AskUserQuestion|AskUserQuestion in this window/);
  assert.doesNotMatch(card, /handoff/);
  assert.equal(gate.cockpitCard(map), `This is the cockpit of acme-shop: start jobs and ask their open cards per ${JOBS_DOC}, section "Cockpit".`);
});

const other = "/w/acme/plans/jobs/261110-1200-dev-other.md";
const own = "/w/acme/plans/jobs/261110-1100-pm-this.md";

test("a job asks before job.mjs close of another job or of itself and names the job file, and the cockpit is not asked", () => {
  const closing = (command, who = job("tedy:pm")) => gate.closeReason({ ...shell(command), ...who }, gate.agentRole({ ...shell(command), ...who }));
  assert.equal(closing(`node /k/plugin/scripts/job.mjs close ${other} --reason x`), `tedy role gate: this is a pm job (tedy:pm); job.mjs close ${other} marks that job closed and removes its worktree, which belongs to the cockpit. Allow it only if the user asked for it here.`);
  assert.match(closing(`node /k/plugin/scripts/job.mjs close ${own}`) ?? "", new RegExp(`job\\.mjs close ${own} marks`));
  assert.equal(gate.closeReason({ ...shell(`node /k/plugin/scripts/job.mjs close ${other}`), session_id: randomUUID() }, gate.agentRole({ session_id: randomUUID() })), null);
  assert.equal(closing(`node /k/plugin/scripts/job.mjs list && node /k/plugin/scripts/job.mjs stop ${own} --reason x`), null);
  assert.equal(closing("node /k/plugin/scripts/job.mjs close --if-finished"), "tedy role gate: this is a pm job (tedy:pm); job.mjs close --if-finished closes every done job that no card names and removes its worktree, which belongs to the cockpit. Allow it only if the user asked for it here.");
  assert.equal(closing(`node /k/plugin/scripts/job.mjs close --if-finished ${other}`), `tedy role gate: this is a pm job (tedy:pm); job.mjs close ${other} --if-finished closes that job once it is done and no card names it, and removes its worktree, which belongs to the cockpit. Allow it only if the user asked for it here.`);
  assert.equal(closing(`node /k/plugin/scripts/job.mjs close ${other} --if-finished`), `tedy role gate: this is a pm job (tedy:pm); job.mjs close ${other} --if-finished closes that job once it is done and no card names it, and removes its worktree, which belongs to the cockpit. Allow it only if the user asked for it here.`);
});

test("every command form the gate normalizes asks for a job's close, and the reason names the absolute job file", () => {
  const forms = [
    `cd /w/acme && node /k/plugin/scripts/job.mjs close plans/jobs/261110-1200-dev-other.md`,
    `cd plans/jobs && TEDY_STATE_DIR=/tmp/s node /k/plugin/scripts/job.mjs close 261110-1200-dev-other.md --reason x`,
    `node "/k/plugin/scripts/job".mjs 'clo''se' ${other}`,
    `node /k/plugin/scripts/job.mjs "close" ${other}`,
    `bash -c "node /k/plugin/scripts/job.mjs close ${other}"`,
    `git status; node --no-warnings /k/plugin/scripts/job.mjs close ${other}`,
  ];
  const reason = (command) => {
    const input = { ...shell(command), ...job("tedy:dev") };
    return gate.closeReason(input, gate.agentRole(input)) ?? "";
  };
  for (const command of forms) assert.match(reason(command), new RegExp(`^tedy role gate: this is a dev job \\(tedy:dev\\); job\\.mjs close ${other} marks`), command);
  assert.match(reason(`echo $(node /k/plugin/scripts/job.mjs close ${other})`), new RegExp(`^tedy role gate: this is a dev job \\(tedy:dev\\); job\\.mjs close \\S+, ${other} marks`));
  const ctx = { tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute", cwd: "/w/acme", tool_input: { language: "shell", code: `node /k/plugin/scripts/job.mjs close ${other}`, cwd: "/w/acme" }, ...job("tedy:review") };
  assert.match(gate.closeReason(ctx, gate.agentRole(ctx)) ?? "", /this is a review job \(tedy:review\); job\.mjs close/);
});

test("the gate entry asks a job before job.mjs close with the role gate off and no map covering the folder, and lets the cockpit close", () => {
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: false } }));
  mkdirSync(join(profile, "projects"));
  const command = `node /k/plugin/scripts/job.mjs close ${other}`;
  const entry = (extra) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp", session_id: randomUUID(), ...extra }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: tempDir("tedy-state-") } });
  const decision = JSON.parse(entry({ agent_type: "tedy:pm" })).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, new RegExp(`job\\.mjs close ${other} marks that job closed`));
  assert.equal(entry({}), "");
});

test("with the role gate off a job's subagent is asked before job.mjs close once the job's main thread has run a tool", () => {
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: false } }));
  mkdirSync(join(profile, "projects"));
  const stateDir = tempDir("tedy-state-");
  const session = randomUUID();
  const entry = (extra) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ cwd: "/tmp", session_id: session, ...extra }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  assert.equal(entry({ tool_name: "Bash", tool_input: { command: "git status" }, agent_type: "tedy:pm" }), "");
  const decision = JSON.parse(entry({ tool_name: "Bash", tool_input: { command: `node /k/plugin/scripts/job.mjs close ${other}` }, agent_id: "a-1", agent_type: "general-purpose" })).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, /^tedy role gate: this is a pm job \(general-purpose\); job\.mjs close /);
});

function spawnedJob(role, { state = process.env.TEDY_STATE_DIR, agent = `a${randomUUID().slice(0, 8)}`, session = randomUUID(), record = {}, launchRole = role, root = tempDir("tedy-role-job-") } = {}) {
  const file = join(root, "plans", "jobs", `261111-1000-${launchRole}-x.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `to: tedy:${launchRole}\nfrom: cockpit\nstatus: running\ncreated: 2026-11-11T03:00:00.000Z\ntitle: x\n\nbody\n`);
  if (record) recordLaunch(file, { role: launchRole, cwd: root, ...record }, state);
  const transcript = join(root, "projects", session, "subagents", `agent-${agent}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ type: "user", isSidechain: true, agentId: agent, message: { role: "user", content: `Job file ${JSON.stringify(file)}. Plugin root: /k/plugin.` } })}\n`);
  return { root, file, input: { agent_type: `tedy:${role}`, agent_id: agent, session_id: session, transcript_path: join(root, "projects", `${session}.jsonl`) } };
}

test("the gate entry judges a job agent by its agent_type in a map that still holds sessions and no jobs key, and never runs claude", () => {
  const root = tempDir("tedy-role-root-");
  mkdirSync(join(root, "fe"));
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [{ path: "fe" }], sessions: [{ name: "PM - Shop", role: "pm" }, { name: "Dev - Shop", role: "dev" }] })}\n\`\`\`\n`);
  const bin = tempDir("tedy-role-bin-");
  const calls = join(bin, "calls.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const stateDir = tempDir("tedy-state-");
  const entry = (who, call) => {
    const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, ...who, ...call }), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  const trackerComment = { tool_name: "Bash", tool_input: { command: "node /k/scripts/openproject.mjs comment 1 --body-file b --apply" } };
  const codeEdit = { tool_name: "Edit", tool_input: { file_path: join(root, "fe", "src", "a.ts"), old_string: "a", new_string: "b" } };
  const dev = spawnedJob("dev", { state: stateDir, root });
  assert.match(entry(dev.input, trackerComment)?.permissionDecisionReason ?? "", /^tedy role gate: this is a dev job \(tedy:dev\); writing to the tracker belongs to the pm role\. Write a card, or a question card to start a pm job/);
  assert.equal(entry(dev.input, codeEdit), null);
  const devops = spawnedJob("devops", { state: stateDir, root });
  assert.match(entry(devops.input, trackerComment)?.permissionDecisionReason ?? "", /^tedy role gate: this is a devops job \(tedy:devops\); writing to the tracker belongs to the pm role/);
  assert.equal(entry(devops.input, codeEdit), null);
  assert.match(entry({ session_id: randomUUID() }, codeEdit)?.permissionDecisionReason ?? "", /^tedy role gate: this is the cockpit of shop; changing or committing product code belongs to the dev role/);
  assert.equal(existsSync(calls), false);
});

test("a tedy job agent takes its role when a kit launch record of that role holds its id or its own transcript names that record's job file, bound to it or not, and the cockpit's session gets no role file", () => {
  const byTranscript = spawnedJob("pm");
  assert.deepEqual(gate.spawnedRole(byTranscript.input), { role: "pm", label: "tedy:pm" });
  assert.equal(gate.judge({ ...postReview, ...byTranscript.input }, map).reason, `tedy role gate: this is a pm job (tedy:pm); posting or resolving PR review comments belongs to the review role. Write a card, or a question card to start a review job, per ${JOBS_DOC}, unless the user allows this one here.`);
  const byId = spawnedJob("dev", { record: { agent_id: "a-bound" }, agent: "a-bound" });
  writeFileSync(join(byId.root, "projects", byId.input.session_id, "subagents", "agent-a-bound.jsonl"), "");
  assert.match(gate.judge({ ...comment, ...byId.input }, map).reason, /^tedy role gate: this is a dev job \(tedy:dev\); writing to the tracker belongs to the pm role/);
  assert.equal(gate.judge({ ...editCode, ...byId.input }, map).reason, null);
  assert.equal(existsSync(roleFile(byId.input.session_id)), false);
  const asCockpit = (input) => {
    assert.equal(gate.spawnedRole(input), null);
    assert.equal(gate.judge({ ...editCode, ...input }, map).role, "cockpit");
  };
  asCockpit({ agent_type: "tedy:dev", agent_id: "a-none", session_id: randomUUID() });
  asCockpit(spawnedJob("dev", { record: null }).input);
  asCockpit(spawnedJob("dev", { launchRole: "pm" }).input);
  assert.deepEqual(gate.spawnedRole(spawnedJob("dev", { record: { agent_id: "a-other" } }).input), { role: "dev", label: "tedy:dev" });
  assert.equal(gate.spawnedRole({ ...spawnedJob("dev").input, agent_type: "Explore" }), null);
});

test("the gate entry gives a job's every ask both to the agent its record binds and to a second agent whose launch form names the same job file", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const first = spawnedJob("pm", { state: stateDir, root, agent: "a1first", record: { agent_id: "a1first", state: "running" } });
  writeFileSync(join(root, "projects", first.input.session_id, "subagents", "agent-a2second.jsonl"), `${JSON.stringify({ type: "user", isSidechain: true, agentId: "a2second", message: { role: "user", content: `Job file ${JSON.stringify(first.file)}. Plugin root: /k/plugin. The job is resumed: the latest ## Note in the job file, quoted below, is the rework request.\n\nalso epic 4` } })}\n`);
  const second = { ...first.input, agent_id: "a2second" };
  const entry = (who, call) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, ...who, ...call }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  const calls = {
    close: { tool_name: "Bash", tool_input: { command: `node /k/plugin/scripts/job.mjs close ${other}` } },
    kitState: { tool_name: "Write", tool_input: { file_path: join(stateDir, "jobs", "x.json"), content: "{}" } },
    prReview: { tool_name: "Bash", tool_input: { command: "node /k/scripts/github-write.mjs post plans/reports/review-x.md" } },
  };
  for (const [name, call] of Object.entries(calls)) {
    for (const who of [first.input, second]) {
      const out = entry(who, call);
      assert.notEqual(out, "", `${name} ${who.agent_id}`);
      const decision = JSON.parse(out).hookSpecificOutput;
      assert.equal(decision.permissionDecision, "ask", `${name} ${who.agent_id}`);
      assert.match(decision.permissionDecisionReason, /^tedy role gate: this is a pm job \(tedy:pm\); /, `${name} ${who.agent_id}`);
    }
  }
});

test("the gate entry finds a job agent's project map from its job file, never from the hook's cwd, so with the role gate off its close and kit-state asks hold in its core worktree outside every map path and under a symlinked map path", () => {
  const root = tempDir("tedy-role-root-");
  const link = join(tempDir("tedy-role-link-"), "shop");
  symlinkSync(root, link);
  const tree = tempDir("tedy-role-worktree-");
  for (const paths of [[root], [link]]) {
    const profile = tempDir("tedy-role-profile-");
    writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: false } }));
    mkdirSync(join(profile, "projects"));
    writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths, repos: [{ path: "." }] })}\n\`\`\`\n`);
    const stateDir = tempDir("tedy-state-");
    const launched = spawnedJob("dev", { state: stateDir, root, record: { cwd: tree, worktree: tree } });
    const bound = spawnedJob("pm", { state: stateDir, root, agent: "a-bound", record: { cwd: root, agent_id: "a-bound" } });
    const entry = (who, call) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: tree, ...who, ...call }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
    const calls = [
      { tool_name: "Bash", tool_input: { command: `node /k/plugin/scripts/job.mjs close ${other}` } },
      { tool_name: "Bash", tool_input: { command: `cd ${root} && node /k/plugin/scripts/job.mjs close ${other}` } },
      { tool_name: "Write", tool_input: { file_path: join(stateDir, "jobs", "forged.json"), content: "{}" } },
    ];
    for (const job of [launched, bound]) {
      for (const call of calls) {
        const out = entry(job.input, call);
        assert.notEqual(out, "", `${paths} ${job.input.agent_type} ${JSON.stringify(call)}`);
        assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
      }
    }
    assert.equal(entry({ session_id: launched.input.session_id }, calls[0]), "");
  }
});

test("a job agent whose job file no map covers any more is judged by the map of the hook's cwd, as the cockpit, so its code edit still asks", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [{ path: "fe" }] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const moved = spawnedJob("review", { state: stateDir, record: { cwd: root } });
  const call = { hook_event_name: "PreToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "fe", "src", "a.ts") } };
  const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ ...moved.input, ...call }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  assert.notEqual(out, "");
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

test("the gate entry asks a bound job agent before job.mjs close with the role gate off, and lets the cockpit and an unbound agent close", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: false } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const job = spawnedJob("review", { state: stateDir, root });
  const entry = (extra) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `node /k/plugin/scripts/job.mjs close ${other}` }, cwd: root, session_id: job.input.session_id, ...extra }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  const decision = JSON.parse(entry(job.input)).hookSpecificOutput;
  assert.equal(decision.permissionDecision, "ask");
  assert.match(decision.permissionDecisionReason, new RegExp(`^tedy role gate: this is a review job \\(tedy:review\\); job\\.mjs close ${other} marks that job closed`));
  assert.equal(entry({}), "");
  assert.equal(entry({ agent_id: "a-unbound", agent_type: "tedy:review" }), "");
  assert.equal(existsSync(join(stateDir, "session-roles", job.input.session_id)), false);
});

test("a bound job's own subagents are judged as the cockpit, a tedy:reviewer one included, and the reviewer gate still checks the tedy:reviewer one", () => {
  const job = spawnedJob("review", { record: { agent_id: "a-job" }, agent: "a-job" });
  assert.deepEqual(gate.spawnedRole(job.input), { role: "review", label: "tedy:review" });
  for (const type of ["general-purpose", "Explore", "tedy:reviewer"]) {
    const child = { agent_type: type, agent_id: `a-${type.replace(/\W/g, "")}`, session_id: job.input.session_id, transcript_path: job.input.transcript_path };
    assert.equal(gate.agentRole(child), null, type);
    assert.equal(gate.spawnedRole(child), null, type);
    assert.equal(gate.judge({ ...editCode, ...child }, map).role, "cockpit", type);
    assert.equal(isReviewer({ tool_name: "Bash", ...child }), type === "tedy:reviewer", type);
  }
});

test("the gate entry asks a bound job agent before any git --output form and before an edit under the profile or state dir, and leaves the cockpit alone", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: false } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const job = spawnedJob("dev", { state: stateDir, root });
  const entry = (call, extra) => execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ cwd: root, session_id: job.input.session_id, ...call, ...extra }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const asked = [
    bash(`git diff --output ${join(profile, "config.json")}`),
    bash("git diff --output=/tmp/out.patch"),
    bash(`cd ${root} && git -C ${root} format-patch -1 --output-directory ${join(stateDir, "x")}`),
    { tool_name: "Edit", tool_input: { file_path: join(profile, "projects", "shop.md"), old_string: "a", new_string: "b" } },
    { tool_name: "Write", tool_input: { file_path: join(stateDir, "jobs", "x.json"), content: "{}" } },
    { tool_name: "NotebookEdit", tool_input: { notebook_path: join(stateDir, "n.ipynb"), new_source: "x" } },
  ];
  for (const call of asked) {
    const decision = JSON.parse(entry(call, job.input)).hookSpecificOutput;
    assert.equal(decision.permissionDecision, "ask", JSON.stringify(call));
    assert.match(decision.permissionDecisionReason, /^tedy role gate: this is a dev job \(tedy:dev\); /);
    assert.equal(entry(call, {}), "", `cockpit: ${JSON.stringify(call)}`);
  }
  assert.match(JSON.parse(entry(asked[0], job.input)).hookSpecificOutput.permissionDecisionReason, /git --output/);
  assert.match(JSON.parse(entry(asked[4], job.input)).hookSpecificOutput.permissionDecisionReason, new RegExp(`the kit's state dir ${stateDir}`));
  assert.match(JSON.parse(entry(asked[3], job.input)).hookSpecificOutput.permissionDecisionReason, new RegExp(`the kit's profile dir ${profile}`));
  for (const call of [bash("git diff"), bash("git log --oneline -3"), { tool_name: "Write", tool_input: { file_path: join(root, "plans", "x.md"), content: "x" } }]) assert.equal(entry(call, job.input), "", JSON.stringify(call));
});

test("a Monitor command is judged like the same Bash command: a job's git --output and close ask, and so does the cockpit's commit in a repository", () => {
  const monitor = (command, cwd = "/w/acme") => ({ tool_name: "Monitor", cwd, tool_input: { command, description: "watch" } });
  assert.deepEqual(classifyAction(monitor("cd acme-shop-fe && git commit -m x"), map), { kind: "code", repo: "acme-shop-fe" });
  assert.equal(classifyAction(monitor("node /k/scripts/openproject.mjs apply d.json"), map).kind, "tracker");
  const root = tempDir("tedy-role-root-");
  mkdirSync(join(root, "fe"));
  const profile = tempDir("tedy-role-profile-");
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: true } }));
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [root], repos: [{ path: "fe" }] })}\n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const job = spawnedJob("dev", { state: stateDir, root });
  const entry = (call, extra) => {
    const out = execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: job.input.session_id, ...call, ...extra }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  for (const command of ["git diff --output=/tmp/x", `node /k/plugin/scripts/job.mjs close ${other}`]) {
    const decision = entry(monitor(command, root), job.input);
    assert.equal(decision?.permissionDecision, "ask", command);
    assert.match(decision.permissionDecisionReason, /^tedy role gate: this is a dev job \(tedy:dev\); /, command);
  }
  const cockpit = entry(monitor(`cd ${join(root, "fe")} && git commit -m x`, root), {});
  assert.equal(cockpit?.permissionDecision, "ask");
  assert.match(cockpit.permissionDecisionReason, /^tedy role gate: this is the cockpit of shop; changing or committing product code belongs to the dev role/);
});

test("with the role gate off a map that does not parse leaves a tedy job agent's calls alone, and with it on they ask", () => {
  const root = tempDir("tedy-role-root-");
  const profile = tempDir("tedy-role-profile-");
  mkdirSync(join(profile, "projects"));
  writeFileSync(join(profile, "projects", "broken.md"), `# map\n\n\`\`\`json\n{ "name": "shop", "paths": ["${root}"], \n\`\`\`\n`);
  const stateDir = tempDir("tedy-state-");
  const entry = (gateOn, call) => {
    writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: { roleGate: gateOn } }));
    return execFileSync("node", [new URL("../gates/role-gate.mjs", import.meta.url).pathname], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: root, session_id: randomUUID(), agent_id: "a-dev", agent_type: "tedy:dev", ...call }), encoding: "utf8", env: { ...process.env, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: stateDir } });
  };
  const calls = [
    { tool_name: "Edit", tool_input: { file_path: join(root, "fe", "a.ts"), old_string: "a", new_string: "b" } },
    { tool_name: "Bash", tool_input: { command: `cd ${root} && git commit -m x` } },
    { tool_name: "Bash", tool_input: { command: `node /k/plugin/scripts/job.mjs close ${other}` } },
    { tool_name: "Bash", tool_input: { command: "git diff --output=/tmp/x" } },
  ];
  for (const call of calls) {
    assert.equal(entry(false, call), "", JSON.stringify(call));
    assert.match(JSON.parse(entry(true, call)).hookSpecificOutput.permissionDecisionReason, /could not check which session role owns this write/, JSON.stringify(call));
  }
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
