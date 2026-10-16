import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, splitSegments, classify, hiddenPublish } from "./git-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

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

test("the tedy-kit repository pushes to main without asking, but still asks before rewriting history", () => {
  const kit = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(evaluate("git push origin main", kit).allow, true);
  assert.equal(evaluate(`git -C ${kit} push -q origin main`, "/w").allow, true);
  assert.equal(evaluate("git push -f origin main", kit).ask, true);
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
