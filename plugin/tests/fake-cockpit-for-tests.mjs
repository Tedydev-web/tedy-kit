import { spawnSync } from "node:child_process";

const [script, ...args] = process.argv.slice(2);
const { status, error } = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
if (error) throw error;
process.exit(status ?? 1);
