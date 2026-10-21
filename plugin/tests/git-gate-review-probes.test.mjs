import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../gates/git-gate.mjs";
import { classifyAction } from "../gates/role-gate.mjs";
import { splitSegments, tokenize } from "../lib/shell-segments.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const PUSH = "git push --force origin main";
const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "../gates/git-gate.mjs");
const EXECUTE = "mcp__plugin_context-mode_context-mode__ctx_execute";
const EXECUTE_FILE = "mcp__plugin_context-mode_context-mode__ctx_execute_file";
const BATCH = "mcp__context-mode__ctx_batch_execute";
const ASK_RULES = ["post", "reply", "edit", "minimize", "resolve", "unresolve", "pr-body"].map((verb) => `Bash(*github-write.mjs*${verb}*)`)
  .concat(["Bash(*openproject.mjs*apply*)", "Bash(*openproject.mjs*set*--apply*)", "Bash(*figma-comments.mjs*post*)", "Bash(*gdoc-comments.mjs*reply*)", "Bash(*doc-comment-file.mjs*post*--apply*)"]);

function hook(toolName, toolInput, { cwd = "/tmp", projectDir } = {}) {
  const settings = join(tempDir("tedy-settings-"), "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { ask: ASK_RULES } }));
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });
  const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: {} }) };
  delete env.CLAUDE_PROJECT_DIR;
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}
const shell = (code) => [EXECUTE, { language: "shell", code }];
const verdict = (command, cwd = "/w") => {
  const result = evaluate(command, cwd);
  return result.allow ? "allow" : result.ask ? "ask" : "deny";
};
const refusedToRewrite = (commands) => {
  for (const command of commands) {
    const result = evaluate(command, "/w");
    assert.equal(result.allow, false, JSON.stringify(command));
    assert.notEqual(result.ask, true, JSON.stringify(command));
    assert.match(result.reason, /script file/, JSON.stringify(command));
  }
};

test("tokenize splits a redirect glued to the word before it and keeps fd numbers and process substitution", () => {
  assert.deepEqual(tokenize("bash<<EOF"), ["bash", "<<EOF"]);
  assert.deepEqual(tokenize("python3 -<<EOF"), ["python3", "-", "<<EOF"]);
  assert.deepEqual(tokenize("x 2>&1 0<<EOF >out.log"), ["x", "2>&1", "0<<EOF", ">out.log"]);
  assert.deepEqual(tokenize("bash <(echo x)"), ["bash", "<(echo", "x)"]);
  assert.deepEqual(tokenize("echo 'a<b' \"c>d\""), ["echo", "a<b", "c>d"]);
  assert.deepEqual(splitSegments(`bash<<EOF\n${PUSH}\nEOF\ngit status`), ["bash<<EOF", "git status"]);
});

test("honest: a shell reading a heredoc or stdin is refused (review F3 h12 h13 h14 h15 h16 h19)", () => {
  refusedToRewrite([
    `bash<<EOF\n${PUSH}\nEOF`,
    `bash -o pipefail <<EOF\n${PUSH}\nEOF`,
    `bash -euo pipefail <<'EOF'\n${PUSH}\nEOF`,
    `bash +o posix <<EOF\n${PUSH}\nEOF`,
    `bash --rcfile /dev/null <<EOF\n${PUSH}\nEOF`,
    `bash /dev/stdin <<EOF\n${PUSH}\nEOF`,
    `bash /dev/stdin <<<'${PUSH}'`,
  ]);
});

test("obfuscation, fixed: a shell reading code from /proc, /dev/fd or a process substitution is refused (review F3 h17 h20 h57)", () => {
  refusedToRewrite([`bash /proc/self/fd/0 <<EOF\n${PUSH}\nEOF`, `bash <(echo '${PUSH}')`, `bash /dev/fd/3 3<<EOF\n${PUSH}\nEOF`]);
});

