import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  for (const line of ['scripts: package.json scripts.test: "vitest run" -> "vitest run && node scripts/post.js"', "dependencies: package.json devDependencies.left-pad: (none) -> ^1.3.0", "lockfiles: pnpm-lock.yaml", "config: vitest.config.ts", "named by a script: scripts/build.js (package.json scripts.build)", "changed test files: 1", "typecheck/lint surface: changes seen (scripts, config, named by a script)"]) assert.ok(text.split("\n").includes(line), `${line}\n---\n${text}`);
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

test("a changed packageManager, .npmrc, husky hook, Makefile or tsconfig counts as typecheck and lint surface", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "package.json", json({ ...PACKAGE, packageManager: "pnpm@9.9.9" }));
    commitFile(repo, ".npmrc", "registry=https://example.com\n");
    commitFile(repo, ".husky/pre-commit", "npm test\n");
    commitFile(repo, "Makefile", "all:\n\techo hi\n");
    commitFile(repo, "eslint.config.mjs", "export default [];\n");
    commitFile(repo, "tsconfig.app.json", "{\"compilerOptions\":{\"strict\":false}}\n");
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual(surface.dependencies, [{ file: "package.json", section: "packageManager", name: "", before: "pnpm@9.0.0", after: "pnpm@9.9.9" }]);
  assert.deepEqual(surface.config.sort(), [".husky/pre-commit", ".npmrc", "Makefile", "eslint.config.mjs", "tsconfig.app.json"]);
  assert.equal(surface.lintSurfaceChanged, true);
});

test("a source-only change lists no change seen and never says a run is safe", () => {
  const dir = reviewRepo((repo) => {
    commitFile(repo, "src/a.ts", "export const a = 2;\n");
    commitFile(repo, "src/__tests__/a.ts", "test('a', () => {});\n");
  });
  const surface = executionSurface(dir, "main", "pr");
  assert.deepEqual([surface.scripts, surface.dependencies, surface.lockfiles, surface.config, surface.named, surface.imported, surface.vendored, surface.symlinks, surface.downloads], [[], [], [], [], [], [], [], [], []]);
  assert.equal(surface.tests, 1);
  assert.equal(surface.lintSurfaceChanged, false);
  const text = formatSurface(surface);
  assert.ok(text.includes("typecheck/lint surface: no change seen"), text);
  assert.ok(text.includes("scripts: none"), text);
  assert.ok(text.includes("running any project script (tests, typecheck, lint) runs code from this PR; this list is only what the kit can see, not a complete list"), text);
  assert.ok(text.includes("not checked:"), text);
  assert.doesNotMatch(text, /run no file|unchanged;|safe/i);
});

const TOOLING = {
  "package.json": json({ name: "app", scripts: { lint: "eslint --rulesdir rules .", build: "node scripts/", check: "node tools/check.mjs" } }),
  "eslint.config.js": "import rules from './lint-rules/index.js';\nexport default [rules];\n",
  "lint-rules/index.js": "export default {};\n",
  "rules/a.js": "module.exports = {};\n",
  "scripts/index.js": "console.log(1);\n",
  "tools/check.mjs": "import './lib/helper.mjs';\n",
  "tools/lib/helper.mjs": "export {};\n",
  "src/a.ts": "export const a = 1;\n",
};

function toolingRepo(change) {
  const dir = tempDir("tedy-surface-tooling-");
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(TOOLING)) commitFile(dir, path, text);
  git(dir, "checkout", "-q", "-b", "pr");
  change(dir);
  git(dir, "add", "-A", "-f");
  git(dir, "commit", "-q", "-m", "pr");
  return executionSurface(dir, "main", "pr");
}

const put = (repo, path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

test("committed node_modules, symlinks, more config names, package.json tool config, named directories and local imports count as surface", () => {
  for (const [label, change, field, expected] of [
    ["a committed node_modules binary", (repo) => put(repo, "node_modules/.bin/eslint", "#!/bin/sh\n"), "vendored", "node_modules/.bin/eslint"],
    ["a node_modules symlink", (repo) => symlinkSync("src", join(repo, "node_modules")), "symlinks", "node_modules"],
    ["a file an unchanged config imports", (repo) => put(repo, "lint-rules/index.js", "process.exit(9);\n"), "imported", { file: "lint-rules/index.js", by: "eslint.config.js" }],
    ["a file an unchanged named script imports", (repo) => put(repo, "tools/lib/helper.mjs", "process.exit(9);\n"), "imported", { file: "tools/lib/helper.mjs", by: "tools/check.mjs" }],
    ["a file in a directory --rulesdir names", (repo) => put(repo, "rules/a.js", "process.exit(9);\n"), "named", { file: "rules/", by: "package.json scripts.lint", changed: 1 }],
    ["a file in a directory node runs", (repo) => put(repo, "scripts/index.js", "process.exit(9);\n"), "named", { file: "scripts/", by: "package.json scripts.build", changed: 1 }],
    [".prettierrc without an extension", (repo) => put(repo, ".prettierrc", '{"plugins":["./p.js"]}\n'), "config", ".prettierrc"],
    [".babelrc.js", (repo) => put(repo, ".babelrc.js", "x\n"), "config", ".babelrc.js"],
    ["babel.config.json", (repo) => put(repo, "babel.config.json", "{}\n"), "config", "babel.config.json"],
    [".stylelintrc.json", (repo) => put(repo, "web/.stylelintrc.json", "{}\n"), "config", "web/.stylelintrc.json"],
    [".pnpmfile.cjs", (repo) => put(repo, ".pnpmfile.cjs", "x\n"), "config", ".pnpmfile.cjs"],
    ["jest.config.json", (repo) => put(repo, "jest.config.json", "{}\n"), "config", "jest.config.json"],
    [".mocharc.yml", (repo) => put(repo, ".mocharc.yml", "require: ./x.js\n"), "config", ".mocharc.yml"],
    ["bunfig.toml", (repo) => put(repo, "bunfig.toml", "preload = ['./x.ts']\n"), "config", "bunfig.toml"],
    ["package.json eslintConfig", (repo) => put(repo, "package.json", json({ ...JSON.parse(TOOLING["package.json"]), eslintConfig: { extends: "./x.js" } })), "config", "package.json eslintConfig"],
    ["package.json prettier", (repo) => put(repo, "package.json", json({ ...JSON.parse(TOOLING["package.json"]), prettier: "./p.js" })), "config", "package.json prettier"],
    ["package.json babel", (repo) => put(repo, "package.json", json({ ...JSON.parse(TOOLING["package.json"]), babel: { plugins: ["./b.js"] } })), "config", "package.json babel"],
  ]) {
    const surface = toolingRepo(change);
    assert.deepEqual(surface[field].filter((item) => JSON.stringify(item) === JSON.stringify(expected)), [expected], `${label}: ${JSON.stringify(surface[field])}`);
    assert.equal(surface.lintSurfaceChanged, true, label);
  }
  assert.equal(toolingRepo((repo) => put(repo, "src/a.ts", "export const a = 2;\n")).lintSurfaceChanged, false);
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
