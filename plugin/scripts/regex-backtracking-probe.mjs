import "./test-isolation.mjs";
import { performance } from "node:perf_hooks";
import { evaluate as gitGate, hiddenPublish, splitSegments } from "./git-gate.mjs";
import { evaluate as trackerToken } from "./tracker-token-gate.mjs";
import { classifyAction } from "./role-gate.mjs";
import { checkEdit } from "./no-comments-gate.mjs";
import { publishes } from "./publish-quote-gate.mjs";
import { lintChatComment, lintComment, parseDraft } from "./draft-lint.mjs";

const LIMIT_MS = 250;
const SIZE = 200_000;

const SHAPES = {
  "repeated character": "a".repeat(SIZE),
  "nested quotes": `"${'\\"'.repeat(SIZE / 2)}`,
  "spaces between tokens": `gh${" ".repeat(SIZE)}pr merge`,
  "unterminated heredoc": `cat <<EOF\n${"x\n".repeat(SIZE / 2)}`,
  "publish prefix without --apply": "node openproject.mjs set ".repeat(SIZE / 25),
  "publish script without a verb": "node github-write.mjs ".repeat(SIZE / 22),
  "env assignments": `env ${"A=1 ".repeat(SIZE / 4)}gh pr merge 1`,
  "dashes": "-".repeat(SIZE),
  "shell wrapper quotes": `bash -c '${"'".repeat(SIZE)}`,
  "push flags": `git push ${"--force-with-lease=".repeat(SIZE / 19)}`,
  "token path fragments": `'op' + ${"'op' + ".repeat(SIZE / 7)}`,
  "host and verbs": "-X ".repeat(SIZE / 3),
  "block comment openers": "/*".repeat(SIZE / 2),
  "line comment slashes": "/".repeat(SIZE),
  "locators": "step 1 BR1a ".repeat(SIZE / 12),
  "sentence punctuation": ". ".repeat(SIZE / 2),
  "draft headers": "## 1. `a:1`\n".repeat(SIZE / 12),
  "nested substitutions": "$(".repeat(SIZE / 2),
  "closed nested substitutions": `${"$(".repeat(SIZE / 4)}${")".repeat(SIZE / 4)}`,
  "many substitutions": "$(a) ".repeat(SIZE / 5),
};

const TARGETS = {
  "git-gate evaluate (SHELL_WRAPPER, ENV_ASSIGNMENT, HEREDOC, PUBLISH, REWRITING_PUSH, prBody)": (text) => gitGate(text, "/w"),
  "git-gate hiddenPublish (PUBLISH)": (text) => hiddenPublish(text),
  "git-gate splitSegments (HEREDOC, SHELL_WRAPPER)": (text) => splitSegments(text),
  "tracker-token-gate evaluate (TOKEN_FILE, WRITE_VERB)": (text) => trackerToken({ command: text }, "op.example.com"),
  "role-gate classifyAction (SCRIPT_WRITES)": (text) => classifyAction({ tool_name: "Bash", tool_input: { command: text }, cwd: "/w" }, { sessions: [{ name: "a", role: "dev" }] }),
  "no-comments-gate checkEdit (comment-scan DIRECTIVE, TEST_PATH)": (text) => checkEdit("Edit", { file_path: "/w/x.mjs", old_string: "", new_string: text }),
  "publish-quote-gate publishes (SCRIPT)": (text) => publishes(text, "/w", () => ""),
  "draft-lint lintComment (COMMENT_RULES, DEV_WORDS, LOCATOR, PRD_HEADER, FOREIGN_SCRIPT)": (text) => lintComment(text, "en"),
  "draft-lint lintChatComment (DEV_WORDS, LOCATOR)": (text) => lintChatComment(text, "doc", "vi"),
  "draft-lint parseDraft (HEADER, SECTION)": (text) => parseDraft(text),
};

const slow = [];
for (const [target, run] of Object.entries(TARGETS)) {
  for (const [shape, text] of Object.entries(SHAPES)) {
    const start = performance.now();
    try {
      run(text);
    } catch (error) {
      if (error instanceof RangeError) slow.push(`${target} / ${shape}: threw ${error.message}`);
    }
    const elapsed = performance.now() - start;
    if (elapsed > LIMIT_MS) slow.push(`${target} / ${shape}: ${elapsed.toFixed(0)} ms`);
  }
}
process.stdout.write(JSON.stringify(slow));