test("honest: an interpreter reading code from a heredoc, /dev/stdin or `-` is refused (review F5 h01 h31 h32 h34 h42 h44 h46)", () => {
  refusedToRewrite([
    "python3 -W ignore - <<EOF\nimport os\nEOF",
    "python3 -Wignore - <<EOF\nimport os\nEOF",
    "python3 -<<EOF\nimport os\nEOF",
    "python3<<EOF\nimport os\nEOF",
    "python3 /dev/stdin <<EOF\nimport os\nEOF",
    "python3 /dev/stdin",
    "deno run -A - <<EOF\nconsole.log(1)\nEOF",
    "bun run - <<EOF\nconsole.log(1)\nEOF",
    "php <<EOF\n<?php echo 1;\nEOF",
    "node -r ./hook.cjs - <<EOF\nconsole.log(1)\nEOF",
  ]);
});

test("obfuscation, fixed: an interpreter reading a heredoc through an explicit fd 0 is refused (review F5 h33)", () => {
  refusedToRewrite(["python3 - 0<<EOF\nimport os\nEOF"]);
});

test("honest: code piped into an interpreter is refused (review F6 h37 h38)", () => {
  refusedToRewrite([`cat <<'EOF' | python3\nimport os; os.system("${PUSH}")\nEOF`, `echo 'require("child_process").execSync("${PUSH}")' | node`, "cat /tmp/x.py | python3 -"]);
});

test("the review's regression probes keep their results", () => {
  const allowed = [
    "git status",
    "git log -1",
    "git diff",
    "git commit -F /tmp/msg.txt",
    "git commit -F - <<'EOF'\nfix: x\nEOF",
    "git push -u origin feat/x",
    "cat <<EOF > /tmp/f.txt\nhello\nEOF",
    "cat > /tmp/f.txt <<'EOF'\nhello\nEOF",
    "npm test",
    "python3 /tmp/x.py",
    "node x.mjs",
    "python3 -m unittest discover -s plugin/evals/probes/study -p 'test_*.py'",
    "python3 x.py <<EOF\ndata\nEOF",
    "python3 -m json.tool <<EOF\n{}\nEOF",
    "python3 x.py < in.txt",
    "bash s.sh > out.log",
    "bash s.sh >out.log 2>&1",
    "bash 2> /dev/null s.sh",
    "bash -euo pipefail s.sh",
    "bash s.sh <<EOF\ndata\nEOF",
    "bash s.sh | tee out.log",
    "jq . <<EOF\n{}\nEOF",
    "gh pr view 1",
    "node --test",
    "node --version",
    "python3 --version",
    "echo data | python3 x.py",
    "cat f.json | python3 -m json.tool",
    "echo x | node -e 'process.stdin.pipe(process.stdout)'",
    "rg -n x plugin | head -5",
    "ls -la",
    "jq '.a' f.json",
    "if [ -f x ]; then\n  awk '{print $1}' f | sort | uniq -c\nfi",
    "for f in *.md; do echo $f; done",
    "x=$(git rev-parse HEAD) && echo $x",
    "while read -r line; do echo $line; done < f.txt",
  ];
  assert.deepEqual(allowed.filter((command) => verdict(command) !== "allow"), []);
  assert.equal(verdict("bash > out.log"), "deny");
  assert.equal(verdict("bash /tmp/s.sh < /tmp/in.txt"), "deny");
  assert.equal(verdict("bash /tmp/s.sh -s"), "deny");
});

test("honest: a shell reached through env, setsid, npx or an absolute path is still judged (review F3 h05 h10 h45)", () => {
  refusedToRewrite([`/usr/bin/env bash <<EOF\n${PUSH}\nEOF`, `setsid bash <<EOF\n${PUSH}\nEOF`, "npx tsx <<EOF\nconsole.log(1)\nEOF", `/bin/bash <<EOF\n${PUSH}\nEOF`]);
});

test("obfuscation, fixed: sudo -s, busybox sh and rbash reading a heredoc are refused (review F3 h09 h29 h30)", () => {
  refusedToRewrite([`sudo -s <<EOF\n${PUSH}\nEOF`, `sudo -u root -i <<EOF\n${PUSH}\nEOF`, `busybox sh <<EOF\n${PUSH}\nEOF`, `rbash <<EOF\n${PUSH}\nEOF`]);
});

