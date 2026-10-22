import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { LABELS } from "../lib/labels.mjs";
import { recordApprovals } from "../lib/publish-approval-ticket.mjs";
import { tempDir } from "./temp-dir-for-tests.mjs";

const exec = promisify(execFile);
const VI = LABELS.vi;
export const SCRIPTS = new URL("../scripts/", import.meta.url).pathname;

const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const fx = JSON.parse(readFileSync(process.env.GH_FIXTURE, "utf8"));
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
const write = args.some((token) => /^-X/.test(token)) || (args.includes("graphql") && args.some((token) => /mutation/.test(token)));
if (write) appendFileSync(process.env.WRITES, "gh " + args.join(" ") + (args.includes("--input") ? " " + JSON.stringify(readFileSync(0, "utf8")) : "") + "\\n");
if (args.includes("graphql")) out(fx.graphql ?? {});
else if (args[0] === "repo" && args[1] === "view") out(fx.repo ?? "o/r");
else if (args[0] === "pr" && args[1] === "diff") out(fx.diff ?? "");
else if (args[0] === "pr" && args[1] === "view" && args.includes("headRefOid")) out(fx.head ?? "");
else if (args[0] === "pr" && args[1] === "view") out(fx.prView ?? {});
else if (args[0] === "api" && args[1] === "user") out(fx.login ?? "me");
else if (write) out(fx.write ?? { id: 77, html_url: "https://x/77", body: fx.writeBody ?? "" });
else if (args.some((token) => /\\/reviews\\/[^/]+\\/comments$/.test(token))) out([fx.reviewComments ?? []]);
else if (args.some((token) => /\\/comments$/.test(token))) out([fx.comments ?? []]);
else out("");
`;

const FAKE_RCLONE = `#!/usr/bin/env node
if (process.argv[2] === "config" && process.argv[3] === "dump") process.stdout.write(JSON.stringify({ gdrive: { token: JSON.stringify({ access_token: "a", refresh_token: "r", expiry: "2999-01-01T00:00:00Z" }), client_id: "cid", client_secret: "cs" } }));
`;

const FAKE_FETCH = `import { appendFileSync, readFileSync } from "node:fs";
const web = JSON.parse(readFileSync(process.env.FAKE_WEB, "utf8"));
let next = 900;
const real = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const method = options.method ?? "GET";
  const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
  if (url.host === "oauth2.googleapis.com") return json({ access_token: "a" });
  if (method !== "GET") appendFileSync(process.env.WRITES, \`\${url.host} \${method} \${url.pathname}\\n\`);
  if (url.host === "api.figma.com") {
    if (url.pathname === "/v1/me") return json({ handle: "me" });
    if (/^\\/v1\\/files\\/[^/]+$/.test(url.pathname)) return json({ version: web.figmaVersion ?? "1" });
    if (url.pathname.endsWith("/nodes")) return json({ nodes: { [url.searchParams.get("ids")]: { document: { absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 } } } } });
    const one = url.pathname.match(/\\/comments\\/([^/]+)$/);
    if (one && method === "DELETE") {
      web.figma = web.figma.filter((comment) => comment.id !== one[1]);
      return json({});
    }
    if (method === "POST") {
      const created = { id: String(next++), message: body.message, parent_id: body.comment_id, client_meta: body.client_meta, user: { handle: "me" }, created_at: "2026-10-22T00:00:00Z" };
      web.figma.push(created);
      return json(created);
    }
    return json({ comments: web.figma });
  }
  if (url.host === "docs.google.com") return new Response(web.tabs[url.searchParams.get("tab")] ?? "", { status: 200 });
  if (url.host === "docs.googleapis.com") {
    if (method === "POST") {
      for (const request of body.requests) web.drive.push({ id: String(next++), content: request.insertComment.content, resolved: false, author: { me: true, displayName: "me" }, replies: [], createdTime: "2026-10-22T00:00:00Z" });
      return json({});
    }
    return json(web.document);
  }
  if (url.host === "www.googleapis.com") {
    const reply = url.pathname.match(/\\/comments\\/([^/]+)\\/replies(?:\\/([^/]+))?$/);
    const comment = url.pathname.match(/\\/comments\\/([^/]+)$/);
    const thread = (id) => web.drive.find((item) => item.id === id);
    if (reply && method === "POST") {
      thread(reply[1]).replies.push({ id: String(next++), content: body.content, deleted: false, author: { me: true, displayName: "me" }, createdTime: "2026-10-22T00:00:00Z" });
      return json({ id: "r" });
    }
    if (reply && reply[2]) {
      const item = thread(reply[1]).replies.find((candidate) => candidate.id === reply[2]);
      if (method === "PATCH") item.content = body.content;
      if (method === "DELETE") item.deleted = true;
      return json(item);
    }
    if (comment && method === "PATCH") {
      thread(comment[1]).content = body.content;
      return json(thread(comment[1]));
    }
    if (comment && method === "DELETE") {
      web.drive = web.drive.filter((item) => item.id !== comment[1]);
      return json({});
    }
    return json({ comments: web.drive.map((item) => ({ ...item, replies: item.replies.filter((candidate) => !candidate.deleted) })) });
  }
  return real(input, options);
};
`;

const STATUSES = [
  { name: "New", isClosed: false, _links: { self: { href: "/api/v3/statuses/1" } } },
  { name: "In progress", isClosed: false, _links: { self: { href: "/api/v3/statuses/7" } } },
  { name: "Closed", isClosed: true, _links: { self: { href: "/api/v3/statuses/12" } } },
];
const DESCRIPTION = "## Goal\nShow the pop-up when a 4th vault is started on Free.\n\n## Checklist\n- [ ] Show the pop-up.\n\n## AC\n- [ ] On Free, a 4th vault cannot be started.";

export function fakeOpenProject({ closedStatus = true } = {}) {
  const workPackages = {};
  const relations = [];
  const activities = [];
  const calls = [];
  let nextId = 30000;
  const make = (id, subject) => ({ id, subject, lockVersion: 0, updatedAt: "2000-01-01T00:00:00Z", estimatedTime: null, description: { raw: DESCRIPTION }, _links: { status: { title: "New" }, project: { href: "/api/v3/projects/183" }, priority: { title: "Normal" } } });
  workPackages[21298] = make(21298, "[FE] Vault limit pop-up on Free");
  workPackages[21300] = make(21300, "[FE] Wire vault limit");
  relations.push({ id: 1000, type: "relates", reverseType: "relates", _links: { from: { href: "/api/v3/work_packages/21298" }, to: { href: "/api/v3/work_packages/21300" } } });
  activities.push({ id: 9, comment: { raw: "old text" }, _links: { user: { href: "/api/v3/users/1" }, workPackage: { href: "/api/v3/work_packages/21298" } } });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const path = url.pathname;
      const send = (data, status = 200) => response.writeHead(status).end(JSON.stringify(data));
      if (request.method !== "GET" && !path.endsWith("/form")) calls.push(`${request.method} ${path}`);
      if (path === "/api/v3/statuses") return send({ _embedded: { elements: closedStatus ? STATUSES : STATUSES.filter((status) => !status.isClosed) } });
      if (path === "/api/v3/priorities") return send({ _embedded: { elements: [{ name: "High", _links: { self: { href: "/api/v3/priorities/9" } } }] } });
      if (path === "/api/v3/users/me") return send({ name: "me", _links: { self: { href: "/api/v3/users/1" } } });
      if (path.endsWith("/types")) return send({ _embedded: { elements: [{ name: "Task", _links: { self: { href: "/api/v3/types/1" } } }] } });
      if (path.endsWith("/available_assignees")) return send({ _embedded: { elements: [{ name: "Hoàng Lâm", _links: { self: { href: "/api/v3/users/7" } } }] } });
      if (path.endsWith("/form")) return send({ _embedded: { validationErrors: {} } });
      if (path === "/api/v3/projects/183/work_packages" && request.method === "GET") return send({ total: 0, _embedded: { elements: [] } });
      if (path === "/api/v3/projects/183/work_packages" && request.method === "POST") {
        const payload = JSON.parse(body);
        const created = make(nextId++, payload.subject);
        created.description = { raw: payload.description.raw };
        workPackages[created.id] = created;
        return send(created);
      }
      const activity = path.match(/^\/api\/v3\/activities\/(\d+)$/);
      if (activity) {
        const found = activities.find((item) => item.id === Number(activity[1]));
        if (request.method === "PATCH") found.comment = { raw: JSON.parse(body).comment.raw };
        return send(found);
      }
      const wpActivities = path.match(/^\/api\/v3\/work_packages\/(\d+)\/activities$/);
      if (wpActivities) {
        if (request.method === "POST") {
          activities.push({ id: 500 + activities.length, comment: { raw: JSON.parse(body).comment.raw }, _links: { user: { href: "/api/v3/users/1" }, workPackage: { href: `/api/v3/work_packages/${wpActivities[1]}` } } });
          return send(activities.at(-1), 201);
        }
        return send({ _embedded: { elements: activities.filter((item) => item._links.workPackage.href.endsWith(`/${wpActivities[1]}`)) } });
      }
      const relation = path.match(/^\/api\/v3\/relations\/(\d+)$/);
      if (relation) {
        const index = relations.findIndex((item) => item.id === Number(relation[1]));
        if (index < 0) return send({ message: "not found" }, 404);
        if (request.method !== "DELETE") return send(relations[index]);
        relations.splice(index, 1);
        return response.writeHead(204).end();
      }
      const wpRelations = path.match(/^\/api\/v3\/work_packages\/(\d+)\/relations$/);
      if (wpRelations) {
        if (request.method === "POST") {
          const payload = JSON.parse(body);
          relations.push({ id: 2000 + relations.length, type: payload.type, reverseType: payload.type, _links: payload._links });
          return send(relations.at(-1), 201);
        }
        return send({ _embedded: { elements: relations.filter((item) => [item._links.from.href, item._links.to.href].some((href) => href.endsWith(`/${wpRelations[1]}`))) } });
      }
      const match = path.match(/^\/api\/v3\/work_packages\/(\d+)$/);
      const workPackage = match && workPackages[match[1]];
      if (!workPackage) return send({}, 404);
      if (request.method === "DELETE") {
        delete workPackages[match[1]];
        return response.writeHead(204).end();
      }
      if (request.method === "PATCH") {
        const payload = JSON.parse(body);
        if (payload.lockVersion !== undefined && payload.lockVersion !== workPackage.lockVersion) return send({ message: "lock version mismatch" }, 409);
        const status = STATUSES.find((candidate) => candidate._links.self.href === payload._links?.status?.href);
        if (status) workPackage._links.status = { title: status.name };
        if (payload.subject) workPackage.subject = payload.subject;
        if (payload.description) workPackage.description = { raw: payload.description.raw };
        workPackage.lockVersion += 1;
      }
      send(workPackage);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, workPackages, url: `http://127.0.0.1:${server.address().port}` })));
}

