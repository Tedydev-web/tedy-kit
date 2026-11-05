import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../gates/git-gate.mjs";
import { reviewRunVerdict } from "../gates/review-run-gate.mjs";
import { commitFile, git } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const GATE = fileURLToPath(new URL("../scripts/review-run-gate.mjs", import.meta.url));

function reviewSetup() {
  const repo = tempDir("tedy-review-run-");
  git(repo, "init", "-q", "-b", "main");
  commitFile(repo, "package.json", '{"scripts":{"test":"vitest"}}\n');
  git(repo, "checkout", "-q", "-b", "teammate");
  const head = commitFile(repo, "src/a.ts", "export const a = 1;\n");
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", "refs/pr/12", head);
  const worktree = join(repo, ".claude", "worktrees", "pr-12");
  git(repo, "worktree", "add", "-q", "--detach", worktree, "refs/pr/12");
  const approvals = tempDir("tedy-review-run-approvals-");
  return { repo, head, worktree, approvals };
}

const bash = (command, cwd) => ({ tool_name: "Bash", cwd, tool_input: { command } });
const verdict = (setup, input) => reviewRunVerdict(input, { dir: setup.approvals });
const approve = (setup, sha = setup.head) => writeFileSync(join(setup.approvals, `${sha}.json`), '{"scope":"all"}\n');

test("a package-manager command in a review worktree without an approval for its head is refused, naming the step", () => {
  const setup = reviewSetup();
  for (const [command, cwd] of [
    ["npm test", setup.worktree],
    ["npm run lint", setup.worktree],
    ["pnpm test", setup.worktree],
    ["yarn test", setup.worktree],
    ["bun test", setup.worktree],
    ["npx vitest run", setup.worktree],
    ["bunx vitest", setup.worktree],
    ["timeout 120 npm test", setup.worktree],
    ["env CI=1 npm test 2>&1 | tail -20", setup.worktree],
    [`cd ${setup.worktree} && npm test`, setup.repo],
    [`npm --prefix ${setup.worktree} test`, setup.repo],
    [`npm --prefix=${setup.worktree} test`, setup.repo],
    [`pnpm -C ${setup.worktree} lint`, setup.repo],
    [`pnpm --dir ${setup.worktree} typecheck`, setup.repo],
    [`yarn --cwd ${setup.worktree} test`, setup.repo],
    [`git status && /usr/bin/npm test`, setup.worktree],
  ]) {
    const result = verdict(setup, bash(command, cwd));
    assert.ok(result, command);
    assert.match(result.reason, /^tedy review-run gate: /, command);
    assert.ok(result.reason.includes(setup.head), command);
    assert.ok(result.reason.includes("step 3 of /tedy:review-pr"), command);
    assert.ok(result.reason.includes("pr-execution-surface.mjs"), command);
    assert.ok(result.reason.includes("`run.header`"), command);
  }
});

test("both the current directory and every directory flag before -- are checked", () => {
  const setup = reviewSetup();
  for (const [command, cwd] of [
    ["npm test -- -C /tmp", setup.worktree],
    ["npx eslint --cwd=/tmp .", setup.worktree],
    ["pnpm vitest --dir /tmp", setup.worktree],
    [`npm --prefix /tmp --prefix ${setup.worktree} test`, setup.repo],
    [`npm --prefix ${setup.worktree} --prefix /tmp test`, setup.repo],
  ]) assert.ok(verdict(setup, bash(command, cwd)), `${command} in ${cwd}`);
  assert.equal(verdict(setup, bash(`npm test -- --prefix ${setup.worktree}`, setup.repo)), null);
});

test("corepack, volta run, env -C, make and a node run of a checkout file or of no file are refused in a review checkout", () => {
  const setup = reviewSetup();
  symlinkSync(join(setup.worktree, "loop.js"), join(setup.worktree, "loop.js"));
  for (const [command, cwd] of [
    ["corepack pnpm test", setup.worktree],
    ["corepack npm test", setup.worktree],
    ["corepack yarn@4.1.0 test", setup.worktree],
    ["volta run npm test", setup.worktree],
    ["volta run --node 20 --env CI=1 pnpm test", setup.worktree],
    [`env -C ${setup.worktree} npm test`, setup.repo],
    [`env --chdir=${setup.worktree} make test`, setup.repo],
    [`sudo -D ${setup.worktree} npm test`, setup.repo],
    ["make test", setup.worktree],
    ["make", setup.worktree],
    [`make -C ${setup.worktree} lint`, setup.repo],
    [`make --directory=${setup.worktree} lint`, setup.repo],
    ["node a.ts", setup.worktree],
    ["node --import tsx ./src/a.ts", setup.worktree],
    [`node ${join(setup.worktree, "src", "a.ts")}`, setup.repo],
    [`env -C ${setup.worktree} node src/a.ts`, setup.repo],
    ["node --test", setup.worktree],
    ["node --run test", setup.worktree],
    ["node -e \"require('./src/a.ts')\"", setup.worktree],
    ["node /usr/lib/node_modules/npm/bin/npm-cli.js test", setup.worktree],
    [`node ${join(setup.worktree, "loop.js")}`, setup.repo],
    ["node -v ./src/a.ts", setup.worktree],
    ["node -h", setup.worktree],
    ["node --help", setup.worktree],
  ]) {
    const result = verdict(setup, bash(command, cwd));
    assert.ok(result, `${command} in ${cwd}`);
    assert.ok(result.reason.includes("step 3 of /tedy:review-pr"), command);
  }
});

