import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isReviewer, reviewerVerdict } from "../gates/reviewer-gate.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));
const decision = (command) => reviewerVerdict(command, "/repo").decision;

test("only the kit's reviewer subagent is checked, on Bash and on Monitor", () => {
  assert.equal(isReviewer({ tool_name: "Bash", agent_type: "tedy:reviewer" }), true);
  assert.equal(isReviewer({ tool_name: "Monitor", agent_type: "tedy:reviewer" }), true);
  assert.equal(isReviewer({ tool_name: "Monitor", agent_type: "Explore" }), false);
  for (const input of [{ tool_name: "Bash", agent_type: "Explore" }, { tool_name: "Bash", agent_type: "other:reviewer" }, { tool_name: "Bash" }, { tool_name: "Read", agent_type: "tedy:reviewer" }]) assert.equal(isReviewer(input), false, JSON.stringify(input));
});

test("reads of the repository, its history, the PR and the kit's read scripts pass", () => {
  for (const command of [
    "git -C /repo log --oneline -5",
    "git --no-pager diff origin/dev...HEAD -- src/a.ts",
    "git show abc123:src/a.ts | head -50",
    "cd /repo && git blame -L 10,20 src/a.ts",
    "git log -L 10,20:src/a.ts",
    "git grep -n -w -F 'total' origin/dev",
    "git log 2>/dev/null | wc -l",
    "rg -n -F --no-ignore-global 'name' src",
    "grep -rn total src | sort | uniq -c",
    "find src -name '*.ts' -type f",
    "fd -e ts src",
    "sed -n '10,40p' src/a.ts",
    "cat src/a.ts && ls -la src",
    "gh pr view 712 --json body,headRefOid",
    "gh pr diff 712",
    "gh api repos/o/r/pulls/712/files --paginate",
    "gh api -X GET repos/o/r/pulls/712/comments",
    `node ${SCRIPTS}prd-section.mjs find 'UC-3'`,
    `node ${SCRIPTS}project-map.mjs resolve`,
    `node ${SCRIPTS}figma-read.mjs text 3846:8503`,
  ]) assert.equal(decision(command), "allow", command);
});

test("writes, publishes, code execution and hidden commands are refused", () => {
  for (const command of [
    "git commit -m x",
    "git push origin HEAD",
    "git checkout -b x",
    "git branch x",
    "git -c core.pager=sh log",
    "git diff --output=/tmp/x",
    "git diff --ext-diff",
    "gh pr review 712 --approve",
    "gh pr comment 712 -b hi",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
    "gh api graphql -f query=q",
    "echo hi > notes.txt",
    "cat a >> b",
    "rm -rf src",
    "touch x",
    "npm test",
    "node -e 1",
    "node /tmp/evil.mjs",
    `node ${SCRIPTS}project-map.mjs discover`,
    `node ${SCRIPTS}github-write.mjs post r.md`,
    "bash -c 'ls'",
    "python3 x.py",
    "find . -delete",
    "find . -exec rm {} ;",
    "fd -x rm",
    "rg --pre=sh x",
    "sed -i s/a/b/ f",
    "sed -n '1w out' f",
    "sort -o out f",
    "ls | xargs rm",
    "git log | tee x",
    "awk '{print}' f",
    "ls $(rm -rf x)",
    "ls `rm -rf x`",
    "FOO=1 git log",
  ]) assert.equal(decision(command), "deny", command);
});

test("network fetches ask the user", () => {
  for (const command of ["curl -s https://demo.example/page -o /tmp/p-demo.html", "git fetch origin pull/712/head"]) assert.equal(decision(command), "ask", command);
});

test("a refusal says what the reviewer may run instead", () => {
  assert.match(reviewerVerdict("git commit -m x", "/repo").reason, /read-only/);
  assert.match(reviewerVerdict("git commit -m x", "/repo").reason, /git commit/);
});
