import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, splitSegments, classify, hiddenPublish } from "./git-gate.mjs";
import { ALL_GATES_ON } from "./hook-io.mjs";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

test("splitSegments handles chains, pipes, newlines and shell wrappers", () => {
  assert.deepEqual(splitSegments("cd x && git push; echo ok | cat\ngit status"), ["cd x", "git push", "echo ok", "cat", "git status"]);
  assert.deepEqual(splitSegments("bash -c 'git add . && git push'"), ["git add .", "git push"]);
  assert.deepEqual(splitSegments('echo "a && b"'), ['echo "a && b"']);
});

test("classify recognises git and gh actions through env vars and -C", () => {
  assert.deepEqual(classify("git push origin x", "/w"), { kind: "push", dir: "/w", args: ["origin", "x"] });
  assert.deepEqual(classify("FOO=1 git -C sub commit -am msg", "/w"), { kind: "commit", dir: "/w/sub", all: true });
  assert.deepEqual(classify("git -c core.x=y push", "/w"), { kind: "push", dir: "/w", args: [] });
  assert.deepEqual(classify("cd ~/kit", "/w"), { kind: "cd", dir: join(homedir(), "kit") });
  assert.deepEqual(classify("cd", "/w"), { kind: "cd", dir: homedir() });
  assert.equal(classify("gh pr create --fill", "/w").kind, "pr-create");
  assert.equal(classify("gh pr review 12 --comment -b hi", "/w").kind, "github-write");
  assert.equal(classify("gh api -X POST repos/o/r/pulls/1/reviews", "/w").kind, "github-write");
  assert.equal(classify("gh api repos/o/r/pulls/1/comments -f body=x", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -f query='mutation { minimizeComment }'", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -f query='query { repository { name } }'", "/w").kind, "read");
  assert.equal(classify("gh api repos/o/r/pulls/1", "/w").kind, "read");
  assert.equal(classify("gh pr view 12 --json body", "/w").kind, "read");
  assert.equal(classify("gh search prs --review-requested=@me", "/w").kind, "read");
  assert.equal(classify("gh run list", "/w").kind, "read");
  assert.equal(classify("gh auth status", "/w").kind, "read");
  for (const command of ["gh pr merge 12", "gh pr edit 12 --title x", "gh pr close 12", "gh pr ready 12", "gh issue create -t x", "gh release create v1", "gh repo delete o/r"]) {
    assert.equal(classify(command, "/w").kind, "github-write", command);
  }
  assert.equal(classify("gh pr checkout 12", "/w").kind, "other");
  assert.equal(classify("gh api graphql -f query=@m.graphql", "/w").kind, "github-write");
  assert.equal(classify("gh api graphql -F query=@-", "/w").kind, "github-write");
  assert.equal(classify("git status --short", "/w").kind, "read");
  assert.deepEqual(classify("git add -A", "/w"), { kind: "add", dir: "/w", args: ["-A"] });
  assert.equal(classify("npm test", "/w").kind, "other");
});

test("gh api write flags count in attached and = forms, and help or version is a read", () => {
  for (const command of ["gh api -XPUT repos/o/r/pulls/12/merge", "gh api -X=PUT repos/o/r/pulls/12/merge", "gh api -XPOST repos/o/r/pulls/12/merge", "gh api repos/o/r/issues/1/comments -fbody=x", "gh api repos/o/r/issues/1/comments -Fbody=@f", "gh api repos/o/r/issues/1/comments --input=b.json", "gh api graphql --input=q.json"]) {
    assert.equal(classify(command, "/w").kind, "github-write", command);
  }
  for (const command of ["gh api -XGET repos/o/r/pulls", "gh pr --help", "gh pr merge --help", "gh pr ready -h", "gh pr create --help", "gh version"]) {
    assert.equal(classify(command, "/w").kind, "read", command);
  }
  assert.equal(evaluate("gh pr merge --subject --help 12", "/w", { gates: { ...ALL_GATES_ON, ghWrites: false } }).ask, true);
});

test("git commit and push are never blocked, chained or not", () => {
  for (const command of ["git add -A && git commit -m x && git push", "npm test && git push -u origin feat", "git commit -m 'why > because'", "gh pr create --draft --fill"]) {
    assert.equal(evaluate(command, "/w").allow, true, command);
  }
});

