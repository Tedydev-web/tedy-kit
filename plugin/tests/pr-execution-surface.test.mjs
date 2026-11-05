import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executionSurface, formatSurface } from "../lib/pr-execution-surface.mjs";
import { commitFile, git } from "./git-sibling-for-tests.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/pr-execution-surface.mjs", import.meta.url));
const PACKAGE = { name: "app", packageManager: "pnpm@9.0.0", scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit", build: "node scripts/build.js" }, dependencies: { react: "^18.0.0" }, devDependencies: { vitest: "^1.0.0" } };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function reviewRepo(change) {
  const dir = tempDir("tedy-surface-");
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "package.json", json(PACKAGE));
  commitFile(dir, "scripts/build.js", "console.log(1);\n");
  commitFile(dir, "vitest.config.ts", "export default {};\n");
  commitFile(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "checkout", "-q", "-b", "pr");
  change(dir);
  return dir;
}

test("a changed test script, a new dependency with its lockfile, a changed config and a file a script names are all listed", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "package.json", json({ ...PACKAGE, scripts: { ...PACKAGE.scripts, test: "vitest run && node scripts/post.js" }, devDependencies: { ...PACKAGE.devDependencies, "left-pad": "^1.3.0" } }));
    commitFile(repo, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    commitFile(repo, "vitest.config.ts", "export default { setupFiles: [] };\n");
    commitFile(repo, "scripts/build.js", "console.log(2);\n");
    commitFile(repo, "src/a.test.ts", "test('a', () => {});\n");
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.scripts, [{ file: "package.json", name: "test", before: "vitest run", after: "vitest run && node scripts/post.js" }]);
  assert.deepEqual(surface.dependencies, [{ file: "package.json", section: "devDependencies", name: "left-pad", before: null, after: "^1.3.0" }]);
  assert.deepEqual(surface.lockfiles, ["pnpm-lock.yaml"]);
  assert.deepEqual(surface.config, ["vitest.config.ts"]);
  assert.deepEqual(surface.named, [{ file: "scripts/build.js", by: "package.json scripts.build" }]);
  assert.equal(surface.tests, 1);
  assert.equal(surface.lintSurfaceChanged, true);
  const text = formatSurface(surface);
  for (const line of ['scripts: package.json scripts.test: "vitest run" -> "vitest run && node scripts/post.js"', "dependencies: package.json devDependencies.left-pad: (none) -> ^1.3.0", "lockfiles: pnpm-lock.yaml", "config: vitest.config.ts", "named by a script: scripts/build.js (package.json scripts.build)", "changed test files: 1", "typecheck/lint surface: changed (scripts, config, named by a script)"]) assert.ok(text.split("\n").includes(line), `${line}\n---\n${text}`);
});

test("script lines that download and run a package are listed, in any package.json of the head", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "packages/ui/package.json", json({ name: "ui", scripts: { lint: "npx eslint@9 .", gen: "pnpm dlx codegen", fmt: "bunx prettier --check ." } }));
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.downloads, [
    { file: "packages/ui/package.json", name: "lint", line: "npx eslint@9 ." },
    { file: "packages/ui/package.json", name: "gen", line: "pnpm dlx codegen" },
    { file: "packages/ui/package.json", name: "fmt", line: "bunx prettier --check ." },
  ]);
  assert.ok(formatSurface(surface).includes("downloads and runs: packages/ui/package.json scripts.lint: npx eslint@9 ."));
});

test("a changed packageManager, .npmrc, husky hook or Makefile counts as executed surface", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "package.json", json({ ...PACKAGE, packageManager: "pnpm@9.9.9" }));
    commitFile(repo, ".npmrc", "registry=https://example.com\n");
    commitFile(repo, ".husky/pre-commit", "npm test\n");
    commitFile(repo, "Makefile", "all:\n\techo hi\n");
    commitFile(repo, "eslint.config.mjs", "export default [];\n");
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.dependencies, [{ file: "package.json", section: "packageManager", name: "", before: "pnpm@9.0.0", after: "pnpm@9.9.9" }]);
  assert.deepEqual(surface.config.sort(), [".husky/pre-commit", ".npmrc", "Makefile", "eslint.config.mjs"]);
  assert.equal(surface.lintSurfaceChanged, true);
});

test("a source-only change reports the typecheck and lint surface unchanged", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "src/a.ts", "export const a = 2;\n");
    commitFile(repo, "src/__tests__/a.ts", "test('a', () => {});\n");
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual([surface.scripts, surface.dependencies, surface.lockfiles, surface.config, surface.named, surface.downloads], [[], [], [], [], [], []]);
  assert.equal(surface.tests, 1);
  assert.equal(surface.lintSurfaceChanged, false);
  const text = formatSurface(surface);
  assert.ok(text.includes("typecheck/lint surface: unchanged"), text);
  assert.ok(text.includes("scripts: none"), text);
});

test("the surface is taken against the merge base, so a base that moved on lists nothing of its own", () => {
  const dir = reviewRepo((repo) => commitFile(repo, "src/a.ts", "export const a = 3;\n"));
  git(dir, "checkout", "-q", "main");
  commitFile(dir, "vitest.config.ts", "export default { base: true };\n");
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.config, []);
  assert.equal(surface.changed, 1);
});

test("a package.json that is not valid JSON at the head is listed as changed scripts", () => {
  const dir = reviewRepo((repo) => commitFile(repo, "package.json", "{ not json\n"));
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.scripts, [{ file: "package.json", name: "", before: null, after: "(not valid JSON at the head)" }]);
  assert.equal(surface.lintSurfaceChanged, true);
});

test("the command prints the surface from the repository it runs in, and fails loudly on an unknown ref", () => {
  const dir = reviewRepo((repo) => commitFile(repo, "src/a.ts", "export const a = 4;\n"));
  const ok = spawnSync("node", [SCRIPT, "main", "pr"], { cwd: dir, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^execution surface of pr \([0-9a-f]{7}\) against main \(merge base [0-9a-f]{7}\), 1 changed file\n/);
  const missing = spawnSync("node", [SCRIPT, "main", "refs/pr/99"], { cwd: dir, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pr-execution-surface: refs\/pr\/99 is not a commit/);
  const usage = spawnSync("node", [SCRIPT, "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(usage.status, 2);
});