export function world({ mode = "answer", gh = {}, web = {}, map = null, opUrl = null } = {}) {
  const dir = tempDir("tedy-world-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "rclone"), FAKE_RCLONE);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "rclone"), 0o755);
  writeFileSync(join(dir, "fake-fetch.mjs"), FAKE_FETCH);
  writeFileSync(join(dir, "gh.json"), JSON.stringify(gh));
  writeFileSync(join(dir, "web.json"), JSON.stringify({ figma: [], drive: [], tabs: {}, document: {}, ...web }));
  const writesLog = join(dir, "writes.log");
  writeFileSync(writesLog, "");
  const profile = join(dir, "profile");
  mkdirSync(join(profile, "projects"), { recursive: true });
  writeFileSync(join(profile, "config.json"), JSON.stringify({ gates: mode ? { publishApproval: mode } : {}, language: { chat: "en" } }));
  if (map) writeFileSync(join(profile, "projects", `${map.name}.md`), `# Project map\n\n\`\`\`json\n${JSON.stringify({ paths: [dir], ...map }, null, 2)}\n\`\`\`\n`);
  mkdirSync(join(dir, ".config", "op", "sync"), { recursive: true });
  if (opUrl) writeFileSync(join(dir, ".config", "op", "config.json"), JSON.stringify({ url: opUrl, token: "test-" + "token-value" }));
  mkdirSync(join(dir, ".config", "figma"), { recursive: true });
  writeFileSync(join(dir, ".config", "figma", "token"), "figd_test\n");
  const state = join(dir, "state");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, WRITES: writesLog, GH_FIXTURE: join(dir, "gh.json"), FAKE_WEB: join(dir, "web.json"), TEDY_STATE_DIR: state, TEDY_PROFILE_DIR: profile, OP_SYNC_DIR: join(dir, ".config", "op", "sync"), NODE_OPTIONS: `--import=${join(dir, "fake-fetch.mjs")}` };
  const approve = (preview, question = "Q?") => recordApprovals({ session_id: "s", tool_use_id: "t", tool_input: { questions: [{ question, header: "x", multiSelect: false, options: [{ label: VI["post.asIs"], description: "d", preview }, { label: VI["post.hold"], description: "n" }] }] }, tool_response: { questions: [], answers: { [question]: VI["post.asIs"] }, annotations: { [question]: { preview } } } }, { dir: join(state, "approvals"), accepted: [VI["post.asIs"], VI["approve.all"]] });
  const run = (script, args) => exec("node", [join(SCRIPTS, `${script}.mjs`), ...args], { cwd: dir, env, timeout: 30_000 }).then((result) => ({ code: 0, out: `${result.stdout}${result.stderr}` }), (error) => ({ code: error.code, out: `${error.stdout ?? ""}${error.stderr ?? ""}` }));
  const writes = () => readFileSync(writesLog, "utf8").split("\n").filter(Boolean);
  const file = (name, text) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };
  const quote = (arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg}'`);
  const tickets = () => {
    try {
      return readdirSync(join(state, "approvals")).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };
  return { dir, env, approve, run, writes, file, tickets, line: (script, args) => `node ${join(SCRIPTS, `${script}.mjs`)} ${args.map(quote).join(" ")}` };
}