test("gmake, a makefile, an attached directory, a node preload or test path inside the checkout, and a runner named by a checkout path or PATH entry are refused", () => {
  const setup = reviewSetup();
  const wt = setup.worktree;
  const outside = join(tempDir("tedy-review-run-outside-"), "probe.mjs");
  writeFileSync(outside, "console.log(1);\n");
  for (const [command, cwd] of [
    ["gmake test", wt],
    [`make -f ${wt}/Makefile test`, setup.repo],
    [`make --file=${wt}/Makefile test`, setup.repo],
    [`make --makefile ${wt}/Makefile test`, setup.repo],
    [`make -f${wt}/Makefile test`, setup.repo],
    [`make -C${wt} lint`, setup.repo],
    [`env -C${wt} npm test`, setup.repo],
    [`sudo -D${wt} npm test`, setup.repo],
    [`node --test ${wt}/src/`, setup.repo],
    [`node --test ${wt}/src/**/*.test.ts`, setup.repo],
    [`node -r ${wt}/src/a.ts -e 1`, setup.repo],
    [`node --require=${wt}/src/a.ts -e 1`, setup.repo],
    [`node --import ${wt}/src/a.ts ${outside}`, setup.repo],
    [`node --import tsx ${outside}`, wt],
    [`node --import file://${wt}/src/a.ts ${outside}`, setup.repo],
    [`node --import=file://${wt}/src/a.ts ${outside}`, setup.repo],
    [`node --import FILE://${wt}/src/a.ts ${outside}`, setup.repo],
    ["./bin/node -v", wt],
    ["bin/node --version", wt],
    ["PATH=./bin:$PATH node -v", wt],
    ["env PATH=./bin node -v", wt],
    ["volta run ./bin/node -v", wt],
    [`${wt}/bin/node ${outside}`, setup.repo],
    [`PATH=${wt}/bin node ${outside}`, setup.repo],
    ["PATH=$PWD/bin:$PATH node -v", wt],
    ["PATH=${PWD}/bin node -v", wt],
    ["PATH=:/usr/bin node -v", wt],
    ["</dev/null npm test", wt],
    ["2>&1 make test", wt],
    ["2> err node -v ./src/a.ts", wt],
    ["2>&- npm test", wt],
    ["timeout 300 </dev/null npm test", wt],
    [`2>&1 cd ${wt} && npm test`, setup.repo],
    [`${wt}/node_modules/.bin/npm test`, setup.repo],
    [`${wt}/bin/make test`, setup.repo],
  ]) {
    const result = verdict(setup, bash(command, cwd));
    assert.ok(result, `${command} in ${cwd}`);
    assert.ok(result.reason.includes("step 3 of /tedy:review-pr"), command);
  }
  for (const command of [`node --import file:///tmp/a%00b -e 1`, `make -f file:///tmp/a%00b test`, `make -f ${setup.repo}/Makefile test`, `node --test ${setup.repo}/src/`, `node --import tsx ${outside}`, `node -r ${outside} -e 1`]) {
    assert.equal(verdict(setup, bash(command, setup.repo)), null, command);
  }
});

test("a kit script, a file outside the checkout and corepack or volta housekeeping pass in a review checkout", () => {
  const setup = reviewSetup();
  const outside = join(tempDir("tedy-review-run-outside-"), "probe.mjs");
  writeFileSync(outside, "console.log(1);\n");
  const loop = join(dirname(outside), "loop.js");
  symlinkSync(loop, loop);
  const locked = join(dirname(outside), "locked");
  mkdirSync(locked, { mode: 0 });
  if (process.getuid?.() !== 0) assert.equal(verdict(setup, bash(`node ${locked}/x.js`, setup.worktree)), null);
  chmodSync(locked, 0o700);
  for (const [command, cwd] of [
    ["PATH=/usr/bin:$PATH node -v", setup.worktree],
    [`${process.execPath} ${outside}`, setup.worktree],
    [`node ${GATE} --help`, setup.worktree],
    [`node ${outside}`, setup.worktree],
    [`node ${loop}`, setup.worktree],
    [`node /tmp/${"a".repeat(300)}/x.js`, setup.worktree],
    ["node -v", setup.worktree],
    ["node --version", setup.worktree],
    [`env -C ${setup.repo} node src/a.ts`, setup.repo],
    ["corepack enable", setup.worktree],
    ["volta list", setup.worktree],
    ["make test", setup.repo],
    ["node a.ts", setup.repo],
  ]) assert.equal(verdict(setup, bash(command, cwd)), null, `${command} in ${cwd}`);
});

