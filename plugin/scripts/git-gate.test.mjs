import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, splitSegments, classify } from "./git-gate.mjs";

test("splitSegments handles chains, pipes, newlines and shell wrappers", () => {
  assert.deepEqual(splitSegments("cd x && git push; echo ok | cat\ngit status"), ["cd x", "git push", "echo ok", "cat", "git status"]);
  assert.deepEqual(splitSegments("bash -c 'git add . && git push'"), ["git add .", "git push"]);
  assert.deepEqual(splitSegments('echo "a && b"'), ['echo "a && b"']);
});

test("classify recognises git and gh actions through env vars and -C", () => {
  assert.deepEqual(classify("git push origin x", "/w"), { kind: "push", dir: "/w" });
  assert.deepEqual(classify("FOO=1 git -C sub commit -am msg", "/w"), { kind: "commit", dir: "/w/sub", all: true });
  assert.deepEqual(classify("git -c core.x=y push", "/w"), { kind: "push", dir: "/w" });
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

test("merging or closing a PR is denied as the user's call, not routed to github-write.mjs", () => {
  const result = evaluate("cd x && gh pr merge 12 --squash", "/w");
  assert.equal(result.allow, false);
  assert.match(result.reason, /belongs to the user/);
});
