import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GITHUB_WRITE_DRY_RUN_VERBS, githubWriteDryRun, parseFlags } from "./cli-flags.mjs";
import { lintComment, lintDraft, mapLanguage, parseDraft, readDiff, snapshotPath } from "./draft-lint.mjs";
import { appendEditLog, labelText } from "./edit-log.mjs";
import { fetchTab, indexTab, quoteInText, UC_ID } from "./prd-section.mjs";
import { generatedPrBodyOp } from "./openproject.mjs";
import { resolveMap } from "./project-map.mjs";
import { consumeApproval, requireExplicitTarget } from "./publish-approval-ticket.mjs";
import { pinnedSources, recheckPinned } from "./source-pins.mjs";

const normalise = (text) => text.replace(/\s+/g, " ").trim();

function keyed(comments) {
  const seen = new Map();
  return comments.map((comment) => {
    const base = `${comment.path}:${comment.line}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return [count > 1 ? `${base}#${count}` : base, comment.body];
  });
}

export function labelEdits(draft, final) {
  const before = new Map(keyed(draft));
  const after = new Map(keyed(final));
  const entries = [];
  for (const [key, drafted] of before) {
    const posted = after.get(key);
    if (posted === undefined) {
      entries.push({ key, label: "cut", draft: drafted, posted: null });
      continue;
    }
    entries.push({ key, label: labelText(drafted, posted), draft: drafted, posted });
  }
  for (const [key, posted] of after) if (!before.has(key)) entries.push({ key, label: "added", draft: null, posted });
  return entries;
}

export const alreadyOnPr = (existing, comments) =>
  comments.flatMap((comment) => {
    const twin = existing.find((candidate) => !candidate.in_reply_to_id && candidate.path === comment.path && normalise(candidate.body) === normalise(comment.body));
    return twin ? [{ comment, id: twin.id }] : [];
  });

export const replyExists = (existing, id, body) => existing.find((candidate) => String(candidate.in_reply_to_id) === String(id) && normalise(candidate.body) === normalise(body))?.id ?? null;

const prComments = (repo, pr) => JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${pr}/comments`])).flat();

export function buildReviewPayload(comments, commitId) {
  return { commit_id: commitId, event: "COMMENT", comments: comments.map(({ path, line, body }) => ({ path, line, side: "RIGHT", body })) };
}

function prdBlocks(lines) {
  const blocks = [];
  for (const line of lines) {
    if (line.startsWith("PRD ")) blocks.push({ header: line, quote: [] });
    else if (line.startsWith("> ") && blocks.length) blocks[blocks.length - 1].quote.push(line.slice(2));
  }
  return blocks;
}

export function verifyComment(comment, { prd, diff, inRepo }) {
  const refusals = [];
  const unverified = [];
  const [first, ...rest] = comment.body.split("\n");
  for (const { header, quote } of prdBlocks(rest)) {
    const epic = header.match(/^PRD EPIC (\d{2}) · /)?.[1];
    const id = header.match(UC_ID)?.[0];
    const text = prd[epic] ?? prd["*"];
    if (!text) {
      refusals.push(`PRD EPIC ${epic} has no source in the project map; add it with /tedy:setup update`);
      continue;
    }
    const known = prd[epic] ? indexTab(text).some((entry) => entry.id === id) : text.includes(id);
    if (!known) refusals.push(`${id} is not a use case in PRD EPIC ${epic}`);
    const quoted = quote.join(" ");
    if (!quoteInText(quoted, text)) refusals.push(`the quote under "${header}" is not verbatim in the PRD: "${quoted.slice(0, 80)}"`);
  }
  for (const [, copy] of first.replace(/`[^`]*`/g, "").matchAll(/"([^"]+)"/g)) {
    if (diff.includes(copy) || inRepo(copy) || Object.values(prd).some((text) => quoteInText(copy, text))) continue;
    const figma = first.match(/figma\.com\/design\/[^\s)]*[?&]node-id=(\d+)-(\d+)/);
    if (figma) unverified.push(`"${copy}" (Figma ${figma[1]}:${figma[2]})`);
    else refusals.push(`"${copy}" is not in the diff, the repository at the pinned head, or the PRD; quote it exactly or cite its Figma node`);
  }
  return { refusals, unverified };
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

function currentRepo(flags) {
  if (!flags["dry-run"]) requireExplicitTarget("repo", flags.repo);
  return flags.repo ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
}

