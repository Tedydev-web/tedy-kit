import "./test-isolation.mjs";
import { evaluate as gitGate, hiddenPublish, splitSegments } from "../gates/git-gate.mjs";
import { evaluate as trackerToken } from "../gates/tracker-token-gate.mjs";
import { checkEdit } from "../gates/no-comments-gate.mjs";
import { publishes } from "../gates/publish-quote-gate.mjs";
import { reviewRunVerdict } from "../gates/review-run-gate.mjs";
import { lintChatComment, lintComment, parseDraft } from "../lib/draft-lint.mjs";

const CEILING_MS = 1_000;
const GROWTH_LIMIT = 8;
const NOISE_MS = 20;
const RUNS = 3;
const SIZE = 200_000;
const cpuMs = (start) => {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
};

const SHAPES = {
  "repeated character": (n) => "a".repeat(n),
  "nested quotes": (n) => `"${'\\"'.repeat(n / 2)}`,
  "spaces between tokens": (n) => `gh${" ".repeat(n)}pr merge`,
  "unterminated heredoc": (n) => `cat <<EOF\n${"x\n".repeat(n / 2)}`,
  "publish prefix without --apply": (n) => "node openproject.mjs set ".repeat(n / 25),
  "publish script without a verb": (n) => "node github-write.mjs ".repeat(n / 22),
  "env assignments": (n) => `env ${"A=1 ".repeat(n / 4)}gh pr merge 1`,
  "dashes": (n) => "-".repeat(n),
  "shell wrapper quotes": (n) => `bash -c '${"'".repeat(n)}`,
  "push flags": (n) => `git push ${"--force-with-lease=".repeat(n / 19)}`,
  "token path fragments": (n) => `'op' + ${"'op' + ".repeat(n / 7)}`,
  "host and verbs": (n) => "-X ".repeat(n / 3),
  "block comment openers": (n) => "/*".repeat(n / 2),
  "line comment slashes": (n) => "/".repeat(n),
  "locators": (n) => "step 1 BR1a ".repeat(n / 12),
  "sentence punctuation": (n) => ". ".repeat(n / 2),
  "draft headers": (n) => "## 1. `a:1`\n".repeat(n / 12),
  "nested substitutions": (n) => "$(".repeat(n / 2),
  "closed nested substitutions": (n) => `${"$(".repeat(n / 4)}${")".repeat(n / 4)}`,
  "many substitutions": (n) => "$(a) ".repeat(n / 5),
};

const TARGETS = {
  "git-gate evaluate (SHELL_WRAPPER, ENV_ASSIGNMENT, HEREDOC, PUBLISH, REWRITING_PUSH, prBody)": (text) => gitGate(text, "/w"),
  "git-gate hiddenPublish (PUBLISH)": (text) => hiddenPublish(text),
  "git-gate splitSegments (HEREDOC, SHELL_WRAPPER)": (text) => splitSegments(text),
  "tracker-token-gate evaluate (TOKEN_FILE, WRITE_VERB)": (text) => trackerToken({ command: text }, "op.example.com"),
  "no-comments-gate checkEdit (comment-scan DIRECTIVE, TEST_PATH)": (text) => checkEdit("Edit", { file_path: "/w/x.mjs", old_string: "", new_string: text }),
  "publish-quote-gate publishes (SCRIPT)": (text) => publishes(text, "/w", () => ""),
  "review-run-gate reviewRunVerdict (MANAGERS, DIR_FLAGS, REVIEW_FOLDER)": (text) => reviewRunVerdict({ tool_name: "Bash", cwd: "/w", tool_input: { command: text } }),
  "draft-lint lintComment (COMMENT_RULES, DEV_WORDS, LOCATOR, PRD_HEADER, FOREIGN_SCRIPT)": (text) => lintComment(text, "en"),
  "draft-lint lintChatComment (DEV_WORDS, LOCATOR)": (text) => lintChatComment(text, "doc", "vi"),
  "draft-lint parseDraft (HEADER, SECTION)": (text) => parseDraft(text),
};

function fastest(run, text) {
  let best = Infinity;
  let thrown = null;
  for (let attempt = 0; attempt < RUNS; attempt += 1) {
    const start = process.cpuUsage();
    try {
      run(text);
    } catch (error) {
      if (error instanceof RangeError) thrown = error;
    }
    best = Math.min(best, cpuMs(start));
  }
  return { ms: best, thrown };
}

function growthProblem(label, quarter, full) {
  if (full > CEILING_MS) return `${label}: ${full.toFixed(0)} ms at ${SIZE} characters, above ${CEILING_MS} ms`;
  const growth = full / Math.max(quarter, NOISE_MS / 4);
  if (full > NOISE_MS && growth > GROWTH_LIMIT) return `${label}: grows ${growth.toFixed(1)}x from ${SIZE / 4} to ${SIZE} characters (${quarter.toFixed(0)} ms to ${full.toFixed(0)} ms), above ${GROWTH_LIMIT}x`;
  return null;
}

const slow = [];
for (const [target, run] of Object.entries(TARGETS)) {
  for (const [shape, make] of Object.entries(SHAPES)) {
    const quarter = fastest(run, make(SIZE / 4));
    const full = fastest(run, make(SIZE));
    const thrown = full.thrown ?? quarter.thrown;
    if (thrown) slow.push(`${target} / ${shape}: threw ${thrown.message}`);
    const problem = growthProblem(`${target} / ${shape}`, quarter.ms, full.ms);
    if (problem) slow.push(problem);
  }
}
process.stdout.write(JSON.stringify(slow));