test("eval, heredoc and variable forms of a package-manager run in a review checkout are refused by git-gate, and bash -c by this gate", () => {
  const setup = reviewSetup();
  for (const command of ["eval npm test", "eval 'npm test'", "bash <<'E'\nnpm test\nE", "NPM=npm; $NPM test"]) {
    const result = evaluate(command, setup.worktree);
    assert.equal(result.allow, false, command);
    assert.match(result.reason, /runs code the gate cannot read/, command);
  }
  assert.ok(verdict(setup, bash("bash -c 'npm test'", setup.worktree)));
});

test("reads in a review worktree and package-manager commands elsewhere pass", () => {
  const setup = reviewSetup();
  const branch = join(setup.repo, ".claude", "worktrees", "feature");
  git(setup.repo, "worktree", "add", "-q", "-b", "feat/x", branch, "main");
  const release = join(tempDir("tedy-release-"), "release");
  git(setup.repo, "worktree", "add", "-q", "--detach", release, "main");
  const notRepo = tempDir("tedy-not-a-repo-");
  for (const [command, cwd] of [
    ["rg -n npm package.json", setup.worktree],
    ["cat package.json && git log --oneline -3", setup.worktree],
    ["echo npm test", setup.worktree],
    ["git commit -m 'npm test'", setup.worktree],
    ["npm test", setup.repo],
    ["npm test", branch],
    ["npm test", release],
    ["npm test", notRepo],
    ["npm test", join(notRepo, "missing")],
  ]) assert.equal(verdict(setup, bash(command, cwd)), null, `${command} in ${cwd}`);
});

test("an approval recorded for the worktree's head lets its scripts run; one for another head does not", () => {
  const setup = reviewSetup();
  approve(setup, "f".repeat(40));
  assert.ok(verdict(setup, bash("npm test", setup.worktree)));
  approve(setup);
  assert.equal(verdict(setup, bash("npm test", setup.worktree)), null);
  const next = commitFile(setup.worktree, "src/b.ts", "export const b = 1;\n");
  assert.notEqual(next, setup.head);
  assert.ok(verdict(setup, bash("npm test", setup.worktree)).reason.includes(next));
});

test("a review worktree stays one after its refs/pr ref moves or is deleted, and a detached checkout at a refs/pr head is one anywhere", () => {
  const setup = reviewSetup();
  git(setup.repo, "update-ref", "-d", "refs/pr/12");
  assert.ok(verdict(setup, bash("npm test", setup.worktree)));
  git(setup.repo, "update-ref", "refs/pr/12", setup.head);
  const outside = join(tempDir("tedy-review-outside-"), "pr-12");
  git(setup.repo, "worktree", "add", "-q", "--detach", outside, "refs/pr/12");
  assert.ok(verdict(setup, bash("npm test", outside)).reason.includes("refs/pr/12"));
  git(setup.worktree, "checkout", "-q", "-b", "local");
  assert.ok(verdict(setup, bash("npm test", setup.worktree)));
});

test("a dev branch worktree stopped mid-rebase and a detached worktree not named pr-<n> are not review checkouts", () => {
  const setup = reviewSetup();
  const dev = join(setup.repo, ".claude", "worktrees", "feat-x");
  git(setup.repo, "worktree", "add", "-q", "-b", "feat/x", dev, "main");
  commitFile(dev, "package.json", '{"scripts":{"test":"vitest --run"}}\n');
  commitFile(setup.repo, "package.json", '{"scripts":{"test":"jest"}}\n');
  assert.throws(() => git(dev, "rebase", "main"));
  assert.match(git(dev, "status", "--short", "--branch").split("\n")[0], /no branch/);
  const scratch = join(setup.repo, ".worktrees", "scratch");
  git(setup.repo, "worktree", "add", "-q", "--detach", scratch, "main");
  for (const cwd of [dev, scratch]) assert.equal(verdict(setup, bash("npm test", cwd)), null, cwd);
});

test("context-mode shell code is checked where context-mode runs it", () => {
  const setup = reviewSetup();
  const input = { tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute", cwd: setup.repo, tool_input: { language: "shell", code: "npm test", cwd: setup.worktree } };
  assert.ok(verdict(setup, input));
  const batch = { tool_name: "mcp__context-mode__ctx_batch_execute", cwd: setup.worktree, tool_input: { commands: [{ label: "t", command: "npm test" }] } };
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = setup.worktree;
  try {
    assert.ok(verdict(setup, batch));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
});

test("the hook denies through its shim with the state folder's approvals, and passes once the head is approved", () => {
  const setup = reviewSetup();
  const state = tempDir("tedy-review-run-state-");
  const hook = () => spawnSync("node", [GATE], { input: JSON.stringify(bash("npm test", setup.worktree)), encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: state } });
  const denied = hook();
  assert.equal(denied.status, 0, denied.stderr);
  const output = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "deny");
  assert.ok(output.permissionDecisionReason.includes(setup.head));
  mkdirSync(join(state, "review-runs"), { recursive: true });
  writeFileSync(join(state, "review-runs", `${setup.head}.json`), '{"scope":"lint"}\n');
  assert.equal(hook().stdout, "");
});