function inRepoAt(head) {
  return (text) => {
    try {
      execFileSync("git", ["grep", "-F", "-q", "-e", text, head, "--"], { stdio: "ignore" });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw new Error(`git grep at ${head.slice(0, 8)} failed; fetch the PR head first (git fetch origin pull/<n>/head)`);
    }
  };
}

async function loadPrd(comments) {
  const map = resolveMap(process.cwd())?.map;
  const prd = {};
  if (!map?.prd) return prd;
  if (map.prd.files?.length) prd["*"] = map.prd.files.map((file) => readFileSync(resolve(map.paths[0], file), "utf8")).join("\n");
  const epics = new Set(comments.flatMap((comment) => [...comment.body.matchAll(/^PRD EPIC (\d{2}) · /gm)].map((match) => match[1])));
  for (const epic of epics) {
    const tab = map.prd.tabs?.[epic]?.tab;
    if (map.prd.doc && tab) prd[epic] = await fetchTab(map.prd.doc, tab);
  }
  return prd;
}

async function recheckSources(file, relint, texts) {
  if (typeof file !== "string") {
    console.log("refused: pass the body as --body-file <file> so draft-lint can pin its sources");
    return null;
  }
  const { refusals, notices, warnings } = await recheckPinned(file, relint, { texts });
  for (const line of refusals) console.log(line);
  return refusals.length ? null : { notices, warnings };
}

const prHead = (repo, pr) => gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]).trim();

function pullTargetRefusal(file, repo, pr, relint, head = prHead(repo, pr)) {
  const pulls = (pinnedSources(file, "").sources ?? []).filter((pin) => pin.kind === "git" && pin.pr !== undefined);
  const pin = pulls.find((candidate) => candidate.pr === Number(pr) && candidate.github?.toLowerCase() === repo.toLowerCase());
  if (!pin) return `refused: ${file} was linted for ${pulls.map((candidate) => `${candidate.github}#${candidate.pr}`).join(", ") || "no PR"}, not ${repo}#${pr}; run ${relint} from the checkout of ${repo}, then ask the user again`;
  if (head !== pin.sha) return `refused: GitHub shows ${repo}#${pr} at ${head.slice(0, 8) || "no head"}, not at the pinned ${pin.sha.slice(0, 8)}, so the PR changed; re-read it, lint again and ask the user again`;
  return null;
}

const say = (lines) => {
  for (const line of lines) console.log(line);
};

function logEdits(entries) {
  appendEditLog(entries.map((entry) => ({ channel: "pr-comment", ...entry })));
}

