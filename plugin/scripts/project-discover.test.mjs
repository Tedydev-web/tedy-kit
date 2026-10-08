import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectStack, discover, extractLinks, guessIntegration, verifyScripts } from "./project-discover.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

test("extractLinks finds Google Doc tabs and Figma nodes, deduplicated", () => {
  const text = [
    "PRD https://docs.google.com/document/d/1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns/edit?pli=1&tab=t.p59op2unmr",
    "same doc https://docs.google.com/document/d/1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns/edit?usp=sharing",
    "design https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=3445-6702&m=dev",
    "again https://www.figma.com/design/LcVgoxchcAU5J4TYLa3AQ8/Family-Wallet-UI?node-id=3445-6702",
  ].join("\n");
  assert.deepEqual(extractLinks(text), {
    docs: [{ doc: "1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns", tab: "t.p59op2unmr" }, { doc: "1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns", tab: null }],
    figma: [{ file: "LcVgoxchcAU5J4TYLa3AQ8", node: "3445:6702" }],
  });
  assert.deepEqual(extractLinks("PRD for Family Wallet: Google Doc `1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns` (export works)").docs, [{ doc: "1skwBNY3Zh7HO47PAVQHVGP69iEEjHI6TaBdA44tGsns", tab: null }]);
});

test("detectStack names the markers it sees", () => {
  assert.deepEqual(detectStack(["package.json", "nest-cli.json", "src"]), ["node", "nestjs"]);
  assert.deepEqual(detectStack(["foundry.toml", "tact.config.json"]), ["foundry", "tact"]);
  assert.deepEqual(detectStack(["README.md"]), []);
});

test("verifyScripts keeps the scripts that check code", () => {
  const scripts = { dev: "vite", build: "vite build", typecheck: "tsc --noEmit", lint: "eslint .", "test:unit": "vitest run", "format:check": "prettier --check ." };
  assert.deepEqual(verifyScripts({ scripts }), ["typecheck", "lint", "test:unit", "format:check"]);
  assert.deepEqual(verifyScripts({}), []);
});

test("guessIntegration prefers the base most merged PRs used, then dev, develop, staging", () => {
  assert.deepEqual(guessIntegration(["main", "dev"], ["dev", "dev", "main", "dev"]), { branch: "dev", evidence: "base of 3/4 merged PRs" });
  assert.deepEqual(guessIntegration(["master", "develop"], []), { branch: "develop", evidence: "origin/develop exists; no merged PRs read" });
  assert.deepEqual(guessIntegration(["main"], []), { branch: null, evidence: "no dev, develop or staging branch and no merged PRs read" });
});

test("discover lists repositories, instruction files, PRD markdown and links without network", () => {
  const root = tempDir("tedy-discover-");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const fe = join(root, "app-fe");
  execFileSync("git", ["clone", "-q", remote, fe], { stdio: "ignore" });
  writeFileSync(join(fe, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
  execFileSync("git", ["-C", fe, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", fe, "push", "-q", "origin", "main", "main:dev"], { stdio: "ignore" });
  execFileSync("git", ["-C", fe, "fetch", "-q", "origin"]);
  writeFileSync(join(root, "AGENTS.md"), "Design: https://www.figma.com/design/AbC123/X?node-id=1-2\n");
  mkdirSync(join(root, "docs", "prd"), { recursive: true });
  writeFileSync(join(root, "docs", "prd", "spec.md"), "# Spec\n");
  const found = discover(root, { mergedBases: () => [], memoryDir: join(root, "no-memory") });
  assert.equal(found.repos.length, 1);
  assert.equal(found.repos[0].path, "app-fe");
  assert.deepEqual(found.repos[0].stack, ["node"]);
  assert.deepEqual(found.repos[0].verify, ["typecheck"]);
  assert.equal(found.repos[0].integration.branch, "dev");
  assert.deepEqual(found.instructions, ["AGENTS.md"]);
  assert.deepEqual(found.prdFiles, ["docs/prd/spec.md"]);
  assert.deepEqual(found.links.figma, [{ file: "AbC123", node: "1:2", sources: ["AGENTS.md"] }]);
});
