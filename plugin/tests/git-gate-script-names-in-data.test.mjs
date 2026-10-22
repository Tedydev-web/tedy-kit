import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFailed, DATA_PROGRAMS, dataOnlyCommand, hiddenPublish } from "../gates/git-gate.mjs";
import { publishes as quotedPublishes } from "../gates/publish-quote-gate.mjs";
import { KIT_PUBLISH_ASK_RULES } from "../lib/publish-approval-settings.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");
const CTX = "mcp__plugin_context-mode_context-mode__ctx_execute";
const REPLY = "node /k/scripts/github-write.mjs reply 1 2 --body x";
const APPLY = "node /k/scripts/openproject.mjs apply d.json";
const SCRIPT = "/k/scripts/github-write.mjs";

function decision(command, mode, tool = "Bash") {
  const dir = tempDir("tedy-data-gate-");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask: mode === "answer" ? [] : KIT_PUBLISH_ASK_RULES } }));
  writeFileSync(join(dir, "t.jsonl"), "");
  const toolInput = tool === "Bash" ? { command } : { language: "shell", code: command };
  const input = JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: dir, transcript_path: join(dir, "t.jsonl") });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: { publishApproval: mode }, language: { chat: "vi" } }) };
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

const DATA = [
  `cd /w && printf '%s\\n' '' 'test("reply", () => run("github-write.mjs reply 1 2 --body x"))' >> plugin/tests/x.test.mjs`,
  `echo ${REPLY} >> notes.md`,
  "printf '%s\\n' 'node /k/scripts/openproject.mjs apply d.json --project 1' > /tmp/plan.txt",
  "printf '%s\\n' 'node /k/scripts/gdoc-comments.mjs reply c1 --body-file g.md --doc D' | tee -a notes.md",
  `mkdir -p notes && cp a.md notes/ && touch notes/b.md && cat notes/a.md && echo '${REPLY}' > notes/c.md`,
];

const REVIEWED = [
  `sed '1e ${REPLY}' notes.md`,
  `sed -n '$e ${REPLY}' notes.md`,
  `sed '-e1e ${REPLY}' notes.md`,
  `printf '%s\\n' '${REPLY}' > /tmp/c.sh && chmod +x /tmp/c.sh && sort -S 1K --compress-program=/tmp/c.sh big.txt`,
  `printf -v 'a[$(${REPLY})]' x`,
  `test -v 'a[$(${REPLY})]'`,
  `[ -v 'a[$(${REPLY})]' ]`,
  `GIT_EDITOR='${REPLY}' git commit --allow-empty`,
  `printf '#!/bin/sh\\n%s\\n' '${REPLY}' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && git commit -m x`,
  `printf '#!/bin/sh\\n%s\\n' '${REPLY}' > /tmp/b/cat && chmod +x /tmp/b/cat && PATH=/tmp/b:/usr/bin cat x`,
  `printf '#!/bin/sh\\n%s\\n' '${REPLY}' > /tmp/b/cat && chmod +x /tmp/b/cat && PATH=/tmp/b:/usr/bin && cat x`,
  `printf '#!/bin/sh\\n%s\\n' '${REPLY}' > /tmp/b/nohup && chmod +x /tmp/b/nohup && /tmp/b/nohup true`,
  `env '-S${APPLY}' true`,
  `env -S '${APPLY}' true`,
  `echo '${REPLY}' | xargs printf`,
  "sed -i 's/the `github-write.mjs post` command lin/the `github-write.mjs post <draft> --repo <o\\/r>` command lin/' plugin/skills/review-pr/SKILL.md",
  'git commit -m "docs: say doc-comment-file.mjs post items.json --apply"',
];

test("a kit script name inside data a command only writes is not a publish, in ask and answer mode", () => {
  for (const command of DATA) {
    assert.equal(dataOnlyCommand(command), true, command);
    assert.equal(hiddenPublish(command), null, command);
    assert.equal(quotedPublishes(command, "/w", () => "The label is wrong.").length, 0, command);
    for (const mode of ["ask", "answer"]) {
      assert.equal(decision(command, mode), "allow", `${mode}: ${command}`);
      assert.equal(checkFailed(command, mode === "answer", "Bash", new Error("boom")).ask, true, `${mode}: ${command}`);
    }
  }
});

test("the data list stays closed: sed, git, sort or any other program added to it turns this test red", () => {
  assert.deepEqual([...DATA_PROGRAMS].sort(), ["cat", "cd", "chmod", "cp", "echo", "mkdir", "mv", "printf", "rm", "tee", "touch", "true"]);
  for (const program of ["sed", "git", "sort"]) {
    DATA_PROGRAMS.add(program);
    try {
      assert.ok(REVIEWED.some((command) => dataOnlyCommand(command)), `${program} added to the data list goes unnoticed`);
    } finally {
      DATA_PROGRAMS.delete(program);
    }
  }
});