test("honest: a readable push under a wrapper or an absolute path asks like the plain push (review F4 h49 h50 h54)", () => {
  for (const command of [
    `setsid ${PUSH}`,
    `flock /tmp/l ${PUSH}`,
    `flock -w 5 /tmp/l ${PUSH}`,
    `/usr/bin/sudo ${PUSH}`,
    `sudo -u me ${PUSH}`,
    `/usr/bin/git push --force origin main`,
    `/usr/bin/env ${PUSH}`,
    `env FOO=1 -u BAR ${PUSH}`,
    `nice -n 5 ${PUSH}`,
    `stdbuf -o0 ${PUSH}`,
    `timeout 30 ${PUSH}`,
    `time ${PUSH}`,
    `command ${PUSH}`,
    `exec ${PUSH}`,
    `nohup ${PUSH}`,
    "echo main | xargs -I{} git push --force origin {}",
  ]) {
    assert.equal(verdict(command), "ask", command);
  }
});

test("obfuscation, fixed: runners whose inner command the gate cannot read are refused when they carry git, gh, a shell or an interpreter (review F4 h51 h53)", () => {
  refusedToRewrite([`find . -maxdepth 0 -exec ${PUSH} \;`, `find . -execdir bash -c x \;`, `script -qc \x27${PUSH}\x27 /dev/null`, `flock -c \x27${PUSH}\x27 /tmp/l`, `flock /tmp/l -c \x27${PUSH}\x27`, "busybox python3 x.py"]);
});

test("obfuscation, fixed: a command word or script path with glob characters is refused", () => {
  refusedToRewrite(["gi[t] push --force origin main", "/usr/bin/gi? push --force origin main", "g*t push", "bash scr*.sh", "node /k/github-wr*.mjs minimize x"]);
});

test("wrappers and runners that carry no hidden command keep their results", () => {
  const allowed = ["ssh host git pull", "find . -name \x27*.md\x27", "find . -name x -exec rg -n y {} \;", "script -q /dev/null", "busybox wget http://x", "[ -f x ] && echo y", "[[ -n x ]] && echo y", "setsid npm test", "flock /tmp/l npm test", "env FOO=1 npm test", "/usr/bin/git status", "sudo -u me ls"];
  assert.deepEqual(allowed.filter((command) => verdict(command) !== "allow"), []);
});

test("honest: a kit publish with a quoted subcommand through a context-mode tool is refused (review F1 p03 p05 p06 p08 p09 p10 p11 c38)", () => {
  for (const [tool, input] of [
    shell("node /k/github-write.mjs \"reply\" 7 PRRT_1 --body \x27ok\x27"),
    shell("node /k/github-write.mjs \x27resolve\x27 PRRT_1 PRRT_2"),
    shell("node /k/github-write.mjs \x27pr-body\x27 7"),
    shell("node /k/openproject.mjs \x27apply\x27 d.json"),
    shell("node /k/figma-comments.mjs \"post\" f.md"),
    shell("node /k/gdoc-comments.mjs \x27reply\x27 d.md"),
    shell("node /k/doc-comment-file.mjs \x27post\x27 f.md --apply"),
    [BATCH, { commands: [{ label: "a", command: "node /k/github-write.mjs \x27resolve\x27 PRRT_1" }] }],
  ]) {
    assert.equal(hook(tool, input), "deny", JSON.stringify(input));
  }
  assert.equal(hook(...shell("node /k/github-write.mjs reply 7 PRRT_1 --body ok")), "deny");
});

test("obfuscation, fixed: a kit publish split by quotes, escapes or globs through a context-mode tool is refused (review F1 p04 p07 c33 c35)", () => {
  for (const [tool, input] of [
    [BATCH, { commands: ["node /k/github-write.mjs re\x27\x27ply 7 PRRT_1"] }],
    shell("node /k/github-wr*.mjs minimize x"),
    shell("node /k/github-writ?.mjs post d.md"),
    shell("node /k/openproject.mjs set 12 --status Done --ap\\ply"),
  ]) {
    assert.equal(hook(tool, input), "deny", JSON.stringify(input));
  }
});