test("direct GitHub writes are denied with the approved path in the reason", () => {
  const result = evaluate("gh api -X POST repos/o/r/pulls/1/reviews --input r.json", "/w");
  assert.equal(result.allow, false);
  assert.match(result.reason, /github-write\.mjs/);
});

test("merging or marking a PR ready asks the user, closing or editing stays denied", () => {
  for (const command of ["cd x && gh pr merge 12 --squash", "gh pr ready 12"]) {
    const result = evaluate(command, "/w");
    assert.equal(result.allow, false, command);
    assert.equal(result.ask, true, command);
    assert.match(result.reason, /belongs to the user/, command);
  }
  for (const command of ["gh pr close 12", "gh pr edit 12 --base dev", "gh issue close 3"]) {
    const result = evaluate(command, "/w");
    assert.equal(result.allow, false, command);
    assert.notEqual(result.ask, true, command);
    assert.match(result.reason, /belongs to the user/, command);
  }
});

test("gh pr create must open a draft", () => {
  const result = evaluate("git push -u origin feat && gh pr create --fill", "/w");
  assert.equal(result.allow, false);
  assert.match(result.reason, /--draft/);
  assert.equal(evaluate("gh pr create -d --fill", "/w").allow, true);
});

test("pushes that rewrite history or land on an integration branch ask the user", () => {
  for (const command of ["git push origin dev", "git push -f", "git push --force-with-lease=feat origin feat", "git push origin +feat", "git push origin :feat", "git push origin HEAD:main", "git push -d origin feat", "cd x && git push origin refs/heads/production"]) {
    const result = evaluate(command, "/w");
    assert.equal(result.ask, true, command);
    assert.match(result.reason, /belongs to the user/, command);
  }
  assert.equal(evaluate("git push -u origin feat", "/w").allow, true);
});

