import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDenylist, scanHistory, scanText, scanTree } from "../lib/public-scan.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = new URL("../lib/public-scan.mjs", import.meta.url).pathname;
const TOKEN = "ghp_" + "a1".repeat(18);
const LEAKED_EMAIL = "dev" + "@" + "company.io";
const HOME = (user) => "/" + "home/" + user + "/";

function denylistFile(lines) {
  const file = join(tempDir("tedy-scan-deny-"), "public-denylist.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function treeWith(files) {
  const dir = tempDir("tedy-scan-tree-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const identity = (email) => ({ ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: email });

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8", env: identity("p@users.noreply.github.com") });
}

const rulesOf = (hits) => hits.map((hit) => `${hit.label}:${hit.line} ${hit.rule}`);
const deny = loadDenylist(denylistFile(["# company terms", "acmecorp", "", "Blue Harbor", "Lâm"]));

test("a clean tree has no hits", () => {
  assert.deepEqual(scanTree(treeWith({ "src/a.mjs": "export const a = 1;\n", "README.md": "Install with ~/.config/tedy and git@github.com:o/r.git\n" }), deny), []);
});

test("absolute home paths are caught, the tilde form is not", () => {
  assert.deepEqual(rulesOf(scanText("a.md", `see ${HOME("alice")}work\nsee ~/work\nsee /${"Users"}/bob/x\n`, deny)), ["a.md:1 home-path", "a.md:3 home-path"]);
});

test("email addresses are caught except noreply, git@ and example domains", () => {
  const text = `a ${LEAKED_EMAIL}\nb p@users.noreply.github.com\nc git@github.com:o/r\nd x@example.com\ne react@18.2.0\n`;
  assert.deepEqual(rulesOf(scanText("a.md", text, deny)), ["a.md:1 email"]);
});

test("secret shapes and long hex strings are caught under their own rule names", () => {
  const text = `GITHUB_TOKEN=${TOKEN}\nbare ${TOKEN}\nsha ${"f".repeat(40)}\nshort sha abcdef12\n`;
  assert.deepEqual(rulesOf(scanText("a.env", text, deny)), ["a.env:1 secret", "a.env:2 secret", "a.env:3 long-hex"]);
});

test("code that reads or forwards a token is not a secret; a quoted literal, a key header or a cloud key is", () => {
  const code = 'const token = readFileSync(join(homedir(), ".config", "figma", "token"), "utf8").trim();\nheaders: { Authorization: `Bearer ${bearer}` }\nclient_secret=<secret>\n';
  assert.deepEqual(scanText("a.mjs", code, deny), []);
  const leaks = 'JSON.stringify({ url, token: "' + "test-token-value" + '" })\n-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\naws AKIA' + "ABCDEFGHIJKLMNOP" + "\nkey sk-ant-" + "x".repeat(24) + '\ntoken: "x"\n';
  assert.deepEqual(rulesOf(scanText("a.mjs", leaks, deny)), ["a.mjs:1 secret", "a.mjs:2 secret", "a.mjs:3 secret", "a.mjs:4 secret"]);
});

test("denylist terms match whole words, any case, and name the denylist line instead of the term", () => {
  const text = "repo acmecorp-wallet-fe\nACMECORP\nacmecorporate\nthe blue harbor screen\nPR của Lâm\nngành lâmnghiệp\n";
  assert.deepEqual(rulesOf(scanText("a.md", text, deny)), ["a.md:1 denylist#2", "a.md:2 denylist#2", "a.md:4 denylist#4", "a.md:5 denylist#5"]);
});

test("file names are scanned as line 0, and binary files are reported as unscanned", () => {
  const dir = treeWith({ "projects/acmecorp.md": "clean\n", "img.png": "PNG\u0000acmecorp" });
  assert.deepEqual(rulesOf(scanTree(dir, deny)), ["img.png:0 binary-unscanned", "projects/acmecorp.md:0 denylist#2"]);
});

test("tree mode in a git repository scans tracked and untracked files but skips ignored and deleted ones", () => {
  const repo = treeWith({ ".gitignore": "out/\n", "a.md": "clean\n", "gone.md": "acmecorp\n" });
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  rmSync(join(repo, "gone.md"));
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "out", "x.md"), "acmecorp\n");
  writeFileSync(join(repo, "new.md"), "acmecorp\n");
  assert.deepEqual(rulesOf(scanTree(repo, deny)), ["new.md:1 denylist#2"]);
});

test("history mode finds a blob removed from HEAD, the author email of a commit and a tag message", () => {
  const repo = treeWith({ "a.md": "clean\n", "notes.md": "the Blue Harbor launch\n" });
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "rm", "-q", "notes.md");
  git(repo, "commit", "-qm", "drop notes");
  assert.deepEqual(scanTree(repo, deny), []);
  const history = rulesOf(scanHistory(repo, deny));
  assert.equal(history.length, 1);
  assert.match(history[0], /^notes\.md@[0-9a-f]{7}:1 denylist#4$/);

  execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "empty"], { env: identity(LEAKED_EMAIL) });
  git(repo, "tag", "-a", "v1", "-m", "release for acmecorp");
  const all = rulesOf(scanHistory(repo, deny));
  assert.ok(all.some((hit) => /^commit [0-9a-f]{7}:\d+ email$/.test(hit)));
  assert.ok(all.some((hit) => /^tag [0-9a-f]{7}:\d+ denylist#2$/.test(hit)));
});

test("the command prints only locations and rule names, exits 1 on hits and 0 when clean", () => {
  const dirty = treeWith({ "a.env": `TOKEN=${TOKEN}\nacmecorp\n` });
  const file = denylistFile(["acmecorp"]);
  const result = spawnSync("node", [SCRIPT, "tree", dirty, "--denylist", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "a.env:1 secret\na.env:2 denylist#1\n");
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
  assert.ok(!`${result.stdout}${result.stderr}`.includes("acmecorp"));
  const clean = spawnSync("node", [SCRIPT, "tree", treeWith({ "a.md": "clean\n" })], { encoding: "utf8" });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, "");
  assert.equal(spawnSync("node", [SCRIPT, "nope"], { encoding: "utf8" }).status, 2);
});

test("the scanner and its tests pass their own scan", () => {
  for (const name of ["../lib/public-scan.mjs", "./public-scan.test.mjs"]) assert.deepEqual(scanText(name, readFileSync(new URL(name, import.meta.url), "utf8"), []), []);
});

test("file mode scans exactly the named file even inside a gitignored folder, where tree mode sees nothing", () => {
  const repo = treeWith({ ".gitignore": "reports/\n", "reports/learn.leaving.md": "Promote: acmecorp rule\n" });
  git(repo, "init", "-q");
  const file = denylistFile(["acmecorp"]);
  const tree = spawnSync("node", [SCRIPT, "tree", repo, "--denylist", file], { encoding: "utf8" });
  assert.equal(tree.status, 0);
  const scanned = spawnSync("node", [SCRIPT, "file", join(repo, "reports", "learn.leaving.md"), "--denylist", file], { encoding: "utf8" });
  assert.equal(scanned.status, 1);
  assert.equal(scanned.stdout, `${join(repo, "reports", "learn.leaving.md")}:1 denylist#1\n`);
  assert.equal(spawnSync("node", [SCRIPT, "file", join(repo, "missing.md")], { encoding: "utf8" }).status, 2);
});
