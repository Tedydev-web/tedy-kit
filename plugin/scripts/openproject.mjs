import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { addSlugs, buildPayload, forgetSlugs, loadConfig, loadRefs, mergePayload, planWrites, readSidecar, recordLastApply, setPayload, sidecarPath, writeSidecar } from "./openproject-client.mjs";
import { closedStatuses, closestWorkPackage, listWorkPackages } from "./openproject-dedup.mjs";
import { resolveMap } from "./project-map.mjs";
import { snapshotOnce, snapshotPath } from "./draft-lint.mjs";
import { appendEditLog, frozenOriginal, labelText } from "./edit-log.mjs";
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
  console.log(readinessLine(readiness(drafts, { updating: new Set(drafts.filter((_, index) => plan[index].action === "update").map((draft) => draft.slug)) })));
  const count = (action) => plan.filter((step) => step.action === action).length;
  console.log(`WRITE → ${client.host} · project ${project} : ${count("create")} create · ${count("update")} update · ${count("merge")} merge`);
  return { failed, plan, refs, mapping, locks };
}

const locksPath = (file) => `${snapshotPath(file)}.locks.json`;

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
  const payload = setPayload(current.lockVersion, { status: flags.status, assignee: flags.assignee, priority: flags.priority, estimate: flags.estimate === undefined ? undefined : Number(flags.estimate) }, refs);
  const before = { status: current._links.status?.title, assignee: current._links.assignee?.title ?? "none", priority: current._links.priority?.title, estimate: current.estimatedTime ?? "none" };
  const changes = ["status", "assignee", "priority", "estimate"].filter((field) => flags[field] !== undefined).map((field) => `${field} ${before[field]} → ${flags[field]}`);
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
  await client.request(`/api/v3/work_packages/${id}`, { method: "PATCH", body: payload });
  const read = await client.request(`/api/v3/work_packages/${id}`);
  console.log(`set ${describe(read)} assignee ${read._links.assignee?.title ?? "none"} priority ${read._links.priority?.title} estimate ${read.estimatedTime ?? "none"}`);
  return 0;
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
    console.log(`WRITE → ${client.host} · project ${project} : ${items.length} ${action}; run again with --apply${action === "delete" ? " --delete" : ""}`);
    return 0;
  }
  const statuses = (await client.request("/api/v3/statuses"))._embedded.elements.filter((status) => status.isClosed);
  const closedStatus = statuses.find((status) => status.name.toLowerCase() === "closed") ?? statuses[0];
  if (action === "close" && !closedStatus) throw new Error("this instance has no closed status");
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
  const args = command === "rollback" ? [target, ...rest].filter((arg) => arg !== undefined) : rest;
  const flags = Object.fromEntries(args.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), args[index + 1] === undefined || args[index + 1].startsWith("--") ? true : args[index + 1]]] : [])));
  const client = loadConfig();
  if (command === "get" && target) {
    console.log(JSON.stringify(await client.request(target), null, 1));
    return 0;
  }
  if (command === "set" && /^\d+$/.test(target ?? "")) return quickSet(client, Number(target), flags);
  if (command === "rollback") return rollback(client, projectOf(flags), flags);
  if ((command === "preview" || command === "apply") && target) {
    const drafts = JSON.parse(readFileSync(target, "utf8"));
    const project = projectOf(flags);
    if (command === "preview") {
      const { failed, locks } = await check(client, project, drafts);
      if (!failed && snapshotOnce(target, readFileSync(target, "utf8"))) console.log("original drafts frozen for the edit log");
      if (!failed) writeFileSync(locksPath(target), JSON.stringify(locks));
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
  console.error("usage: openproject.mjs get <api path> | preview <drafts.json> [--project <id>] | apply <drafts.json> [--project <id>] | set <id> [--status <name>] [--assignee <name>] [--priority <name>] [--estimate <hours>] [--apply --lock <n>] | rollback [--project <id>] [--delete] [--apply]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`openproject: ${error.message}`);
      process.exit(1);
    },
  );
}
