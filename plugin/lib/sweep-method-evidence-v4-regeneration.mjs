import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("../evals/probes/prior-art-sweep-record.py", import.meta.url));
const SHOWN = "plugin/evals/probes/prior-art-sweep-record.py";

const quoted = (line) => (line === undefined ? "the end of the file" : JSON.stringify(line));

export function regenerationErrors(repo, sweep, text) {
  const run = spawnSync("python3", ["-B", RENDERER, repo, sweep, "--stdout"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, STUDY_NO_NETWORK: "1" },
  });
  if (run.error) return [`python3 could not run the record renderer (${run.error.code ?? run.error.message}): the v4 gate rebuilds the record with ${SHOWN} and needs python3 on PATH`];
  if (run.status !== 0) {
    const reason = (run.stderr ?? "").trim().split("\n").at(-1) || `exit ${run.status ?? run.signal}`;
    return [`the record renderer refused the sweep files: ${reason}`];
  }
  if (run.stdout === text) return [];
  const got = text.split("\n");
  const want = run.stdout.split("\n");
  const at = Array.from({ length: Math.max(got.length, want.length) }, (_, i) => i).find((i) => got[i] !== want[i]);
  return [`the record is not the one the renderer rebuilds from the sweep files: line ${at + 1} reads ${quoted(got[at])}, the renderer writes ${quoted(want[at])}`];
}