async function post(file, flags) {
  const finalText = readFileSync(file, "utf8");
  const original = existsSync(snapshotPath(file)) ? readFileSync(snapshotPath(file), "utf8") : finalText;
  const repo = currentRepo(flags);
  const draft = parseDraft(original);
  const final = lintDraft(finalText, readDiff(parseDraft(finalText).pr, repo), mapLanguage("pr_review"));
  if (final.pr !== draft.pr || final.sha !== draft.sha) throw new Error(`the draft now names a different PR or head than the frozen original at ${snapshotPath(file)}`);
  if (final.problems.length) {
    for (const item of final.problems) console.log(`${item.index}. ${item.location}: ${item.problem}`);
    return 1;
  }
  const head = prHead(repo, final.pr);
  if (!head.startsWith(final.sha)) {
    console.log(`refused: PR head moved from ${final.sha} to ${head.slice(0, 8)}; review the new commits and redraft`);
    return 1;
  }
  const sources = { prd: await loadPrd(final.comments), diff: readDiff(final.pr, repo), inRepo: inRepoAt(head) };
  let refused = false;
  for (const comment of final.comments) {
    const { refusals, unverified } = verifyComment(comment, sources);
    for (const reason of refusals) console.log(`refused ${comment.index}. ${comment.path}:${comment.line}: ${reason}`);
    for (const note of unverified) console.log(`unverified ${comment.index}. ${comment.path}:${comment.line}: ${note}`);
    refused ||= refusals.length > 0;
  }
  if (refused) return 1;
  const twins = alreadyOnPr(prComments(repo, final.pr), final.comments);
  for (const twin of twins) console.log(`refused ${twin.comment.index}. ${twin.comment.path}:${twin.comment.line}: already on the PR as comment ${twin.id}; drop it from the draft`);
  if (twins.length) return 1;
  const relint = `draft-lint.mjs pr-comment ${file} --repo ${repo}`;
  const fresh = await recheckSources(file, relint, final.comments.map((comment) => comment.body));
  if (!fresh) return 1;
  const target = pullTargetRefusal(file, repo, final.pr, relint, head);
  if (target) {
    console.log(target);
    return 1;
  }
  const payload = buildReviewPayload(final.comments, head);
  console.log(`WRITE → ${repo}#${final.pr} : 1 review · ${final.comments.length} comments`);
  if (flags["dry-run"]) {
    say(fresh.notices);
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  consumeApproval(process.argv, [finalText, ...fresh.warnings]);
  say(fresh.notices);
  const review = JSON.parse(gh(["api", "-X", "POST", `repos/${repo}/pulls/${final.pr}/reviews`, "--input", "-"], JSON.stringify(payload)));
  const posted = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${final.pr}/reviews/${review.id}/comments`])).flat();
  for (const comment of posted) console.log(`${comment.id} ${comment.path}:${comment.line ?? comment.original_line} ${comment.side ?? "RIGHT"} ${comment.commit_id.slice(0, 8)}`);
  logEdits(labelEdits(draft.comments, final.comments).map((entry) => ({ repo, pr: final.pr, sha: final.sha, review: review.id, ...entry })));
  if (posted.length !== final.comments.length) {
    console.log(`posted ${posted.length} of ${final.comments.length} comments; open the PR and check`);
    return 1;
  }
  console.log(`posted ${posted.length}/${final.comments.length}: ${review.html_url}`);
  return 0;
}

function readBody(flags) {
  const body = (flags["body-file"] ? readFileSync(flags["body-file"], "utf8") : flags.body ?? "").trim();
  const problems = lintComment(body, mapLanguage("pr_review"));
  if (!body || problems.length) throw new Error(`body not posted: ${problems.join("; ") || "empty"}`);
  return body;
}

async function edit(id, flags) {
  const repo = currentRepo(flags);
  const body = readBody(flags);
  const pr = JSON.parse(gh(["api", `repos/${repo}/pulls/comments/${id}`])).pull_request_url?.match(/\/pulls\/(\d+)$/)?.[1];
  if (!pr) {
    console.log(`refused: review comment ${id} in ${repo} names no pull request; nothing edited`);
    return 1;
  }
  const relint = `draft-lint.mjs pr-reply ${flags["body-file"]} --pr ${pr} --repo ${repo}`;
  const fresh = await recheckSources(flags["body-file"], relint, [body]);
  if (!fresh) return 1;
  const refusal = pullTargetRefusal(flags["body-file"], repo, pr, relint);
  if (refusal) {
    console.log(refusal);
    return 1;
  }
  console.log(`WRITE → ${repo} : edit review comment ${id}`);
  consumeApproval(process.argv, [body, ...fresh.warnings]);
  say(fresh.notices);
  const updated = JSON.parse(gh(["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${id}`, "--input", "-"], JSON.stringify({ body })));
  logEdits([{ repo, key: String(id), label: "post-edit", draft: null, posted: body }]);
  if (normalise(updated.body) !== normalise(body)) throw new Error(`comment ${id} body differs after PATCH`);
  console.log(`edited ${id}: ${updated.html_url}`);
  return 0;
}

function minimize(nodeId) {
  console.log(`WRITE → minimize ${nodeId} as OUTDATED`);
  consumeApproval(process.argv, []);
  const query = "mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }";
  const result = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, "-f", `id=${nodeId}`]));
  if (result.data?.minimizeComment?.minimizedComment?.isMinimized !== true) throw new Error(`${nodeId} is not minimized: ${JSON.stringify(result.errors ?? result)}`);
  console.log(`minimized ${nodeId}`);
  return 0;
}

export function threadMutation(resolved) {
  const name = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  return { name, verb: resolved ? "resolve" : "unresolve", query: `mutation($id: ID!) { ${name}(input: {threadId: $id}) { thread { isResolved } } }` };
}

