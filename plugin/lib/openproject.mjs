import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./hook-io.mjs";
import { addSlugs, buildPayload, foreignActivity, forgetSlugs, loadConfig, loadRefs, mergePayload, planWrites, readSidecar, recordLastApply, setPayload, sidecarPath, workPackageFilters, workPackageLine, writeSidecar } from "./openproject-client.mjs";
import { client as figmaClient, figmaPin, recheckFigma } from "./figma-comments.mjs";
import { gdocPin, recheckGdoc, session } from "./gdoc-comments.mjs";
import { closedStatuses, closestWorkPackage, listWorkPackages } from "./openproject-dedup.mjs";
import { deleteRelation, setRelation } from "./openproject-relation.mjs";
import { resolveMap } from "./project-map.mjs";
import { consumeApproval, requireExplicitTarget } from "./publish-approval-ticket.mjs";
import { approvalLines, renderRollbackItem, renderWorkPackageDraft } from "./publish-approval-render.mjs";
import { snapshotOnce, snapshotPath } from "./draft-lint.mjs";
import { appendEditLog, frozenOriginal, labelText } from "./edit-log.mjs";
import { chatLanguage } from "./labels.mjs";
import { describePin, linkedDocs, pinnedSources, writeSources } from "./source-pins.mjs";
import { countWords, lintDrafts, lintWorkPackage, readiness, readinessLine } from "./task-lint.mjs";

function projectOf(flags) {
  const project = flags.project ?? resolveMap(process.cwd())?.map.tracker?.project;
  if (!project) throw new Error("no --project and no tracker.project in the project map");
  return project;
}

const today = () => new Date().toLocaleDateString("en-CA");
const similarNote = (similar) => ` | similar ${similar.band} #${similar.id} ${similar.score.toFixed(2)} [${similar.status}] "${similar.subject}"${similar.closed ? " closed: never merge, create new with relates" : ""}`;

const resolveParent = (draft, mapping, created) => (typeof draft.parent === "string" ? mapping[draft.parent] ?? created[draft.parent] : draft.parent);

