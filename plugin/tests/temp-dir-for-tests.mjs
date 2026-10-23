import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];

process.on("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function profileWith(config) {
  const dir = tempDir("tedy-profile-");
  writeFileSync(join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}

export function mappedProfile(path, config = { language: { chat: "en" } }, map = {}) {
  const dir = profileWith(config);
  mkdirSync(join(dir, "projects"));
  writeFileSync(join(dir, "projects", "w.md"), `\`\`\`json\n${JSON.stringify({ name: "w", paths: [path], ...map })}\n\`\`\`\n`);
  return dir;
}
