import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./hook-io.mjs";
import { loadMaps, PROJECTS_DIR, resolveMap } from "./project-map.mjs";

const FIELDS = {
  last_reply_check: { check: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)), shape: "an ISO timestamp" },
  learned_until: { check: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)), shape: "a date (YYYY-MM-DD)" },
};

function stateFile(name, dir) {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" is not a valid map name`);
  return join(dir, "projects", `${name}.json`);
}

export function readState(name, dir = STATE_DIR) {
  const file = stateFile(name, dir);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export function writeState(name, field, value, dir = STATE_DIR) {
  const rule = FIELDS[field];
  if (!rule) throw new Error(`unknown state field "${field}"; use ${Object.keys(FIELDS).join(" or ")}`);
  if (!rule.check(value)) throw new Error(`${field} must be ${rule.shape}, got "${value}"`);
  const file = stateFile(name, dir);
  const next = { ...readState(name, dir), [field]: value };
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return next;
}

export function migrateStates(maps, dir = STATE_DIR) {
  const moved = [];
  for (const { map } of maps) {
    const current = readState(map.name, dir);
    for (const field of Object.keys(FIELDS).sort()) {
      if (map[field] == null || current[field] != null) continue;
      writeState(map.name, field, map[field], dir);
      moved.push(`${map.name}.${field}`);
    }
  }
  return moved;
}

const USAGE = "usage: project-state.mjs get <field> | set <field> <value> | migrate   [--map <name>]";

function main(argv) {
  const flag = argv.indexOf("--map");
  const named = flag === -1 ? null : argv[flag + 1];
  const [command, field, value] = flag === -1 ? argv : argv.filter((_, index) => index !== flag && index !== flag + 1);
  if (command === "migrate") {
    const moved = migrateStates(loadMaps());
    process.stdout.write(`${moved.length ? `moved: ${moved.join(", ")}` : "nothing to move"}\nThe maps keep the old fields; delete them from the map files in ${PROJECTS_DIR}.\n`);
    return 0;
  }
  if (!((command === "get" && field && !value) || (command === "set" && field && value)) || (flag !== -1 && !named)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const name = named ?? resolveMap(process.cwd())?.map.name;
  if (!name) {
    process.stderr.write(`no project map covers ${process.cwd()}; run /tedy:setup or pass --map <name>\n`);
    return 1;
  }
  try {
    if (command === "set") writeState(name, field, value);
    else if (!FIELDS[field]) throw new Error(`unknown state field "${field}"; use ${Object.keys(FIELDS).join(" or ")}`);
    else if (readState(name)[field] != null) process.stdout.write(`${readState(name)[field]}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

export function run() {
  process.exit(main(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
