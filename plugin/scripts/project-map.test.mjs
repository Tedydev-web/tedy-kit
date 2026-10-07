import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepos, missingFields, parseMap, resolveMap } from "./project-map.mjs";

const mapFile = (data) => `# Project map\n\nNotes for people.\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "tedy-maps-"));
  writeFileSync(join(dir, "alpha.md"), mapFile({ name: "alpha", paths: ["/w/tonpass"], repos: [{ path: "fe", role: "FE" }], language: { pr_review: "vi" } }));
  writeFileSync(join(dir, "alpha-fe.md"), mapFile({ name: "alpha-fe", paths: ["/w/tonpass/tonpass-wallet-fe"], repos: [{ path: ".", role: "FE" }], language: { pr_review: "vi" } }));
  writeFileSync(join(dir, "_schema.md"), "# schema, not a map\n");
});

test("parseMap reads the single json block and reports a broken one loudly", () => {
  assert.equal(parseMap(mapFile({ name: "x" })).name, "x");
  assert.throws(() => parseMap("# no block"), /no ```json block/);
  assert.throws(() => parseMap("```json\n{ name: x }\n```"), /JSON/);
});

test("resolveMap picks the longest path prefix and respects directory boundaries", () => {
  assert.equal(resolveMap("/w/tonpass/tonpass-wallet-be/src", dir).map.name, "alpha");
  assert.equal(resolveMap("/w/tonpass/tonpass-wallet-fe/apps", dir).map.name, "alpha-fe");
  assert.equal(resolveMap("/w/tonpass", dir).map.name, "alpha");
  assert.equal(resolveMap("/w/tonpass-other", dir), null);
  assert.equal(resolveMap("/elsewhere", dir), null);
});

test("missingFields separates required gaps from optional ones", () => {
  assert.deepEqual(missingFields({ name: "a", paths: ["/w"], repos: [{ path: ".", role: "FE" }], language: { pr_review: "vi" } }).required, []);
  const gaps = missingFields({ name: "a", paths: [], repos: [{ path: "." }] });
  assert.deepEqual(gaps.required, ["paths", "repos[0].role", "language.pr_review"]);
  assert.ok(gaps.optional.includes("prd"));
  assert.equal(missingFields({ prd: { files: ["docs/prd/a.md"] } }).optional.includes("prd"), false);
});

test("checkRepos reports a missing directory and a missing integration branch", () => {
  const root = mkdtempSync(join(tmpdir(), "tedy-ws-"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, join(root, "fe")], { stdio: "ignore" });
  execFileSync("git", ["-C", join(root, "fe"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", join(root, "fe"), "push", "-q", "origin", "main"], { stdio: "ignore" });
  mkdirSync(join(root, "plain"));
  const results = checkRepos({ paths: [root], repos: [{ path: "fe", role: "FE", branch: "main" }, { path: "fe", role: "FE", branch: "dev" }, { path: "plain", role: "BE" }, { path: "gone", role: "BE" }] });
  assert.deepEqual(results.map((result) => result.status), ["ok", "fail", "fail", "fail"]);
  assert.match(results[1].detail, /origin\/dev/);
  assert.match(results[2].detail, /not a git repository/);
  assert.match(results[3].detail, /does not exist/);
});
