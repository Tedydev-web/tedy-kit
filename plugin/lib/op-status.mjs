import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./openproject-client.mjs";
import { resolveMap } from "./project-map.mjs";
import { mapRepos } from "./source-pin-git.mjs";
import { linkedIds, planStatus } from "./status-flow.mjs";

const userId = (link) => link?.href?.split("/").pop() ?? null;

export async function gatherFacts(id, { request, listPrs, repos, project, started }) {
  const workPackage = await request(`/api/v3/work_packages/${id}`);
  const author = userId(workPackage._links.author);
  const filters = encodeURIComponent(JSON.stringify([{ project: { operator: "=", values: [String(project)] } }, { principal: { operator: "=", values: [author] } }]));
  const members = await request(`/api/v3/memberships?filters=${filters}`);
  const authorRoles = [...new Set(members._embedded.elements.flatMap((member) => (member._links.roles ?? []).map((role) => role.title)))];
  const prs = repos.flatMap((repo) =>
    listPrs(repo, id)
      .filter((pr) => linkedIds(pr.body).includes(Number(id)))
      .map((pr) => ({ repo: repo.name, number: pr.number, state: pr.state.toLowerCase(), base: pr.baseRefName, integration: repo.integration, title: pr.title, mergedAt: pr.mergedAt, url: pr.url })),
  );
  const facts = { type: workPackage._links.type.title, status: workPackage._links.status.title, authorRoles, started, assigneeIsAuthor: userId(workPackage._links.assignee) === author, prs };
  return { workPackage, facts };
}

export function planLines({ workPackage, facts }, tracker) {
  const plan = planStatus(facts, tracker);
  const head = `#${workPackage.id} ${facts.type} [${facts.status}]`;
  if (plan.skip) return [`${head} skip: ${plan.skip} · ${workPackage.subject}`];
  const author = workPackage._links.author.title;
  const prs = facts.prs.filter((pr) => pr.base === pr.integration && pr.state !== "closed").map((pr) => `${pr.repo}#${pr.number}`);
  const assign = plan.assign === "author" ? `, assign ${author}` : "";
  return [
    `${head} → ${plan.to}${assign} · ${plan.event}${prs.length ? `: ${prs.join(", ")}` : ""} · ${workPackage.subject}`,
    `node <plugin>/scripts/openproject.mjs set ${workPackage.id} --status "${plan.to}"${plan.assign === "author" ? ` --assignee "${author}"` : ""}`,
  ];
}

export function listPullRequests(repo, id) {
  return JSON.parse(execFileSync("gh", ["pr", "list", "--state", "all", "--search", `${id} in:body`, "--limit", "50", "--json", "number,state,baseRefName,title,mergedAt,body,url"], { cwd: repo.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

async function main(argv) {
  const ids = argv.filter((arg) => /^\d+$/.test(arg));
  if (argv[0] !== "plan" || !ids.length) {
    console.error("usage: op-status.mjs plan <work package id>... [--started]");
    return 2;
  }
  const resolved = resolveMap(process.cwd());
  if (!resolved) throw new Error(`no project map covers ${process.cwd()}; run /tedy:setup`);
  const { map } = resolved;
  if (!map.tracker?.flow) {
    console.log(`the map ${map.name} has no tracker.flow; add it with /tedy:setup update`);
    return 1;
  }
  const client = loadConfig();
  const repos = mapRepos(map).map((repo) => ({ ...repo, integration: repo.branches[0] }));
  for (const id of ids) {
    const gathered = await gatherFacts(id, { request: (path) => client.request(path), listPrs: listPullRequests, repos, project: map.tracker.project, started: argv.includes("--started") });
    for (const line of planLines(gathered, map.tracker)) console.log(line);
  }
  return 0;
}

export function run() {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`op-status: ${error.message}`);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
