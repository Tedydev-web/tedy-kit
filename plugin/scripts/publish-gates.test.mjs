import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./git-gate.mjs";
import { sameComment } from "./openproject.mjs";
import { publishes, unshown } from "./publish-quote-gate.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";
import { evaluate as trackerToken, trackerHost } from "./tracker-token-gate.mjs";

const mapFile = (data) => `# Project map\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

function projects() {
  const dir = tempDir("tedy-gate-maps-");
  const root = tempDir("tedy-gate-root-");
  mkdirSync(join(root, "fe"));
  writeFileSync(join(dir, "tracked.md"), mapFile({ name: "tracked", paths: [root], repos: [{ path: "fe", role: "FE" }], tracker: { type: "openproject", project: "x" } }));
  return { dir, repo: join(root, "fe") };
}

test("a PR in a tracked project must carry OP#<id> in its body", () => {
  const { dir, repo } = projects();
  const create = (rest) => evaluate(`gh pr create --draft --base dev --title "fix: x" ${rest}`, repo, dir);
  assert.equal(create('--body "OP#21453"').allow, true);
  assert.equal(create("--body=OP#21453").allow, true);
  assert.equal(create('--body ""').allow, false);
  assert.match(create('--body ""').reason, /OP#<id>/);
  assert.equal(create("--fill").allow, false);
  assert.equal(create('--body "#21372"').allow, false);
  writeFileSync(join(repo, "body.md"), "OP#21376\n");
  assert.equal(create("--body-file body.md").allow, true);
  assert.equal(create("--body-file missing.md").allow, false);
  assert.equal(evaluate('gh pr create --draft --body ""', "/somewhere/else", dir).allow, true);
});

test("the tracker token file and direct writes to the tracker host are denied in any tool input", () => {
  const host = "op.example.com";
  assert.ok(trackerToken({ command: "python3 -c \"import json;json.load(open('/home/u/.config/op/config.json'))\"" }, host));
  assert.ok(trackerToken({ code: "p = Path.home() / '.config' / 'op' / 'config.json'" }, host));
  assert.ok(trackerToken({ code: "os.path.join(home, '.config', 'op', 'config.json')" }, host));
  assert.ok(trackerToken({ file_path: "/home/u/.config/op/config.json" }, host));
  assert.ok(trackerToken({ commands: [{ label: "x", command: "curl -X PATCH https://op.example.com/api/v3/work_packages/1" }] }, host));
  assert.ok(trackerToken({ code: "requests.post('https://op.example.com/api/v3/work_packages/1/activities')" }, host));
  assert.equal(trackerToken({ command: "curl https://op.example.com/api/v3/statuses" }, host), null);
  assert.equal(trackerToken({ command: "node plugin/scripts/openproject.mjs set 21453 --status Fixed --apply --lock 3" }, host), null);
  assert.equal(trackerToken({ command: "cat ~/.config/op/sync/op.example.com__x.map.json" }, host), null);
  assert.equal(trackerHost(() => JSON.stringify({ url: "https://op.example.com/", token: "t" })), "op.example.com");
  assert.equal(trackerHost(() => "not json"), null);
});

const draft = "# PR #735: comment line by line (head abc1234)\n\n## 1. `src/a.ts:10`\nc check lại chỗ này giúp e nha\n\n---\n\n## 2. `src/b.ts:4`\nđoạn này thiếu case rỗng\n";
const at = (ms) => new Date(ms).toISOString();
const say = (ms, text) => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "text", text }] } });

test("posting needs every comment body shown to the user after the draft's last change", () => {
  const dir = tempDir("tedy-quote-");
  const file = join(dir, "review-735-line-comments.md");
  const read = (path) => (path === file ? draft : "OP reply");
  const found = publishes(`cd ${dir} && node /k/github-write.mjs post review-735-line-comments.md`, "/", read);
  assert.equal(found.length, 1);
  assert.equal(found[0].bodies.length, 2);
  const mtime = () => 1_000;
  const quoted = "> c check lại chỗ này giúp e nha\n\n> đoạn này thiếu\n> case rỗng";
  assert.deepEqual(unshown(found, [say(2_000, quoted)], mtime), []);
  assert.deepEqual(unshown(found, [say(500, quoted)], mtime).length, 2);
  assert.deepEqual(unshown(found, [say(2_000, "Đăng review PR #735 (2 comment) thế nào?")], mtime).length, 2);
  const asked = { type: "assistant", timestamp: at(2_000), message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Đăng?", options: [{ label: "Đăng", description: "c check lại chỗ này giúp e nha / đoạn này thiếu case rỗng" }] }] } }] } };
  assert.deepEqual(unshown(found, [asked], mtime), []);
  assert.equal(publishes(`node /k/github-write.mjs post ${file} --dry-run`, "/", read).length, 0);
  const reply = publishes("node /k/github-write.mjs reply 735 99 --body \"đã sửa ạ.\"", "/", read);
  assert.deepEqual(unshown(reply, [say(10, "Reply: đã sửa ạ.")], mtime), []);
  assert.equal(unshown(reply, [say(10, "Reply thread 5?")], mtime).length, 1);
});

test("an OpenProject comment already on the work package is refused as a duplicate", () => {
  const activities = [{ id: 1, comment: { raw: "" } }, { id: 7, comment: { raw: "Đã fix ở PR #744\n" } }];
  assert.equal(sameComment(activities, "Đã fix ở PR #744")?.id, 7);
  assert.equal(sameComment(activities, "khác"), null);
});