test("a bare git push asks only when the branch tracks an integration branch", () => {
  const root = tempDir("tedy-gate-");
  const git = (...args) => execFileSync("git", ["-C", join(root, "work"), ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", join(root, "remote.git")]);
  execFileSync("git", ["clone", "-q", join(root, "remote.git"), join(root, "work")], { stdio: "ignore" });
  writeFileSync(join(root, "work", "a.txt"), "a\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git("push", "-q", "origin", "dev");
  assert.equal(evaluate("git push", join(root, "work")).ask, true);
  git("checkout", "-qb", "feat");
  assert.equal(evaluate("git push", join(root, "work")).allow, true);
});

test("a repository listed in gates.pushExempt pushes to main without asking, but still asks before rewriting history", () => {
  const kit = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(evaluate("git push origin main", kit).ask, true);
  const gates = { ...ALL_GATES_ON, pushExempt: [kit] };
  assert.equal(evaluate("git push origin main", kit, { gates }).allow, true);
  assert.equal(evaluate(`git -C ${kit} push -q origin main`, "/w", { gates }).allow, true);
  assert.equal(evaluate("git push -f origin main", kit, { gates }).ask, true);
});

test("with draftPrOnly off a ready PR may be opened; the user-owned gh writes stay blocked", () => {
  const gates = { ...ALL_GATES_ON, draftPrOnly: false };
  assert.equal(evaluate("gh pr create --fill", "/w", { gates }).allow, true);
  assert.equal(evaluate("gh pr merge 12", "/w", { gates }).allow, false);
});

test("git and gh are recognised behind command, exec, env and absolute paths", () => {
  for (const command of ["command git push --force origin main", "/usr/bin/git push --force origin main", "env FOO=1 git push --force origin main", "exec git push --force origin main", "env -i HOME=/h /usr/bin/git push -f"]) {
    assert.equal(evaluate(command, "/w").ask, true, command);
  }
  assert.equal(evaluate("command gh pr merge 12", "/w").allow, false);
  assert.equal(classify("/opt/homebrew/bin/git -C sub commit -m x", "/w").kind, "commit");
});

test("heredoc bodies are data, not commands", () => {
  assert.deepEqual(splitSegments("cat <<'EOF' > notes.md\ngit push --force origin main\nEOF\ngit status"), ["cat <<'EOF' > notes.md", "git status"]);
  assert.deepEqual(splitSegments("git commit -F - <<EOF\nmention github-write.mjs post here\nEOF"), ["git commit -F - <<EOF"]);
  assert.equal(evaluate("cat <<-'END'\n\tgit push -f origin main\n\tEND", "/w").allow, true);
});

test("a publishing script hidden from the permission rules asks; a plain node call is left to them", () => {
  assert.match(hiddenPublish("bash -c 'node /k/scripts/github-write.mjs post d.md'"), /github-write\.mjs post/);
  assert.ok(hiddenPublish("env X=1 node /k/scripts/gdoc-comments.mjs reply AAA --body-file b.txt"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/gdoc-comments.mjs edit AAA --body-file b.txt"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/gdoc-comments.mjs delete AAA"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/doc-comment-file.mjs post items.json --html f.html --apply"));
  assert.equal(hiddenPublish("env X=1 node /k/scripts/doc-comment-file.mjs post items.json --html f.html"), null);
  assert.ok(hiddenPublish("bash -c 'node /k/scripts/github-write.mjs unresolve PRRT_1'"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/openproject.mjs comment-edit 991 --body-file b.txt --apply"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/openproject.mjs relation 21448 21450 --type blocks --apply"));
  assert.ok(hiddenPublish("env X=1 node /k/scripts/openproject.mjs relation-delete 1000 --apply"));
  assert.equal(hiddenPublish("env X=1 node /k/scripts/openproject.mjs relation 21448 21450 --type blocks"), null);
  assert.ok(hiddenPublish("/usr/bin/node /k/scripts/figma-comments.mjs delete 12"));
  assert.ok(hiddenPublish("command node /k/scripts/openproject.mjs apply d.json"));
  assert.ok(hiddenPublish("eval 'node /k/scripts/openproject.mjs set 1 --status x --apply --lock 2'"));
  assert.equal(hiddenPublish("cd repo && node /k/scripts/github-write.mjs post d.md"), null);
  assert.equal(hiddenPublish("FOO=1 node /k/scripts/openproject.mjs apply d.json"), null);
  assert.equal(hiddenPublish("bash -c 'node /k/scripts/openproject.mjs preview d.json'"), null);
  assert.equal(hiddenPublish("git commit -F - <<'EOF'\nrun github-write.mjs post later\nEOF"), null);
  assert.equal(evaluate("sh -c 'node /k/scripts/github-write.mjs reply 1 2 --body-file r.txt'", "/w").ask, true);
});

test("with ghWrites off gh may write directly except merge and ready; with it on every gh write goes through github-write.mjs", () => {
  const off = { ...ALL_GATES_ON, ghWrites: false };
  for (const command of ["gh pr merge 12", "gh pr ready 12", "gh pr 'merge' 12 --squash", "\"gh\" pr ready 12", "gh pr -R o/r merge 12", "gh pr --repo=o/r merge 12", "gh -R o/r pr merge 12", "gh --repo o/r pr ready 12", "gh -Ro/r pr merge 12", "gh pr -R=o/r merge 12", "gh pr --admin=true merge 12", "gh --help=false pr ready 12", "gh pr --subject x merge 12", "gh pr -t x merge 12", "gh pr -t view merge 12", "gh pr --subject view merge 1", "gh pr -b x merge 1", "gh --body x pr merge 1", "gh --body status pr merge 1"]) assert.equal(evaluate(command, "/w", { gates: off }).ask, true, command);
  for (const command of ["gh pr comment 12 --body x", "gh api -X POST repos/o/r/issues/1/comments -f body=x"]) {
    assert.equal(evaluate(command, "/w", { gates: off }).allow, true, command);
    assert.equal(evaluate(command, "/w").allow, false, command);
  }
  assert.equal(evaluate("git push origin main", "/w", { gates: off }).ask, true);
  for (const command of ["gh issue -c view close 3", "gh pr -t view merge 12", "gh issue -c list close 3", "gh pr --body diff edit 1 --title y", "gh --body auth pr edit 1"]) assert.equal(evaluate(command, "/w").allow, false, command);
  for (const command of ["gh -R o/r pr create --title x --body y", "gh pr -R o/r create --title x --body y", "gh -Ro/r pr create --title x --body y", "gh pr -Ro/r create --title x --body y", "gh pr -t view create --body x", "gh pr --title view create --body x", "gh pr new --title x --body y"]) assert.equal(evaluate(command, "/w", { gates: off }).allow, false, command);
});

const GATE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "git-gate.mjs");
const F2_PUBLISH_RULES = ["post", "reply", "edit", "minimize", "resolve", "unresolve", "pr-body"].map((verb) => `Bash(*github-write.mjs*${verb}*)`)
  .concat(["Bash(*openproject.mjs*apply*)"], ["set", "comment", "comment-edit", "relation", "relation-delete", "rollback"].map((verb) => `Bash(*openproject.mjs*${verb}*--apply*)`))
  .concat(["post", "reply", "delete"].map((verb) => `Bash(*figma-comments.mjs*${verb}*)`), ["reply", "anchor", "edit", "delete"].map((verb) => `Bash(*gdoc-comments.mjs*${verb}*)`), ["Bash(*doc-comment-file.mjs*post*--apply*)"]);

function settingsWith(text) {
  const file = join(tempDir("tedy-settings-"), "settings.json");
  writeFileSync(file, text);
  return file;
}

function runEntry(command, { cwd = "/tmp", settings = settingsWith(JSON.stringify({ permissions: { ask: F2_PUBLISH_RULES } })), profile = profileWith({ gates: { publishQuote: true } }) } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
  const out = execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env: { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profile } });
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("a publish command the gate cannot check asks and names the error", () => {
  const dir = tempDir("tedy-draft-");
  writeFileSync(join(dir, "d.md"), "no header here\n");
  for (const [command, error] of [
    ["node x/github-write.mjs post", /argument/],
    ["node x/github-write.mjs post /tmp/tedy-does-not-exist.md", /ENOENT/],
    ["node x/github-write.mjs post d.md", /header/],
  ]) {
    const result = runEntry(command, { cwd: dir });
    assert.equal(result?.permissionDecision, "ask", command);
    assert.match(result.permissionDecisionReason, /could not check this publish command/, command);
    assert.match(result.permissionDecisionReason, error, command);
  }
});

test("a node publish that no ask rule covers asks; one the rules cover passes through", () => {
  const settingsFile = settingsWith(JSON.stringify({ permissions: { ask: F2_PUBLISH_RULES } }));
  for (const command of ["node /k/github-write.mjs post d.md", "node \"/k/github-write.mjs\" post d.md", "node /k/github-write.mjs --repo x/y post d.md", "cd /tmp && node /k/github-write.mjs post d.md", "node /k/openproject.mjs set 12 --status Done --apply", "node /k/github-write.mjs\tpost d.md", "node /k/openproject.mjs relation-delete 1 2 --apply", "node /k/doc-comment-file.mjs post f --apply"]) {
    assert.equal(evaluate(command, "/w", { settingsFile }).allow, true, command);
  }
  const withoutPost = settingsWith(JSON.stringify({ permissions: { ask: F2_PUBLISH_RULES.filter((rule) => !rule.includes("github-write.mjs*post")) } }));
  const result = evaluate("node /k/github-write.mjs post d.md", "/w", { settingsFile: withoutPost });
  assert.equal(result.ask, true);
  assert.match(result.reason, /no permission rule covers/);
  assert.equal(evaluate("node /k/github-write.mjs view 1", "/w", { settingsFile: withoutPost }).allow, true);
});

test("missing or unreadable ask rules make a node publish ask, without quoting the settings file", () => {
  for (const settings of [settingsWith(JSON.stringify({ permissions: {} })), settingsWith("{}"), join(tempDir("tedy-settings-"), "missing.json")]) {
    assert.equal(runEntry("node /k/github-write.mjs post d.md", { settings })?.permissionDecision, "ask", settings);
  }
  const broken = runEntry("node /k/github-write.mjs post d.md", { settings: settingsWith('{"env": {"TEDY_SECRET_MARKER": "x"') });
  assert.equal(broken?.permissionDecision, "ask");
  assert.equal(broken.permissionDecisionReason, "tedy gate: could not read the ask rules; approve only if you have seen the exact draft.");
  assert.equal(runEntry("git status", { settings: settingsWith("{") }), null);
});

test("the quote check runs only when gates.publishQuote is on", () => {
  const dir = tempDir("tedy-quote-");
  writeFileSync(join(dir, "d.md"), "# PR #7: comment line by line (head abcdef1)\n\n## 1. `a.ts:3`\n\nc check lại chỗ này giúp e nha\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, "");
  const settings = settingsWith(JSON.stringify({ permissions: { ask: F2_PUBLISH_RULES } }));
  const run = (publishQuote) => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "node /k/github-write.mjs post d.md" }, cwd: dir, transcript_path: transcript });
    const env = { ...process.env, TEDY_STATE_DIR: tempDir("tedy-state-"), TEDY_CLAUDE_SETTINGS: settings, TEDY_PROFILE_DIR: profileWith({ gates: { publishQuote } }) };
    return execFileSync("node", [GATE_ENTRY], { input, encoding: "utf8", env });
  };
  assert.equal(JSON.parse(run(true)).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run(false), "");
});

