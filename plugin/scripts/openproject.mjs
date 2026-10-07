import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { addSlugs, buildPayload, loadConfig, loadRefs, planWrites, readSidecar, sidecarPath, writeSidecar } from "./openproject-client.mjs";
import { resolveMap } from "./project-map.mjs";
import { countWords, lintWorkPackage } from "./task-lint.mjs";

function projectOf(flags) {
  const project = flags.project ?? resolveMap(process.cwd())?.map.tracker?.project;
  if (!project) throw new Error("no --project and no tracker.project in the project map");
  return project;
}

const resolveParent = (draft, mapping, created) => (typeof draft.parent === "string" ? mapping[draft.parent] ?? created[draft.parent] : draft.parent);

async function check(client, project, drafts) {
  const mapping = JSON.parse(readSidecar(sidecarPath(client.host, project)));
  const plan = planWrites(drafts, mapping);
  const refs = await loadRefs(client, project);
  let failed = false;
  for (const [index, draft] of drafts.entries()) {
    const step = plan[index];
    const blocks = lintWorkPackage(draft).filter((finding) => finding.severity === "BLOCK");
    let form = "form skipped: parent not created yet";
    const parent = resolveParent(draft, mapping, {});
    if (!(typeof draft.parent === "string" && !parent)) {
      const target = step.action === "create" ? `/api/v3/projects/${project}/work_packages/form` : `/api/v3/work_packages/${step.id}/form`;
      const lockVersion = step.action === "update" ? (await client.request(`/api/v3/work_packages/${step.id}`)).lockVersion : undefined;
      const result = await client.request(target, { method: "POST", body: buildPayload({ ...draft, parent }, refs, lockVersion) });
      const errors = Object.values(result?._embedded?.validationErrors ?? {}).map((error) => error.message);
      form = errors.length ? `form errors: ${errors.join("; ")}` : "form ok";
      failed ||= errors.length > 0;
    }
    failed ||= blocks.length > 0;
    const lint = blocks.length ? `lint ${blocks.map((finding) => finding.rule).join(", ")}` : `lint clean (${countWords(draft.description ?? "")} words)`;
    console.log(`${step.action}${step.id ? ` #${step.id}` : ""} ${draft.slug} | ${lint} | ${form}`);
  }
  const creates = plan.filter((step) => step.action === "create").length;
  console.log(`WRITE → ${client.host} · project ${project} : ${creates} create · ${plan.length - creates} update`);
  return { failed, plan, refs, mapping };
}

async function apply(client, project, drafts) {
  const { failed, plan, refs, mapping } = await check(client, project, drafts);
  if (failed) {
    console.log("refused: fix the lint and form findings above, then preview again");
    return 1;
  }
  const path = sidecarPath(client.host, project);
  const created = {};
  const statuses = drafts.some((draft) => draft.status) ? (await client.request("/api/v3/statuses"))._embedded.elements : [];
  for (const [index, draft] of drafts.entries()) {
    const step = plan[index];
    const parent = resolveParent(draft, mapping, created);
    let saved;
    if (step.action === "create") {
      saved = await client.request(`/api/v3/projects/${project}/work_packages`, { method: "POST", body: buildPayload({ ...draft, parent }, refs) });
      created[draft.slug] = saved.id;
      writeSidecar(path, addSlugs(readSidecar(path), { [draft.slug]: saved.id }));
    } else {
      const current = await client.request(`/api/v3/work_packages/${step.id}`);
      saved = await client.request(`/api/v3/work_packages/${step.id}`, { method: "PATCH", body: buildPayload({ ...draft, parent }, refs, current.lockVersion) });
    }
    for (const [type, targets] of [["relates", draft.relates ?? []], ["blocks", draft.blocks ?? []]]) {
      for (const target of targets) {
        await client.request(`/api/v3/work_packages/${saved.id}/relations`, { method: "POST", body: { type, _links: { to: { href: `/api/v3/work_packages/${mapping[target] ?? created[target] ?? target}` } } } }).catch((error) => console.log(`relation ${type} ${target}: ${error.message}`));
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
    const same = read.subject === draft.subject && read.description?.raw?.trim() === draft.description.trim();
    verified += same ? 1 : 0;
    console.log(`#${id} ${same ? "matches" : "DIFFERS"} ${read.subject}`);
  }
  console.log(`verified ${verified}/${drafts.length}`);
  return verified === drafts.length ? 0 : 1;
}

async function main([command, target, ...rest]) {
  const flags = Object.fromEntries(rest.flatMap((arg, index) => (arg.startsWith("--") ? [[arg.slice(2), rest[index + 1]]] : [])));
  const client = loadConfig();
  if (command === "get" && target) {
    console.log(JSON.stringify(await client.request(target), null, 1));
    return 0;
  }
  if ((command === "preview" || command === "apply") && target) {
    const drafts = JSON.parse(readFileSync(target, "utf8"));
    const project = projectOf(flags);
    if (command === "preview") return (await check(client, project, drafts)).failed ? 1 : 0;
    return apply(client, project, drafts);
  }
  console.error("usage: openproject.mjs get <api path> | preview <drafts.json> [--project <id>] | apply <drafts.json> [--project <id>]");
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
