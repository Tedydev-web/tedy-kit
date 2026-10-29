import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gatherFacts, planLines } from "../lib/op-status.mjs";

const TRACKER = {
  not_started: ["New"],
  flow: { Bug: { start: "In progress", review: "Merged/Code Review", merged: "Closed", revert: "Re-Work", by_role: { Tester: { merged: "Fixed (Dev Done)", assign: "author" } } } },
};
const workPackage = { id: 21, subject: "Fee shows twice", lockVersion: 4, _links: { type: { title: "Bug" }, status: { title: "Merged/Code Review" }, author: { href: "/api/v3/users/9", title: "Tess Ter" }, assignee: { href: "/api/v3/users/140", title: "Dev One" } } };
const request = async (path) => {
  if (path === "/api/v3/work_packages/21") return workPackage;
  if (path.startsWith("/api/v3/memberships?")) {
    const filters = JSON.parse(decodeURIComponent(path.split("filters=")[1]));
    assert.deepEqual(filters, [{ project: { operator: "=", values: ["183"] } }, { principal: { operator: "=", values: ["9"] } }]);
    return { _embedded: { elements: [{ _links: { roles: [{ title: "Tester" }] } }] } };
  }
  throw new Error(`unexpected ${path}`);
};
const listed = {
  fe: [
    { number: 1, state: "MERGED", baseRefName: "dev", title: "fix: fee once", mergedAt: "2026-10-28T00:00:00Z", body: "OP#21" },
    { number: 2, state: "OPEN", baseRefName: "dev", title: "fix: unrelated", mergedAt: null, body: "OP#210 mentions 21 in text" },
  ],
  be: [{ number: 3, state: "MERGED", baseRefName: "dev", title: "fix: fee api", mergedAt: "2026-10-28T01:00:00Z", body: "https://op.example/work_packages/21" }],
};
const repos = [{ name: "fe", integration: "dev" }, { name: "be", integration: "dev" }];

test("facts hold the package's type, status and author roles, and only the PRs whose body links that package", async () => {
  const { facts } = await gatherFacts(21, { request, listPrs: (repo) => listed[repo.name], repos, project: 183, started: false });
  assert.deepEqual(facts, {
    type: "Bug",
    status: "Merged/Code Review",
    authorRoles: ["Tester"],
    started: false,
    assigneeIsAuthor: false,
    prs: [
      { repo: "fe", number: 1, state: "merged", base: "dev", integration: "dev", title: "fix: fee once", mergedAt: "2026-10-28T00:00:00Z", url: undefined },
      { repo: "be", number: 3, state: "merged", base: "dev", integration: "dev", title: "fix: fee api", mergedAt: "2026-10-28T01:00:00Z", url: undefined },
    ],
  });
});

test("the plan prints one line per package and the set command, with the author as assignee when the flow hands the bug back", async () => {
  const gathered = await gatherFacts(21, { request, listPrs: (repo) => listed[repo.name], repos, project: 183, started: false });
  assert.deepEqual(planLines(gathered, TRACKER), [
    "#21 Bug [Merged/Code Review] → Fixed (Dev Done), assign Tess Ter · merged: fe#1, be#3 · Fee shows twice",
    'node <plugin>/scripts/openproject.mjs set 21 --status "Fixed (Dev Done)" --assignee "Tess Ter"',
  ]);
  const open = { fe: [...listed.fe, { number: 4, state: "OPEN", baseRefName: "dev", title: "fix: follow-up", mergedAt: null, body: "OP#21" }], be: listed.be };
  assert.deepEqual(planLines(await gatherFacts(21, { request, listPrs: (repo) => open[repo.name], repos, project: 183, started: false }), TRACKER), ["#21 Bug [Merged/Code Review] skip: already Merged/Code Review · Fee shows twice"]);
});
