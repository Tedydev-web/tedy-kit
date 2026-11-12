import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { parseDraft, snapshotPath } from "./draft-lint.mjs";
import { apiPullHead, changedPaths, fetchCommit, runGit } from "./source-pin-git.mjs";
import { carrySources, pinnedSources } from "./source-pins.mjs";

const HEAD_LINE = /^(# PR #\d+(?::| —) comment line by line \(head )([0-9a-f]{7,40})(\)\s*)$/m;

const withHead = (text, head) => text.replace(HEAD_LINE, (line, before, old, after) => `${before}${head.slice(0, old.length)}${after}`);

export function carryDraft(file, repo, { git = runGit, headOf = apiPullHead } = {}) {
  const text = readFileSync(file, "utf8");
  const draft = parseDraft(text);
  const relint = `draft-lint.mjs pr-comment ${file} --repo ${repo}`;
  const { sources, refusal } = pinnedSources(file, relint);
  if (refusal) return { code: 1, line: refusal };
  const pulls = sources.filter((pin) => pin.kind === "git" && pin.pr !== undefined);
  const pin = pulls.find((candidate) => candidate.pr === draft.pr && candidate.github?.toLowerCase() === repo.toLowerCase());
  if (!pin) return { code: 1, line: `refused: carry: ${file} was linted for ${pulls.map((candidate) => `${candidate.github}#${candidate.pr}`).join(", ") || "no PR"}, not ${repo}#${draft.pr}; run ${relint} from the checkout of ${repo}` };
  const target = `${repo}#${draft.pr}`;
  const head = headOf(pin.github, draft.pr);
  if (!head) return { code: 1, line: `refused: carry: GitHub reports no head for ${target}` };
  if (head === pin.sha && head.startsWith(draft.sha)) return { code: 1, line: `refused: carry: ${target} is still at ${head.slice(0, 8)}, the head the draft names; nothing to carry` };
  fetchCommit(git, pin.dir, pin.remote, head);
  const from = git(pin.dir, ["rev-parse", "--verify", `${draft.sha}^{commit}`]);
  const commented = [...new Set(draft.comments.map((comment) => comment.path))];
  const changed = changedPaths(git, pin.dir, from, head);
  const touched = commented.filter((path) => changed.includes(path));
  if (touched.length) return { code: 1, line: `refused: carry: ${target} moved from ${from.slice(0, 8)} to ${head.slice(0, 8)} and the new commits change commented files: ${touched.join(", ")}; review them and redraft` };
  const { atimeMs, mtimeMs } = statSync(file);
  const carried = withHead(text, head);
  writeFileSync(file, carried);
  utimesSync(file, atimeMs / 1000, mtimeMs / 1000);
  const frozen = snapshotPath(file);
  if (existsSync(frozen)) writeFileSync(frozen, withHead(readFileSync(frozen, "utf8"), head));
  carrySources(file, carried, pin, head);
  git(pin.dir, ["update-ref", pin.local, head]);
  return { code: 0, line: `carried: ${file} from ${from.slice(0, 8)} to ${head.slice(0, 8)}; the new commits change no commented file (${commented.join(", ")})` };
}