test("honest: a quoted kit publish through Bash passes to the ask rule that matches its text, an unmatched one asks (review F1 p12)", () => {
  const settingsFile = join(tempDir("tedy-settings-"), "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ permissions: { ask: ASK_RULES } }));
  const judge = (command) => { const result = evaluate(command, "/w", { settingsFile }); return result.allow ? "allow" : result.ask ? "ask" : "deny"; };
  assert.equal(judge("node /k/github-write.mjs \x27resolve\x27 PRRT_1"), "allow");
  assert.equal(judge("node /k/github-write.mjs re\x27\x27ply 7 PRRT_1"), "ask");
  assert.equal(judge("node /k/openproject.mjs set 12 --status Done --ap\\ply"), "ask");
  assert.equal(judge("node /k/github-wr*.mjs minimize x"), "deny");
});

test("honest: role-gate classifies a kit script write with a quoted subcommand like the plain one (review F8)", () => {
  const map = { name: "shop", paths: ["/w/shop"], repos: [{ path: "shop-fe" }], sessions: [{ name: "PM", role: "pm" }, { name: "Dev", role: "dev" }] };
  const classify = (command, tool = "Bash") => classifyAction(tool === "Bash" ? { tool_name: "Bash", cwd: "/w/shop", tool_input: { command } } : { tool_name: EXECUTE, cwd: "/w/shop", tool_input: { language: "shell", code: command } }, map)?.kind;
  assert.equal(classify("node x/github-write.mjs \x27pr-body\x27 7", EXECUTE), "code");
  assert.equal(classify("node x/github-write.mjs \x27pr-body\x27 7"), "code");
  assert.equal(classify("node x/github-write.mjs re\x27\x27solve PRRT_1"), "pr-review");
  assert.equal(classify("node x/openproject.mjs \"apply\" d.json"), "tracker");
});

function repos() {
  const root = tempDir("tedy-ctx-cwd-");
  const make = (name, branch) => {
    const work = join(root, name);
    const git = (...args) => execFileSync("git", ["-C", work, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "--bare", "-b", branch, join(root, `${name}.git`)]);
    execFileSync("git", ["clone", "-q", join(root, `${name}.git`), work], { stdio: "ignore" });
    writeFileSync(join(work, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git("push", "-q", "-u", "origin", branch);
    return work;
  };
  return { main: make("repo-main", "master"), feat: make("repo-feat", "feat-x") };
}

test("honest: ctx commands are judged in the directory context-mode runs them in (review F2 c24 c27)", () => {
  const { main, feat } = repos();
  assert.equal(hook(...shell("git push"), { cwd: feat, projectDir: main }), "ask");
  assert.equal(hook(EXECUTE_FILE, { path: "x", language: "shell", code: "git push", cwd: feat }, { cwd: main, projectDir: main }), "ask");
  assert.equal(hook(BATCH, { commands: ["git push"] }, { cwd: feat, projectDir: main }), "ask");
  assert.equal(hook(EXECUTE, { language: "shell", code: "git push", cwd: feat }, { cwd: main, projectDir: main }), "allow");
  assert.equal(hook(...shell("git push"), { cwd: feat }), "allow");
  assert.equal(hook(...shell("git push"), { cwd: main }), "ask");
});

test("honest: a relative ctx cwd, which the server resolves against its own install directory, is refused (review F2 c28)", () => {
  const { main } = repos();
  assert.equal(hook(EXECUTE, { language: "shell", code: "git push", cwd: "../repo-feat" }, { cwd: main, projectDir: main }), "deny");
  assert.equal(hook(BATCH, { commands: ["git status"], cwd: "sub" }, { cwd: main, projectDir: main }), "deny");
});

test("honest: a heredoc or stdin form through a context-mode tool is refused like Bash (review F3 h58 h59)", () => {
  assert.equal(hook(...shell(`bash<<EOF\n${PUSH}\nEOF`)), "deny");
  assert.equal(hook(BATCH, { commands: [`bash /dev/stdin <<<\x27${PUSH}\x27`] }), "deny");
});