function setThreadsResolved(threadIds, resolved) {
  const { name, verb, query } = threadMutation(resolved);
  consumeApproval(process.argv, []);
  for (const threadId of threadIds) {
    console.log(`WRITE → ${verb} review thread ${threadId}`);
    const result = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`, "-f", `id=${threadId}`]));
    if (result.data?.[name]?.thread?.isResolved !== resolved) throw new Error(`${threadId} is not ${verb}d: ${JSON.stringify(result.errors ?? result)}`);
    console.log(`${verb}d ${threadId}`);
  }
  return 0;
}

async function reply(pr, id, flags) {
  const repo = currentRepo(flags);
  const body = readBody(flags);
  const twin = replyExists(prComments(repo, pr), id, body);
  if (twin) {
    console.log(`refused: reply ${twin} under ${id} already says this; nothing posted`);
    return 1;
  }
  const relint = `draft-lint.mjs pr-reply ${flags["body-file"]} --pr ${pr} --repo ${repo}`;
  const fresh = await recheckSources(flags["body-file"], relint, [body]);
  if (!fresh) return 1;
  const refusal = pullTargetRefusal(flags["body-file"], repo, pr, relint);
  if (refusal) {
    console.log(refusal);
    return 1;
  }
  console.log(`WRITE → ${repo}#${pr} : reply to ${id}`);
  consumeApproval(process.argv, [body, ...fresh.warnings]);
  say(fresh.notices);
  const created = JSON.parse(gh(["api", "-X", "POST", `repos/${repo}/pulls/${pr}/comments/${id}/replies`, "--input", "-"], JSON.stringify({ body })));
  logEdits([{ repo, pr: Number(pr), key: String(id), label: "reply", draft: null, posted: body }]);
  console.log(`replied ${created.id}: ${created.html_url}`);
  return 0;
}

const opOf = (text) => text?.match(/\bOP#(\d+)\b/)?.[1];

export function prBodyRefusal(pr, me, body, generatedFor) {
  const op = opOf(body);
  if (!op) return "the body has no OP#<id>";
  if (pr.author?.login !== me) return `#${pr.number} belongs to ${pr.author?.login}, not ${me}`;
  if (pr.isDraft) return null;
  const current = opOf(pr.body);
  if (current !== op) return `#${pr.number} is ready and points to ${current ? `OP#${current}` : "no work package"}, not OP#${op}; a ready PR keeps its work package`;
  if (generatedFor !== op) return `#${pr.number} is ready; its body is replaced only with the unedited output of openproject.mjs pr-body ${op}`;
  return null;
}

function prBody(number, flags) {
  if (typeof flags["body-file"] !== "string") throw new Error("pr-body needs --body-file <file>");
  const repo = currentRepo(flags);
  const body = readFileSync(flags["body-file"], "utf8").trim();
  const view = () => JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "number,isDraft,author,body"]));
  const pr = view();
  const refusal = prBodyRefusal(pr, gh(["api", "user", "-q", ".login"]).trim(), body, generatedPrBodyOp(body));
  if (refusal) {
    console.log(`refused: ${refusal}`);
    return 1;
  }
  if (pr.body.trim() === body) {
    console.log(`#${number} already has this body; nothing written`);
    return 0;
  }
  console.log(`WRITE → ${repo}#${number} : PR body`);
  if (flags["dry-run"]) return 0;
  consumeApproval(process.argv, [body]);
  gh(["api", "-X", "PATCH", `repos/${repo}/pulls/${number}`, "--input", "-"], JSON.stringify({ body }));
  const same = view().body.trim() === body;
  console.log(same ? `updated #${number} body` : `written, but the read-back differs; open #${number} and check`);
  return same ? 0 : 1;
}

const USAGE = `usage:
  github-write.mjs post <draft.md> [--repo <owner/repo>] [--dry-run]
  github-write.mjs edit <comment-id> --body-file <file> [--repo <owner/repo>]
  github-write.mjs minimize <node-id>
  github-write.mjs resolve <thread-node-id>...
  github-write.mjs unresolve <thread-node-id>...
  github-write.mjs reply <pr> <comment-id> --body-file <file> [--repo <owner/repo>]
  github-write.mjs pr-body <pr> --body-file <file> [--repo <owner/repo>] [--dry-run]`;

async function main([command, ...args]) {
  const { positional, flags } = parseFlags(args);
  if ("dry-run" in flags && !githubWriteDryRun(command, flags)) {
    console.error(`github-write: --dry-run is a bare flag of ${GITHUB_WRITE_DRY_RUN_VERBS.join(" and ")} only; nothing written`);
    return 2;
  }
  if (command === "post" && positional[0]) return post(positional[0], flags);
  if (command === "edit" && positional[0]) return edit(positional[0], flags);
  if (command === "minimize" && positional[0]) return minimize(positional[0]);
  if (command === "resolve" && positional.length) return setThreadsResolved(positional, true);
  if (command === "unresolve" && positional.length) return setThreadsResolved(positional, false);
  if (command === "reply" && positional[1]) return reply(positional[0], positional[1], flags);
  if (command === "pr-body" && positional[0]) return prBody(positional[0], flags);
  console.error(USAGE);
  return 2;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`github-write: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