test("only a bare first word from the closed list, with no assignment, wrapper or printf -v, counts as data", () => {
  for (const command of [...REVIEWED, `sed -i 's/a/b/' f.md`, "sort f.md > g.md", "git status", `rg -n 'x' plugin`, "head -1 f.md", `"" printf x`, `X=1 printf x`, `nohup printf x`, `/usr/bin/printf x`, `printf -v x y`, `printf -vx y`,`printf "$(date)"`]) assert.equal(dataOnlyCommand(command), false, command);
});

test("a kit script run directly, through an interpreter or a wrapper still publishes", () => {
  for (const command of [`env X=1 ${REPLY}`, "/k/scripts/github-write.mjs reply 1 2 --body x", `(cd /w && env ${REPLY})`, "timeout 9 bun /k/scripts/openproject.mjs apply d.json", "nohup deno run -A /k/scripts/figma-comments.mjs delete 12"]) {
    assert.ok(hiddenPublish(command), command);
    assert.equal(decision(command, "ask"), "ask", command);
    assert.equal(decision(command, "answer"), "allow", command);
  }
  assert.equal(hiddenPublish(REPLY), null);
  for (const command of [`env X=1 ${REPLY}`, `echo $(${REPLY})`, `echo ${REPLY} > p.sh && sh p.sh`]) assert.equal(quotedPublishes(command, "/w", () => "").length, 1, command);
});

test("a form the reviewer found, and the two first examples, decide as before the data exemption", () => {
  for (const command of REVIEWED) {
    assert.equal(decision(command, "ask"), "ask", `ask: ${command}`);
    assert.equal(decision(command, "answer"), "allow", `answer: ${command}`);
    assert.equal(decision(command, "answer", CTX), "deny", `ctx: ${command}`);
  }
});

test("data handed to a shell, eval, source, an interpreter or xargs is still refused or asked", () => {
  const expected = [
    [`printf '%s\\n' '${REPLY}' | sh`, "deny", "deny"],
    [`echo '${REPLY}' | bash`, "deny", "deny"],
    [`printf '%s\\n' '${REPLY}' | node`, "deny", "deny"],
    [`eval '${REPLY}'`, "deny", "deny"],
    [`node -e 'require("node:child_process").execFileSync("node", ["/k/scripts/github-write.mjs", "reply", "1", "2"])'`, "deny", "deny"],
    [`printf '%s\\n' '${REPLY}' > /tmp/p.sh && source /tmp/p.sh`, "deny", "deny"],
    [`printf '%s\\n' '${REPLY}' | xargs -I{} sh -c '{}'`, "deny", "deny"],
    [`bash -c '${REPLY}'`, "ask", "allow"],
    [`printf '%s\\n' '${REPLY}' > /tmp/p.sh && sh /tmp/p.sh`, "ask", "allow"],
    [`printf '%s\\n' '${REPLY}' > /tmp/p.mjs && python3 /tmp/run.py /tmp/p.mjs`, "ask", "allow"],
    [`echo 'reply 1 2 --body x' | xargs node ${SCRIPT}`, "ask", "allow"],
    [`echo 'reply 1 2 --body x' | xargs -n 9 node ${SCRIPT}`, "ask", "allow"],
    [`echo 'reply 1 2 --body x' | xargs --max-args=9 node ${SCRIPT}`, "ask", "allow"],
    [`echo 'reply 1 2 --body x' | xargs --max-args 9 node ${SCRIPT}`, "ask", "allow"],
    [`echo 'reply 1 2 --body x' | xargs ${SCRIPT}`, "ask", "allow"],
    [`echo $(${REPLY})`, "ask", "allow"],
    [`awk 'BEGIN{system("${REPLY}")}'`, "ask", "allow"],
    [`npm exec -- ${REPLY}`, "ask", "allow"],
    [`printf '%s\\n' '${REPLY}' > run.sh && chmod +x run.sh && ./run.sh`, "ask", "allow"],
    [`sed 's/^/${REPLY.replace(/\//g, "\\/")}/e' notes.md`, "ask", "allow"],
    [`/tmp/bin/printf '${REPLY}'`, "ask", "allow"],
    [`node /k/scripts/github-write.mjs post d.md && printf '%s\\n' '${REPLY}' >> notes.md`, "ask", "allow"],
  ];
  for (const [command, ask, answer] of expected) {
    assert.equal(decision(command, "ask"), ask, `ask: ${command}`);
    assert.equal(decision(command, "answer"), answer, `answer: ${command}`);
  }
});
