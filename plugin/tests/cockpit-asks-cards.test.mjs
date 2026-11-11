import "./test-isolation.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir-for-tests.mjs";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const HOOKS = join(PLUGIN, "scripts", "session-hooks.mjs");
const PENDING_SKILL = join(PLUGIN, "skills", "pending", "SKILL.md");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cockpit() {
  const scratch = tempDir("tedy-asks-");
  const [home, profile, state, work] = ["home", "profile", "state", "work"].map((name) => join(scratch, name));
  for (const dir of [join(profile, "projects"), state, join(work, "plans", "jobs"), join(work, "plans", "drafts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(profile, "config.json"), "{}");
  writeFileSync(join(profile, "projects", "shop.md"), `# map\n\n\`\`\`json\n${JSON.stringify({ name: "shop", paths: [work] })}\n\`\`\`\n`);
  const job = (status) => {
    const file = join(work, "plans", "jobs", "261106-0900-dev-add-hello.md");
    writeFileSync(file, `to: tedy:dev\nfrom: cockpit\nstatus: ${status}\ncreated: 2026-11-06T02:00:00.000Z\ntitle: Add hello\n\nbody\n`);
    return file;
  };
  const question = (file, title = "Which toast") => {
    const path = join(work, "plans", "drafts", `261106-0915-question-${title.toLowerCase().replaceAll(" ", "-")}.md`);
    writeFileSync(path, `kind: question\ntitle: ${title}\njob: ${file}\n\n${title} text?\n- Short: one line\n- Long: two lines\n`);
    return path;
  };
  const hook = (mode, extra = {}) => {
    const run = spawnSync(process.execPath, [HOOKS, mode], {
      input: JSON.stringify({ cwd: work, session_id: "s-1", source: "startup", ...extra }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, TEDY_PROFILE_DIR: profile, TEDY_STATE_DIR: state, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_PROJECT_DIR_NAME: "" },
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout ? JSON.parse(run.stdout) : null;
  };
  const log = () => (existsSync(join(state, "gate-log.jsonl")) ? readFileSync(join(state, "gate-log.jsonl"), "utf8") : "");
  return { work, job, question, hook, log };
}

const context = (output) => output?.hookSpecificOutput?.additionalContext ?? "";

test("the cockpit's session start asks the open cards of jobs that are not running by the pending skill's steps 2 and 3, and logs that it listed them", () => {
  const c = cockpit();
  const card = c.question(c.job("done"));
  const text = context(c.hook("pending-handoffs"));
  assert.match(text, new RegExp(`^Open cards wait on the user's answer: ask them in this turn\\. Read ${escape(PENDING_SKILL)}, with \\$\\{CLAUDE_PLUGIN_ROOT\\} read as ${escape(PLUGIN)}, and do its step 2 for the cards under "To publish" and its step 3 for those under "Questions"\\.`, "m"));
  assert.ok(text.includes(`Open cards wait on the user's answer`) && text.split(`- Which toast ${card}`).length === 3, text);
  assert.match(c.log(), /"hook":"ask-cards","decision":"listed","cards":1/);
});

test("a session start with no card to ask prints no ask block, and a role session started as a tedy job never gets one", () => {
  const c = cockpit();
  assert.doesNotMatch(context(c.hook("pending-handoffs")), /Open cards wait/);
  c.question(c.job("done"));
  assert.doesNotMatch(context(c.hook("pending-handoffs", { agent_type: "tedy:dev" })), /Open cards wait/);
  assert.doesNotMatch(c.log(), /"hook":"ask-cards"/);
});
