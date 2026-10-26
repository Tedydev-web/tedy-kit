import "./test-isolation.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareWorkPackageRefs, foreignWorkPackageRefs } from "../lib/work-package-refs.mjs";
import { fakeOpenProject, world } from "./fake-services-for-tests.mjs";

const DESCRIPTION = "## Goal\nShow the PRD message when a category name exists.\n\n## Checklist\n- [ ] Show the message.\n\n## AC\n- [ ] A taken name shows the message.";

test("every #N OpenProject would link is found, including after a backslash, and code and URLs are left out", () => {
  const text = "#61, (#62), [#63], \\#64, ##65 and ###66; `#67` stays\n```\n#68\n```\npage#69 https://x.io/#70 &#71; #21443 #61";
  assert.deepEqual(bareWorkPackageRefs(text), [61, 62, 63, 64, 65, 66, 21443]);
  assert.deepEqual(bareWorkPackageRefs("no refs here, `#1` only"), []);
});

test("a reference is foreign when the work package is missing, hidden or in another project", async () => {
  const projects = { 21443: "/api/v3/projects/183", 61: "/api/v3/projects/12" };
  const client = {
    request: async (path) => {
      const id = path.split("/").at(-1);
      if (id === "500") throw Object.assign(new Error("HTTP 500"), { status: 500 });
      if (!projects[id]) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return { _links: { project: { href: projects[id] } } };
    },
  };
  assert.deepEqual(await foreignWorkPackageRefs(client, "/api/v3/projects/183", "Name exists → #61 or #62, as in #21443."), [61, 62]);
  assert.deepEqual(await foreignWorkPackageRefs(client, "/api/v3/projects/183", "Name exists → `#61`, as in #21443."), []);
  await assert.rejects(foreignWorkPackageRefs(client, "/api/v3/projects/183", "#500"), /HTTP 500/);
});

test("a comment or a work package that would link a number outside the project is refused before anything is written", async () => {
  const op = await fakeOpenProject();
  try {
    const w = world({ opUrl: op.url });
    w.file("c.md", "Name exists → #61, as in #21300.\n");
    const refused = await w.run("openproject", ["comment", "21298", "--body-file", "c.md"]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /refused: #61 .*`#61`/);
    w.file("ok.md", "Name exists → `#61`, as in #21300.\n");
    const ok = await w.run("openproject", ["comment", "21298", "--body-file", "ok.md"]);
    assert.equal(ok.code, 0, ok.out);
    w.file("drafts.json", JSON.stringify([{ slug: "task-fe-a", type: "Task", subject: "[FE] Category name taken", description: DESCRIPTION.replace("Show the message.", "Show message #61."), estimate: 1 }]));
    const preview = await w.run("openproject", ["preview", "drafts.json", "--project", "183"]);
    assert.equal(preview.code, 1, preview.out);
    assert.match(preview.out, /lint foreign-ref #61 .*`#61`/);
    assert.deepEqual(op.calls, []);
  } finally {
    op.server.close();
  }
});