test("hidden or wrapped gh merges ask, and a deny anywhere in the command wins over an ask", () => {
  const off = { ...ALL_GATES_ON, ghWrites: false };
  const asks = (command, gates = off) => {
    const result = evaluate(command, "/w", { gates });
    return result.allow === false && result.ask === true;
  };
  const denied = (command, gates = ALL_GATES_ON) => {
    const result = evaluate(command, "/w", { gates });
    return result.allow === false && !result.ask;
  };
  for (const command of ["gh pr merge 1 && gh issue close 3", "git push --force && gh issue close 3", "x=$(gh issue close 3) && gh pr merge 1"]) assert.ok(denied(command), command);
  for (const command of [
    "echo $(gh pr merge 1)",
    "echo `gh pr ready 2`",
    "timeout 5 gh pr merge 1",
    "sudo gh pr merge 1",
    "nice -n 5 gh pr merge 1",
    "echo 1 | xargs gh pr merge",
    "env -C /tmp gh pr merge 1",
    "exec -a x gh pr merge 1",
    "command -p gh pr merge 1",
    "( gh pr merge 1 )",
    "{ gh pr merge 1; }",
    "! gh pr merge 1",
    "\\gh pr merge 1",
    "$'gh' pr merge 1",
    "gh pr m\\erge 12",
    "gh p\\r merge 12",
    "gh pr $ACTION 12",
    "gh pr ${A} 12",
    "gh mymerge 12",
  ]) assert.ok(asks(command), command);
  for (const command of ["gh api -X PUT repos/o/r/pulls/12/merge", "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", "gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {}) { clientMutationId } }'"]) {
    assert.ok(asks(command), command);
    assert.ok(asks(command, ALL_GATES_ON), command);
  }
  assert.ok(asks("gh api -X POST repos/o/r/pulls -f title=x -f head=b -f base=main"));
  assert.ok(denied("gh api -X POST repos/o/r/pulls -f title=x -f head=b -f base=main"));
  for (const command of ["rg \"gh pr merge\" docs", "git commit -m \"gh pr merge 1\"", "gh issue close 3", "gh pr view 1", "gh api repos/o/r/pulls/12/merge"]) assert.equal(evaluate(command, "/w", { gates: off }).allow, true, command);
});

test("the draft check reads gh's flag forms the way gh does", () => {
  const create = (flags) => evaluate(`gh pr create ${flags} --body x`, "/w", { gates: { ...ALL_GATES_ON, ghWrites: false } }).allow;
  for (const flags of ["--draft", "-d", "--draft=true", "-dt x", "-dF b.md", "-t x -d"]) assert.equal(create(flags), true, flags);
  for (const flags of ["-td", "-t -d", "--title -d", "--draft=false", ""]) assert.equal(create(flags), false, flags);
});

test("a project map that cannot be read makes gh pr create ask instead of passing", () => {
  const dir = tempDir("tedy-broken-maps-");
  writeFileSync(join(dir, "broken.md"), "# no json block\n");
  const result = evaluate("gh pr create --draft --body x", "/w", { projectsDir: dir });
  assert.equal(result.ask, true);
  assert.match(result.reason, /project map/);
});

test("command substitution nested past the gate's depth limit asks", () => {
  assert.equal(evaluate("echo " + "$(".repeat(30) + "gh pr view 1" + ")".repeat(30), "/w").ask, true);
  assert.equal(evaluate("echo $(echo $(gh pr view 1))", "/w").allow, true);
});