async function check(client, project, drafts) {
  const mapping = JSON.parse(readSidecar(sidecarPath(client.host, project)));
  const plan = planWrites(drafts, mapping);
  const refs = await loadRefs(client, project, drafts);
  const closed = plan.some((step) => step.action !== "update") ? await closedStatuses(client) : new Set();
  const existing = plan.some((step) => step.action === "create") ? await listWorkPackages(client, project, closed) : [];
  let failed = false;
  const locks = {};
  for (const [index, draft] of drafts.entries()) {
    const step = plan[index];
    const findings = lintWorkPackage(draft);
    const blocks = findings.filter((finding) => finding.severity === "BLOCK");
    const warns = findings.filter((finding) => finding.severity === "WARN").map((finding) => finding.rule);
    const similar = step.action === "create" ? closestWorkPackage(draft, existing) : null;
    let form = "form skipped: parent not created yet";
    let mergeNote = "";
    const parent = resolveParent(draft, mapping, {});
    if (step.action === "merge") {
      const current = await client.request(`/api/v3/work_packages/${step.id}`);
      locks[draft.slug] = current.lockVersion;
      const payload = mergePayload(current, draft, today());
      const added = payload.description ? payload.description.raw.slice((current.description?.raw ?? "").trimEnd().length).split("\n").filter((line) => line.startsWith("- [ ]")).length : 0;
      mergeNote = ` | +${added} checklist line(s), estimate ${payload.estimatedTime ? "set" : "kept"}`;
      const refusal = closed.has(current._links.status.title) ? `refused: #${step.id} is ${current._links.status.title}; create a new work package with relates instead` : draft.status ? "refused: a merge keeps the work package's status; drop status from the draft" : null;
      if (refusal) {
        form = refusal;
        failed = true;
      } else {
        const result = await client.request(`/api/v3/work_packages/${step.id}/form`, { method: "POST", body: payload });
        const errors = Object.values(result?._embedded?.validationErrors ?? {}).map((error) => error.message);
        form = errors.length ? `form errors: ${errors.join("; ")}` : "form ok";
        failed ||= errors.length > 0;
      }
    } else if (!(typeof draft.parent === "string" && !parent)) {
      const target = step.action === "create" ? `/api/v3/projects/${project}/work_packages/form` : `/api/v3/work_packages/${step.id}/form`;
      const lockVersion = step.action === "update" ? (await client.request(`/api/v3/work_packages/${step.id}`)).lockVersion : undefined;
      if (lockVersion !== undefined) locks[draft.slug] = lockVersion;
      const result = await client.request(target, { method: "POST", body: buildPayload({ ...draft, parent }, refs, lockVersion) });
      const errors = Object.values(result?._embedded?.validationErrors ?? {}).map((error) => error.message);
      form = errors.length ? `form errors: ${errors.join("; ")}` : "form ok";
      failed ||= errors.length > 0;
    }
    failed ||= blocks.length > 0;
    const lint = blocks.length ? `lint ${blocks.map((finding) => finding.rule).join(", ")}` : `lint clean (${countWords(draft.description ?? "")} words)`;
    const notes = `${mergeNote}${warns.length ? ` | warn ${warns.join(", ")}` : ""}${similar ? similarNote(similar) : ""}`;
    console.log(`${step.action}${step.id ? ` #${step.id}` : ""} ${draft.slug} | ${lint} | ${form}${notes}`);
  }
  for (const finding of lintDrafts(drafts, { glossary: resolveMap(process.cwd())?.map.glossary ?? {} })) console.log(`warn ${finding.slug}: ${finding.rule}: ${finding.message}`);
  console.log(readinessLine(readiness(drafts, { updating: new Set(drafts.filter((_, index) => plan[index].action === "update").map((draft) => draft.slug)) }), chatLanguage()));
  const count = (action) => plan.filter((step) => step.action === action).length;
  console.log(`WRITE → ${client.host} · project ${project} : ${count("create")} create · ${count("update")} update · ${count("merge")} merge`);
  return { failed, plan, refs, mapping, locks };
}

const locksPath = (file) => `${snapshotPath(file)}.locks.json`;

async function pinLinks(file) {
  const text = readFileSync(file, "utf8");
  const { figma, docs } = linkedDocs(text);
  const pins = [];
  for (const { file: key, nodes } of figma) pins.push({ ...(await figmaPin(figmaClient({ file: key }))), nodes });
  for (const doc of docs) pins.push(await gdocPin(await session({ doc })));
  writeSources(file, pins, text);
  for (const pin of pins) console.log(describePin(pin));
}

async function linksRefused(file) {
  const { sources, refusal } = pinnedSources(file, `openproject.mjs preview ${file}`);
  if (refusal) {
    console.log(refusal);
    return true;
  }
  for (const pin of sources) {
    const verdict = pin.kind === "figma" ? await recheckFigma(figmaClient({ file: pin.file }), pin, pin.nodes ?? []) : await recheckGdoc(await session({ doc: pin.doc }), pin);
    if (verdict.notice) console.log(verdict.notice);
    if (verdict.refusal) {
      console.log(verdict.refusal);
      return true;
    }
  }
  return false;
}

async function apply(client, project, drafts, file) {
  const { failed, plan, refs, mapping, locks } = await check(client, project, drafts);
  if (failed) {
    console.log("refused: fix the lint and form findings above, then preview again");
    return 1;
  }
  if (!existsSync(locksPath(file))) {
    console.log("refused: run preview on this drafts file first");
    return 1;
  }
  const previewed = JSON.parse(readFileSync(locksPath(file), "utf8"));
  const moved = Object.entries(locks).filter(([slug, version]) => previewed[slug] !== version);
  if (moved.length) {
    for (const [slug] of moved) console.log(`refused: ${slug} changed in OpenProject since the preview; read its activity, then preview again`);
    return 1;
  }
  if (await linksRefused(file)) return 1;
  consumeApproval(process.argv, drafts.map((draft, index) => renderWorkPackageDraft(draft, plan[index])));
  const path = sidecarPath(client.host, project);
  const created = {};
  const expected = {};
  const relationFailures = [];
  const appliedAt = new Date().toLocaleString("sv-SE").replace(" ", "T");
  writeSidecar(path, recordLastApply(readSidecar(path), appliedAt, []));
  const statuses = drafts.some((draft) => draft.status) ? (await client.request("/api/v3/statuses"))._embedded.elements : [];
  for (const [index, draft] of drafts.entries()) {
    const step = plan[index];
    const parent = resolveParent(draft, mapping, created);
    let saved;
    if (step.action === "create") {
      saved = await client.request(`/api/v3/projects/${project}/work_packages`, { method: "POST", body: buildPayload({ ...draft, parent }, refs) });
      created[draft.slug] = saved.id;
      writeSidecar(path, recordLastApply(addSlugs(readSidecar(path), { [draft.slug]: saved.id }), appliedAt, Object.values(created)));
    } else if (step.action === "merge") {
      const current = await client.request(`/api/v3/work_packages/${step.id}`);
      const payload = mergePayload(current, draft, today());
      saved = Object.keys(payload).length > 1 ? await client.request(`/api/v3/work_packages/${step.id}`, { method: "PATCH", body: payload }) : current;
      expected[draft.slug] = { subject: current.subject, description: payload.description?.raw ?? current.description?.raw ?? "" };
      writeSidecar(path, addSlugs(readSidecar(path), { [draft.slug]: step.id }));
    } else {
      const current = await client.request(`/api/v3/work_packages/${step.id}`);
      saved = await client.request(`/api/v3/work_packages/${step.id}`, { method: "PATCH", body: buildPayload({ ...draft, parent }, refs, current.lockVersion) });
      if (step.adopt) writeSidecar(path, addSlugs(readSidecar(path), { [draft.slug]: step.id }));
    }
    for (const [type, targets] of [["relates", draft.relates ?? []], ["blocks", draft.blocks ?? []]]) {
      for (const target of targets) {
        await client.request(`/api/v3/work_packages/${saved.id}/relations`, { method: "POST", body: { type, _links: { from: { href: `/api/v3/work_packages/${saved.id}` }, to: { href: `/api/v3/work_packages/${mapping[target] ?? created[target] ?? target}` } } } }).catch((error) => relationFailures.push(`${draft.slug} ${type} ${target}: ${error.message}`));
      }
    }
    if (draft.status) {
      const status = statuses.find((candidate) => candidate.name.toLowerCase() === draft.status.toLowerCase());
      if (!status) throw new Error(`status "${draft.status}" does not exist`);
      const current = await client.request(`/api/v3/work_packages/${saved.id}`);
      await client.request(`/api/v3/work_packages/${saved.id}`, { method: "PATCH", body: { lockVersion: current.lockVersion, _links: { status: { href: status._links.self.href } } } });
    }
  }
  let verified = 0;
  for (const [index, draft] of drafts.entries()) {
    const id = plan[index].id ?? created[draft.slug];
    const read = await client.request(`/api/v3/work_packages/${id}`);
    const want = expected[draft.slug] ?? { subject: draft.subject, description: draft.description };
    const same = read.subject === want.subject && (read.description?.raw ?? "").trim() === want.description.trim();
    verified += same ? 1 : 0;
    console.log(`#${id} ${same ? "matches" : "DIFFERS"} ${read.subject}`);
  }
  for (const failure of relationFailures) console.log(`relation failed: ${failure}`);
  console.log(`verified ${verified}/${drafts.length}${relationFailures.length ? `; ${relationFailures.length} relation(s) failed` : ""}`);
  return verified === drafts.length && !relationFailures.length ? 0 : 1;
}

const describe = (workPackage) => `#${workPackage.id} "${workPackage.subject}" [${workPackage._links.status.title}]`;

async function quickSet(client, id, flags) {
  const current = await client.request(`/api/v3/work_packages/${id}`);
  const project = current._links.project.href.split("/").pop();
  const refs = {
    statuses: flags.status ? (await client.request("/api/v3/statuses"))._embedded.elements : [],
    priorities: flags.priority ? (await client.request("/api/v3/priorities"))._embedded.elements : [],
    assignees: flags.assignee ? (await loadRefs(client, project)).assignees : [],
  };
  const payload = setPayload(current.lockVersion, { status: flags.status, assignee: flags.assignee, priority: flags.priority, estimate: flags.estimate === undefined ? undefined : Number(flags.estimate), start: flags.start, due: flags.due }, refs);
  const before = { status: current._links.status?.title, assignee: current._links.assignee?.title ?? "none", priority: current._links.priority?.title, estimate: current.estimatedTime ?? "none", start: current.startDate ?? "none", due: current.dueDate ?? "none" };
  const changes = ["status", "assignee", "priority", "estimate", "start", "due"].filter((field) => flags[field] !== undefined).map((field) => `${field} ${before[field]} → ${flags[field]}`);
  const form = await client.request(`/api/v3/work_packages/${id}/form`, { method: "POST", body: payload });
  const errors = Object.values(form?._embedded?.validationErrors ?? {}).map((error) => error.message);
  console.log(`${describe(current)} | ${changes.join(", ")} | ${errors.length ? `form errors: ${errors.join("; ")}` : "form ok"} | lock ${current.lockVersion}`);
  if (errors.length) return 1;
  if (flags.apply === undefined) {
    console.log(`WRITE → ${client.host} · #${id} : 1 update; run again with --apply --lock ${current.lockVersion}`);
    return 0;
  }
  if (Number(flags.lock) !== current.lockVersion) {
    console.log(`refused: #${id} is at lock ${current.lockVersion}, not the previewed ${flags.lock}; read its activity, then preview again`);
    return 1;
  }
  consumeApproval(process.argv, []);
  await client.request(`/api/v3/work_packages/${id}`, { method: "PATCH", body: payload });
  const read = await client.request(`/api/v3/work_packages/${id}`);
  console.log(`set ${describe(read)} assignee ${read._links.assignee?.title ?? "none"} priority ${read._links.priority?.title} estimate ${read.estimatedTime ?? "none"} dates ${read.startDate ?? "none"}..${read.dueDate ?? "none"}`);
  return 0;
}

export const prBodyFrom = (wp) => [`OP#${wp.id}`, "", `Task read at ${wp.updatedAt}`, "", `## ${wp.subject}`, "", (wp.description?.raw ?? "").trim()].join("\n").trim() + "\n";

const prBodyRecord = (body) => join(STATE_DIR, "pr-bodies", createHash("sha256").update(body.trim()).digest("hex"));

export function recordPrBody(body) {
  const path = prBodyRecord(body);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.match(/^OP#(\d+)/)[1]);
}

export const generatedPrBodyOp = (body) => {
  const path = prBodyRecord(body);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
};

export const sameComment = (activities, body) => activities.find((activity) => (activity.comment?.raw ?? "").trim() === body.trim()) ?? null;

async function comment(client, id, flags) {
  if (typeof flags["body-file"] !== "string") throw new Error("comment needs --body-file <file>");
  const body = readFileSync(flags["body-file"], "utf8").trim();
  if (!body) throw new Error("comment body is empty");
  const current = await client.request(`/api/v3/work_packages/${id}`);
  const activities = (await client.request(`/api/v3/work_packages/${id}/activities`))._embedded.elements;
  const twin = sameComment(activities, body);
  if (twin) {
    console.log(`refused: #${id} already has this comment as activity ${twin.id}`);
    return 1;
  }
  console.log(`${describe(current)} | comment of ${body.length} characters`);
  if (flags.apply === undefined) {
    console.log(`WRITE → ${client.host} · #${id} : 1 comment; run again with --apply`);
    return 0;
  }
  consumeApproval(process.argv, [body]);
  await client.request(`/api/v3/work_packages/${id}/activities`, { method: "POST", body: { comment: { raw: body } } });
  const read = sameComment((await client.request(`/api/v3/work_packages/${id}/activities`))._embedded.elements, body);
  console.log(read ? `commented #${id} activity ${read.id}` : `posted but not found on read-back; open #${id} and check`);
  return read ? 0 : 1;
}

async function commentEdit(client, id, flags) {
  if (typeof flags["body-file"] !== "string") throw new Error("comment-edit needs --body-file <file>");
  const body = readFileSync(flags["body-file"], "utf8").trim();
  if (!body) throw new Error("comment body is empty");
  const activity = await client.request(`/api/v3/activities/${id}`);
  const refusal = foreignActivity(activity, await client.request("/api/v3/users/me"));
  if (refusal) {
    console.log(refusal);
    return 1;
  }
  const old = (activity.comment?.raw ?? "").trim();
  if (!old) {
    console.log(`refused: activity ${id} has no comment to edit; post a new one with comment <work package id>`);
    return 1;
  }
  if (old === body) {
    console.log(`refused: activity ${id} already says this`);
    return 1;
  }
  const wpPath = activity._links.workPackage.href;
  const current = await client.request(wpPath);
  const twin = sameComment((await client.request(`${wpPath}/activities`))._embedded.elements.filter((other) => other.id !== activity.id), body);
  if (twin) {
    console.log(`refused: #${current.id} already has this comment as activity ${twin.id}`);
    return 1;
  }
  console.log(`${describe(current)} | activity ${id} | comment of ${old.length} → ${body.length} characters`);
  if (flags.apply === undefined) {
    console.log(`WRITE → ${client.host} · #${current.id} : 1 comment edit; run again with --apply`);
    return 0;
  }
  consumeApproval(process.argv, [body]);
  await client.request(`/api/v3/activities/${id}`, { method: "PATCH", body: { comment: { raw: body } } });
  const read = (await client.request(`/api/v3/activities/${id}`)).comment?.raw?.trim() === body;
  console.log(read ? `edited #${current.id} activity ${id}` : `sent but the read-back differs; open #${current.id} and check activity ${id}`);
  return read ? 0 : 1;
}

export const getPaths = (target, flags) => {
  if (!/^\d+$/.test(target)) {
    if (!target.startsWith("/")) throw new Error(`get takes a work package id or an API path starting with /, not "${target}"`);
    return [target];
  }
  const base = `/api/v3/work_packages/${target}`;
  const parts = ["relations", "activities"].filter((part) => flags[part] !== undefined);
  return parts.length ? parts.map((part) => `${base}/${part}`) : [base];
};

async function list(client, flags) {
  const project = projectOf(flags);
  const refs = {
    statuses: flags.status !== undefined && String(flags.status).toLowerCase() !== "open" ? (await client.request("/api/v3/statuses"))._embedded.elements : [],
    ...(flags.assignee !== undefined || flags.type !== undefined ? await loadRefs(client, project) : { types: {}, assignees: [] }),
  };
  const filters = encodeURIComponent(JSON.stringify(workPackageFilters({ parent: flags.parent, assignee: flags.assignee, status: flags.status, type: flags.type }, refs)));
  const sort = encodeURIComponent(JSON.stringify([["id", "asc"]]));
  let shown = 0;
  for (let offset = 1; ; offset += 1) {
    const page = await client.request(`/api/v3/projects/${project}/work_packages?pageSize=100&offset=${offset}&filters=${filters}&sortBy=${sort}`);
    const elements = page._embedded.elements;
    for (const wp of elements) console.log(workPackageLine(wp));
    shown += elements.length;
    if (!elements.length || shown >= page.total) {
      console.log(`${shown} work package(s) in project ${project}`);
      return 0;
    }
  }
}

async function rollback(client, project, flags) {
  const path = sidecarPath(client.host, project);
  const last = JSON.parse(readSidecar(path))._last_apply;
  if (!last?.created?.length) {
    console.log("nothing to roll back: the last apply created no work package");
    return 0;
  }
  const action = flags.delete === undefined ? "close" : "delete";
  const items = [];
  for (const id of last.created) items.push(await client.request(`/api/v3/work_packages/${id}`));
  const touched = items.filter((item) => new Date(item.updatedAt).getTime() > new Date(last.at).getTime() + 60_000);
  console.log(`rollback of the apply at ${last.at}: ${action} ${items.length} work package(s) it created; nothing else is touched`);
  for (const item of items) console.log(`  ${describe(item)} updated ${item.updatedAt}${touched.includes(item) ? " changed after the apply" : ""}`);
  if (action === "delete" && touched.length) {
    console.log(`refused: ${touched.map((item) => `#${item.id}`).join(", ")} changed after the apply; close instead, or delete by hand after reading its activity`);
    return 1;
  }
  if (flags.apply === undefined) {
    console.log(approvalLines(items.map(renderRollbackItem)));
    console.log(`WRITE → ${client.host} · project ${project} : ${items.length} ${action}; run again with --apply${action === "delete" ? " --delete" : ""}`);
    return 0;
  }
  const statuses = (await client.request("/api/v3/statuses"))._embedded.elements.filter((status) => status.isClosed);
  const closedStatus = statuses.find((status) => status.name.toLowerCase() === "closed") ?? statuses[0];
  if (action === "close" && !closedStatus) throw new Error("this instance has no closed status");
  consumeApproval(process.argv, items.map(renderRollbackItem));
  const done = [];
  const failed = [];
  for (const item of items.toReversed()) {
    try {
      if (action === "delete") await client.request(`/api/v3/work_packages/${item.id}`, { method: "DELETE" });
      else await client.request(`/api/v3/work_packages/${item.id}`, { method: "PATCH", body: { lockVersion: item.lockVersion, _links: { status: { href: closedStatus._links.self.href } } } });
      done.push(item.id);
    } catch (error) {
      console.log(`  ! #${item.id} ${action} failed: ${error.message}`);
      failed.push(item.id);
    }
  }
  writeSidecar(path, forgetSlugs(readSidecar(path), action === "delete" ? done : [], failed));
  console.log(`${action} ${done.length}/${items.length}${failed.length ? "; the failed ones stay recorded, run rollback again to retry them" : ""}`);
  return failed.length ? 1 : 0;
}

async function main([command, target, ...rest]) {
  const args = command === "rollback" || command === "list" ? [target, ...rest].filter((arg) => arg !== undefined) : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1] === undefined || args[index + 1].startsWith("--") ? true : args[index + 1]]] : [])));
  if (command === "apply" || (command === "rollback" && flags.apply !== undefined)) requireExplicitTarget("project", flags.project);
  const client = loadConfig();
  if (command === "get" && target) {
    for (const path of getPaths(target, flags)) console.log(JSON.stringify(await client.request(path), null, 1));
    return 0;
  }
  if (command === "list") return list(client, flags);
  if (command === "set" && /^\d+$/.test(target ?? "")) return quickSet(client, Number(target), flags);
  if (command === "comment" && /^\d+$/.test(target ?? "")) return comment(client, Number(target), flags);
  if (command === "comment-edit" && /^\d+$/.test(target ?? "")) return commentEdit(client, Number(target), flags);
  if (command === "relation" && /^\d+$/.test(target ?? "") && /^\d+$/.test(rest[0] ?? "")) return setRelation(client, Number(target), Number(rest[0]), flags);
  if (command === "relation-delete" && /^\d+$/.test(target ?? "")) return deleteRelation(client, Number(target), flags);
  if (command === "pr-body" && /^\d+$/.test(target ?? "")) {
    const body = prBodyFrom(await client.request(`/api/v3/work_packages/${target}`));
    recordPrBody(body);
    process.stdout.write(body);
    return 0;
  }
  if (command === "rollback") return rollback(client, projectOf(flags), flags);
  if ((command === "preview" || command === "apply") && target) {
    const drafts = JSON.parse(readFileSync(target, "utf8"));
    const project = projectOf(flags);
    if (command === "preview") {
      const { failed, locks, plan } = await check(client, project, drafts);
      if (!failed && snapshotOnce(target, readFileSync(target, "utf8"))) console.log("original drafts frozen for the edit log");
      if (!failed) writeFileSync(locksPath(target), JSON.stringify(locks));
      if (!failed) await pinLinks(target);
      if (!failed) console.log(approvalLines(drafts.map((draft, index) => renderWorkPackageDraft(draft, plan[index]))));
      return failed ? 1 : 0;
    }
    const original = frozenOriginal(target);
    const originals = original ? Object.fromEntries(JSON.parse(original).map((draft) => [draft.slug, draft])) : {};
    const code = await apply(client, project, drafts, target);
    if (code !== 0) return code;
    const text = (item) => `${item.subject}\n${item.description}`;
    const kept = new Set(drafts.map((draft) => draft.slug));
    appendEditLog([
      ...drafts.map((draft) => {
        const before = originals[draft.slug];
        return { channel: "tracker-task", key: draft.slug, label: before ? labelText(text(before), text(draft)) : original ? "added" : "no-original", draft: before ? text(before) : null, posted: text(draft) };
      }),
      ...Object.values(originals).filter((draft) => !kept.has(draft.slug)).map((draft) => ({ channel: "tracker-task", key: draft.slug, label: "cut", draft: text(draft), posted: null })),
    ]);
    return code;
  }
  console.error("usage: openproject.mjs get <id> [--relations] [--activities] | get <api path> | list [--parent <id>] [--assignee <name>] [--status open|<name>] [--type <name>] [--project <id>] | preview <drafts.json> [--project <id>] | apply <drafts.json> [--project <id>] | set <id> [--status <name>] [--assignee <name>] [--priority <name>] [--estimate <hours>] [--start <YYYY-MM-DD>] [--due <YYYY-MM-DD>] [--apply --lock <n>] | comment <id> --body-file <file> [--apply] | comment-edit <activity-id> --body-file <file> [--apply] | relation <from-id> <to-id> --type <relates|blocks|precedes|follows|…> [--apply] | relation-delete <relation-id> [--apply] | pr-body <id> | rollback [--project <id>] [--delete] [--apply]");
  return 2;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`openproject: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
