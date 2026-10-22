import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileWith, tempDir } from "./temp-dir-for-tests.mjs";

const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");
const fx = JSON.parse(readFileSync(process.env.GH_FIXTURE, "utf8"));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const has = (x) => args.includes(x);
if (has("graphql")) out(fx.graphql ?? {});
else if (args[0] === "repo" && args[1] === "view") out(fx.repo ?? "o/r");
else if (args[0] === "pr" && args[1] === "diff") out(fx.diff ?? "");
else if (args[0] === "pr" && args[1] === "view" && has("headRefOid")) out(fx.head ?? "");
else if (args[0] === "pr" && args[1] === "view") out(fx.prView ?? {});
else if (args[0] === "api" && args[1] === "user") out(fx.login ?? "");
else if (args.some((t) => /^-X/.test(t))) out(fx.write ?? {});
else if (args.some((t) => /\\/reviews\\/[^/]+\\/comments$/.test(t))) out([fx.reviewComments ?? []]);
else if (args.some((t) => /\\/comments$/.test(t))) out([fx.comments ?? []]);
else out(fx.default ?? "");
`;

const BIN = tempDir("tedy-ghbin-");
writeFileSync(join(BIN, "gh"), FAKE_GH);
chmodSync(join(BIN, "gh"), 0o755);

export function runWithFakeGh(script, args, { fixture = {}, cwd, stateDir = tempDir("tedy-ghstate-"), profileDir = profileWith({ language: { chat: "en" } }) } = {}) {
  const dir = cwd ?? tempDir("tedy-ghcwd-");
  const fxFile = join(tempDir("tedy-ghfx-"), "fx.json");
  writeFileSync(fxFile, JSON.stringify(fixture));
  const log = join(tempDir("tedy-ghlog-"), "log");
  writeFileSync(log, "");
  const res = spawnSync("node", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH}`,
      GH_FIXTURE: fxFile,
      GH_LOG: log,
      TEDY_STATE_DIR: stateDir,
      TEDY_PROFILE_DIR: profileDir,
    },
  });
  const text = readFileSync(log, "utf8").trim();
  const writes = text
    ? text.split("\n").map((line) => JSON.parse(line)).filter((a) => a.some((t) => /^-X/.test(t)) || (a.includes("graphql") && a.some((t) => /mutation/.test(t))))
    : [];
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}`, writes };
}
