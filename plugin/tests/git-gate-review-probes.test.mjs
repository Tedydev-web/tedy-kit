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

test("listed (design): an interpreter one-liner that pushes without mentioning gh is allowed (review F7 h47 h48 c42)", () => {
  assert.equal(verdict(`node -e \x27require("child_process").execSync("${PUSH}")\x27`), "allow");
  assert.equal(verdict(`python3 -c \x27import os; os.system("${PUSH}")\x27`), "allow");
  assert.equal(hook(...shell(`node -e \x27require("child_process").execSync("${PUSH}")\x27`)), "allow");
});

test("obfuscation, listed: a renamed copy or symlink of a kit script is not seen as a publish (review c41)", () => {
  assert.equal(hook(...shell("node /tmp/gw.mjs reply 7 PRRT_1 --body ok")), "allow");
});

test("listed: a batch command given as one quoted JSON string runs as a single word, which fails, and is allowed (review I2)", () => {
  assert.equal(hook(BATCH, { commands: JSON.stringify(PUSH) }), "allow");
});

test("honest: a push after a backgrounded command is judged as its own command", () => {
  assert.deepEqual(splitSegments("npm run dev & git push --force origin main"), ["npm run dev", "git push --force origin main"]);
  assert.deepEqual(splitSegments("x >out.log 2>&1 &>all.log & y |& z"), ["x >out.log 2>&1 &>all.log", "y", "z"]);
  assert.equal(verdict(`sleep 1 & ${PUSH}`), "ask");
});

test("a runner named only as an argument is not treated as running anything", () => {
  assert.deepEqual(["mv script sh", "ls busybox git", "rg -n find -e bash"].filter((command) => verdict(command) !== "allow"), []);
  assert.equal(verdict(`sudo find . -exec ${PUSH} \;`), "deny");
});

test("honest: a push or commit inside a subshell is judged in the subshell's directory (round 2 R1 n01 n02 n03 n01c n03b)", () => {
  const { main, feat } = repos();
  assert.equal(verdict(`(cd ${main} && git push)`, feat), "ask");
  assert.equal(verdict("(git push origin main)", feat), "ask");
  assert.equal(verdict(`(cd ${main} && git push origin master)`, feat), "ask");
  assert.equal(verdict(`( cd ${main} && git push )`, feat), "ask");
  assert.equal(hook(...shell(`(cd ${main} && git push)`), { cwd: feat, projectDir: feat }), "ask");
  assert.equal(hook(BATCH, { commands: [`(cd ${main} && git push origin master)`] }, { cwd: feat, projectDir: feat }), "ask");
  assert.equal(verdict(`(cd ${feat} && git push)`, main), "allow");
  assert.equal(verdict(`(cd ${feat} && npm test) && git push`, main), "ask");
  const map = { name: "shop", paths: ["/w/shop"], repos: [{ path: "shop-fe" }], sessions: [{ name: "PM", role: "pm" }, { name: "Dev", role: "dev" }] };
  assert.deepEqual(classifyAction({ tool_name: "Bash", cwd: "/w/shop", tool_input: { command: "(cd shop-fe && git commit -m x)" } }, map), { kind: "code", repo: "shop-fe" });
  assert.deepEqual(classifyAction({ tool_name: EXECUTE, cwd: "/w/shop", tool_input: { language: "shell", code: "(cd shop-fe && git commit -m x)" } }, map), { kind: "code", repo: "shop-fe" });
});

test("parentheses that are not a subshell keep their current behaviour", () => {
  assert.deepEqual(splitSegments("x=$(git rev-parse HEAD) && echo $((1 + 2)) && diff <(sort a) <(sort b)"), ["x=$(git rev-parse HEAD)", "echo $((1 + 2))", "diff <(sort a) <(sort b)"]);
  assert.deepEqual(splitSegments("echo 'f() { x; }' \"(a)\""), ["echo 'f() { x; }' \"(a)\""]);
  const allowed = ["[[ -n x ]] && echo y", "[[ $x == a ]] || echo n", "(( i = i + 1 ))", "echo \"(git push origin main)\"", "echo 'f() { git push; }'", "find . \\( -name a -o -name b \\) -print", "x=$(git rev-parse HEAD) && echo $x", "echo $((1 + 2))", "diff <(sort a) <(sort b)"];
  assert.deepEqual(allowed.filter((command) => verdict(command) !== "allow"), []);
  assert.equal(verdict(`f() { ${PUSH}; }; f`), "deny");
  assert.equal(verdict(`push() { git push "$@"; }; push origin main`), "deny");
});

test("honest, fixed: a push in a case branch is judged as its own command", () => {
  assert.equal(verdict(`case $x in a) ${PUSH};; esac`), "ask");
});

test("honest: pushd and popd move the directory a push is judged in (round 2 R3 n05)", () => {
  const { main, feat } = repos();
  assert.equal(verdict(`pushd ${main} && git push`, feat), "ask");
  assert.equal(verdict(`pushd ${main} > /dev/null && git push`, feat), "ask");
  assert.equal(verdict(`pushd ${main} && popd && git push`, feat), "allow");
  assert.equal(verdict(`pushd ${feat} && git push && popd`, main), "allow");
  assert.equal(hook(...shell(`pushd ${main} && git push`), { cwd: feat, projectDir: feat }), "ask");
});

