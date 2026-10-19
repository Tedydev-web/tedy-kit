import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_screening_input import fetch_inputs
from study_topic import load_topic, write_stop_row

CRITERIA = "docs/prior-art/quality-criteria-v2.md"
MODELS = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}, "B": {"cli": "agy", "model": "gemini-3.8-flash-high"}}
FALLBACK = {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"}
CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
PLAN = {("config", "A"): {1: (1, ["gate"]), 2: (0, []), 3: (1, ["gate"]), 5: (1, ["gate", "proof"])},
        ("config", "B"): {1: (1, ["gate"]), 2: (0, []), 3: (1, ["gate"]), 5: ({"Authority": 0.5}, ["gate", "proof"])},
        ("product", "A"): {1: (1, ["hook"]), 2: (0, []), 3: (1, ["hook"])},
        ("product", "B"): {1: (1, ["hook"]), 2: (0, []), 3: (0.5, ["hook"])}}


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def reply_row(row, side_plan):
    value, mechanisms = side_plan[row["order_rank"]]
    cells = {c: {"v": (value.get(c, 1) if isinstance(value, dict) else value), "why": "w"} for c in CELLS}
    decision = "eligible" if mechanisms else "exclude: irrelevant"
    return json.dumps({"order_rank": row["order_rank"], "repo": row["repo"], "file": "f", "scores": cells, "mechanisms": mechanisms, "new": True, "decision": decision, "note": ""})


class ScriptedSessions(FakeFetch):
    def __init__(self, a_model):
        super().__init__()
        self.a_model = a_model

    def run(self, cmd, timeout=180, cwd=None):
        super().run(cmd, timeout, cwd)
        if cmd[1:] == ["--version"]:
            return "9.9.9 (fixture)\n", "ok", 0
        prompt = cmd[2] if cmd[0] == "claude" else cmd[-1]
        model = cmd[cmd.index("--model") + 1]
        rows = [json.loads(block) for block in re.findall(r"```json\n(.+?)\n```", prompt)]
        stratum = "config" if rows[0]["repo"].startswith("o/") else "product"
        text = "\n".join(reply_row(r, PLAN[(stratum, "A" if model == self.a_model else "B")]) for r in rows) + "\nmechanism: gate: blocks edits until a test fails\n"
        if cmd[0] == "claude":
            return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": text, "modelUsage": {model: {}}}), "ok", 0
        return json.dumps({"status": "SUCCESS", "num_turns": 1, "response": text}), "ok", 0


def session(repo, work, fetch, which, environ, *args):
    script("run-screening-session").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), *args, "--today", "2026-10-20"], fetch=fetch, which=which, environ=environ)


def method_repo(same_family=False, rated=None, bare=True):
    repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": ["o/forced"], "channels": {"academic": {"arxiv": ["abs:tdd"]}}},
                              "product": {"stop_row": None, "forced_repos": [], "channels": {}}})
    topic_file = repo / "docs/prior-art/topics/demo.json"
    topic = json.loads(topic_file.read_text())
    topic["strata"]["local"] = {"stop_row": None, "forced_repos": []}
    write_json(topic_file, {**topic, "pilot_rows": 1, "sessions": {"A": MODELS["A"], "B": {**MODELS["B"], "fallback": FALLBACK}}})
    D, work = repo / "docs/prior-art/sweeps/261001-demo", Path(tempfile.mkdtemp(prefix="method-work-"))
    shutil.copytree(D, work, dirs_exist_ok=True)
    shutil.rmtree(D)
    for side in "AB":
        (work / f"config-screen-{side}.jsonl").unlink()
    write_jsonl(work / "product-screening-order.jsonl", [{"order_rank": r, "repo": f"p/{r}", "forced": False} for r in (1, 2, 3)])
    write_json(work / "product-adjudication.json", {"rows": {"3": {"decision": "eligible", "why": "the hook source runs the tests"}}, "capture_recapture": {"union": 1}})
    write_json(work / "meta.json", {**json.loads((work / "meta.json").read_text()), "criteria": CRITERIA})
    for stratum in ("config", "product"):
        (work / f"screening-packet-{stratum}.md").write_text(f"packet {stratum}, pilot draft\n")
        for row in map(json.loads, (work / f"{stratum}-screening-order.jsonl").read_text().splitlines()):
            write_json(work / "cache/trees" / (row["repo"].replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md"]})
    loaded = load_topic(repo, "demo")
    which = (lambda cli: cli != "agy") if same_family else (lambda cli: True)
    environ = {"ANTHROPIC_API_KEY": "fixture"} if bare else {}
    fetch = ScriptedSessions(MODELS["A"]["model"])
    for stratum in ("config", "product"):
        fetch_inputs(loaded, work, stratum, 200, FakeFetch())
        for side in "AB":
            session(repo, work, fetch, which, environ, "--stratum", stratum, "--side", side, "--ranks", "1-1", "--pilot", "--criteria", CRITERIA)
        (work / f"screening-packet-{stratum}.md").write_text(f"packet {stratum}\n")
    script("freeze-protocol").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--today", "2026-10-20",
                                    "--amendment", "the pilot draft became the frozen packet"])
    for stratum in ("config", "product"):
        for side in "AB":
            session(repo, work, fetch, which, environ, "--stratum", stratum, "--side", side, "--ranks", "1-5")
        write_stop_row(load_topic(repo, "demo"), stratum, script("compare-screening-sessions").compare(work, stratum, None)["stop"]["row"])
    write_json(work / "config-qgs-adjudicated.json", {"final": ["o/one", "O/Three"]})
    write_json(work / "product-qgs-adjudicated.json", {"final": ["p/1", "p/9"]})
    if rated:
        inputs = {r["order_rank"]: r for r in map(json.loads, (work / "config-screening-inputs.jsonl").read_text().splitlines())}
        rows = [{"stratum": "config", "order_rank": r, "repo": n, "commit": "c", "inputs_sha256": "0" * 64,
                 "user": {"Authority": 1, "Methodology": 1, "Objectivity": 1, "Position": 1, "decision": "eligible"}} for r, n in ((3, "o/three"), (5, "o/forced")) if r in inputs]
        if rated == "partial":
            rows[0]["user"]["decision"] = None
        write_json(work / "calibration-sample.json", {"instructions": "i", "rows": rows})
    script("export-sweep-data").export(load_topic(repo, "demo"), repo, work)
    shutil.rmtree(work)
    return repo


if __name__ == "__main__":
    from study_sweep_record import write_record
    built = method_repo(same_family="--same-family" in sys.argv, rated="full" if "--rated" in sys.argv else None, bare="--no-bare" not in sys.argv)
    write_record(built, load_topic(built, "demo"))
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
    shutil.rmtree(built)