test("the round-2 review's everyday commands, reconstructed from its list, give the same result in Bash and through ctx_execute", () => {
  const { main, feat } = repos();
  const forms = [
    ["git status"], ["git log --oneline -5"], ["git diff"], ["git show HEAD"], ["git branch -a"], ["git remote -v"], ["git fetch origin"], ["git rev-parse HEAD"], ["git blame README.md"], ["git -C plugin log -1"],
    ["git commit -F /tmp/msg.txt"], ["git commit -F - <<'EOF'\nfix: x & y ; bash\nEOF"], ["git add -A && git commit -m x"],
    ["git push", "allow", feat], ["git push -u origin feat/x", "allow", feat], ["git push", "ask", main], ["git push origin HEAD:main", "ask", feat],
    ["npm test"], ["npm run build | tail -20"], ["npm test -- --test-name-pattern=gate"], ["timeout 120 npm test"], ["env FOO=1 npm test"], ["time npm test"],
    ["node --test plugin/tests/a.test.mjs"], ["node --test 'plugin/tests/*.test.mjs'"], ["node --test --test-concurrency=1 plugin/tests"], ["npx vitest run"], ["npx tsx scripts/build.ts"], ["FOO=1 BAR=2 node scripts/check.mjs"],
    ["python3 /tmp/x.py"], ["python3 -m unittest discover -s plugin/evals/probes/study -p 'test_*.py'"], ["STUDY_NO_NETWORK=1 python3 -m unittest discover -s plugin/evals/probes/study -p 'test_*.py'"], ["python3 -m json.tool < f.json"], ["cat f.json | python3 -m json.tool"], ["python3 x.py < in.txt > out.txt"], ["python3 x.py --input 'data/*.json'"],
    ["bun test"], ["deno test -A"],
    ["cat <<EOF > f.txt\nx\nEOF"], ["cat > f.txt <<'EOF'\nx\nEOF"],
    ["jq '.a' f.json"], ["jq -r '.[] | .name' f.json"], ["rg -n x plugin | head"], ["rg --glob '*.mjs' -n x"], ["rg -l x"], ["fd -e mjs"], ["sed -n 1,20p f"], ["sed -i 's/a/b/' f"], ["awk '{print $1}' f | sort | uniq -c"], ["printf 'b\\na\\n' | sort"], ["grep -c '&' f"], ["echo \"a && b\" | tr a-z A-Z"], ["ls *.md"], ["diff <(sort a) <(sort b)"],
    ["find . -name '*.md' -print"], ["find plugin -type f -name '*.mjs' -print"], ["find . -name '*.mjs' | xargs wc -l"], ["ls | xargs -n1 basename"],
    ["for f in *.md; do echo $f; done"], ["if [ -f x ]; then echo y; fi"], ["while read -r l; do echo $l; done < f"], ["x=$(git rev-parse HEAD) && echo $x"], ["cd plugin && npm test && cd .."], ["(cd plugin && npm test)"], ["tail -f log & sleep 1; kill %1"], ["node x.mjs > log 2>&1 &"],
    ["bash s.sh > log 2>&1"], ["bash -euo pipefail s.sh"], ["sh ./configure"],
    ["gh pr view 1"], ["gh pr list && gh pr checks 1"], ["gh api repos/o/r/pulls --paginate | jq '.[].number'"], ["curl -s https://example.com | jq ."],
    ["git stash && git checkout -b feat/y"], ["tar -czf a.tgz dir"], ["docker compose up -d"], ["sqlite3 db.sqlite 'select 1'"], ["node -e 'console.log(1)'"], ["python3 -c 'print(1)'"], ["mv script sh && ls busybox"],
    ["python3 - <<'EOF'\nprint(1)\nEOF", "deny"], ["bash <<'EOF'\necho hi\nEOF", "deny"],
  ];
  assert.ok(forms.length >= 80);
  const wrong = forms.flatMap(([command, expected = "allow", dir = feat]) => {
    const viaBash = verdict(command, dir);
    const viaCtx = hook(...shell(command), { cwd: dir, projectDir: dir });
    return viaBash === expected && viaCtx === expected ? [] : [{ command, expected, viaBash, viaCtx }];
  });
  assert.deepEqual(wrong, []);
});

test("honest: an interpreter whose script path comes from a variable is refused (round 2 R2 n32 n33)", () => {
  refusedToRewrite(["GW=/k/github-write.mjs; node \"$GW\" reply 7 PRRT_1 --body ok", "node $SCRIPT post d.md", "python3 \"${TOOL}\" x", "deno run -A $X", "bun ${X}", "tsx \"$X\"", "node `which x`"]);
  assert.equal(hook(...shell("GW=/k/github-write.mjs\nnode \"$GW\" reply 7 PRRT_1 --body ok")), "deny");
  const allowed = ["node scripts/check.mjs \"$ARG\"", "FOO=1 node x.mjs", "python3 x.py --out \"$HOME/o.json\"", "node -e \"console.log(process.env.HOME)\""];
  assert.deepEqual(allowed.filter((command) => verdict(command) !== "allow"), []);
});
