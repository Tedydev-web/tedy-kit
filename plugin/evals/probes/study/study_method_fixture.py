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
RANKS = {"config": (1, 2, 3, 4, 5, 6, 8), "product": (1, 2, 3, 4, 5, 6)}
EVIDENCE = [("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", json.dumps([{"name": "r", "stargazers_count": 5, "description": "AI coding hooks"}])),
            ("users/", json.dumps({"public_repos": 3})), ("repos/p/r3/contents/src/hook.ts", ("", "exit 1: HTTP 404")), ("repos/p/r4/contents/package.json", json.dumps({"name": "p-r4"})),
            ("repos/o/r5/commits/HEAD", "f" * 40 + "\n"), ("repos/o/r5/git/trees/" + "f" * 40 + "?recursive=1", json.dumps({"tree": [{"path": "README.md"}], "truncated": True})),
            ("repos/o/r5/git/trees/", json.dumps({"tree": [{"path": "README.md"}, {"path": "skills"}]}))]
DNS_DOWN = ("registry.npmjs.org/p-r4", ("", "exit 6: curl: (6) Could not resolve host: registry.npmjs.org"))
PUBLISHED = ("registry.npmjs.org/p-r4", json.dumps({"dist-tags": {"latest": "1.0.0"}}))
TREES = {("product", 3): ["README.md", "src/hook.ts"], ("product", 4): ["README.md", "package.json"]}


def repo_name(stratum, rank):
    return "o/forced" if (stratum, rank) == ("config", 8) else f"{'o' if stratum == 'config' else 'p'}/r{rank}"


def planned(stratum, side, rank):
    mechanisms = (["gate"] if stratum == "config" else ["hook"]) if rank % 3 else []
    value = 1 if mechanisms else 0
    if side == "B" and (stratum, rank) == ("config", 8):
        return {"Authority": 0.5}, mechanisms + ["proof"]
    if side == "B" and (stratum, rank) == ("product", 2):
        return 0.5, mechanisms
    return value, mechanisms + (["proof"] if (stratum, rank) == ("config", 8) else [])


def reply_row(stratum, side, row):
    value, mechanisms = planned(stratum, side, row["order_rank"])
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
        prompt = cmd[-1]
        model = cmd[cmd.index("--model") + 1]
        rows = [json.loads(block) for block in re.findall(r"```json\n(.+?)\n```", prompt)]
        stratum = "config" if rows[0]["repo"].startswith("o/") else "product"
        side = "A" if model == self.a_model else "B"
        text = "\n".join(reply_row(stratum, side, r) for r in rows) + "\nmechanism: gate: blocks edits until a test fails\n"
        if cmd[0] == "claude":
            return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": text, "modelUsage": {model: {}}}), "ok", 0
        events = [{"event": "init", "init": {"model": model, "tools": []}},
                  {"event": "step_update", "step_update": {"step_index": 0, "step_type": "user_input", "state": "DONE"}},
                  {"event": "step_update", "step_update": {"step_index": 1, "step_type": "agent_response", "state": "DONE"}},
                  {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "response": text}}]
        return "".join(json.dumps(e) + "\n" for e in events), "ok", 0


def input_states(work):
    states = {}
    for stratum in RANKS:
        for row in map(json.loads, (work / f"{stratum}-screening-inputs.jsonl").read_text().splitlines()):
            state = row.get("error_kind") or row.get("tree") or ("missing " + ", ".join(row["missing"]) if row.get("missing") else None)
            if state:
                states[f"{stratum} {row['order_rank']}"] = state
    return states


def session(repo, work, fetch, which, environ, *args):
    script("run-screening-session").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), *args, "--today", "2026-10-20"], fetch=fetch, which=which, environ=environ)


def work_folder(repo):
    topic_file = repo / "docs/prior-art/topics/demo.json"
    topic = json.loads(topic_file.read_text())
    topic["strata"]["local"] = {"stop_row": None, "forced_repos": []}
    write_json(topic_file, {**topic, "pilot_rows": 1, "sessions": {"A": MODELS["A"], "B": {**MODELS["B"], "fallback": FALLBACK}}})
    D, work = repo / "docs/prior-art/sweeps/261001-demo", Path(tempfile.mkdtemp(prefix="method-work-"))
    shutil.copytree(D, work, dirs_exist_ok=True)
    shutil.rmtree(D)
    for side in "AB":
        (work / f"config-screen-{side}.jsonl").unlink()
    for stratum, ranks in RANKS.items():
        write_jsonl(work / f"{stratum}-screening-order.jsonl", [{"order_rank": r, "repo": repo_name(stratum, r), "forced": r == 8, "pushed": "2026-09-01",
                                                                 **({"contract_files": ["src/hook.ts"]} if (stratum, r) == ("product", 3) else {})} for r in ranks])
        (work / f"screening-packet-{stratum}.md").write_text(f"packet {stratum}, pilot draft\n")
        for r in ranks:
            if (stratum, r) not in (("product", 2), ("config", 5)):
                write_json(work / "cache/trees" / (repo_name(stratum, r).replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": TREES.get((stratum, r), ["README.md"])})
    write_json(work / "study.json", {**json.loads((work / "study.json").read_text()), "study": {"o/r1": "picked for the ledger"}})
    write_json(work / "product-adjudication.json", {"rows": {"2": {"decision": "eligible", "why": "the hook source runs the tests"}}, "capture_recapture": {"union": 1}})
    write_json(work / "meta.json", {**json.loads((work / "meta.json").read_text()), "criteria": CRITERIA})
    write_json(work / "config-state.json", {"papers": {"arxiv:2510.00001": {"title": "Agents that tamper with tests", "url": "https://arxiv.org/abs/2510.00001", "queries": ["arxiv abs:tdd"]}},
                                            "hits": {"o/r1": {"repo": "o/r1", "channels": {"arxiv": ["arxiv:2510.00001"]}}}})
    write_json(work / "config-qgs-adjudicated.json", {"final": ["o/r1", "O/R2"]})
    write_json(work / "product-qgs-adjudicated.json", {"final": ["p/r1", "p/r9"]})
    return work


def method_repo(same_family=False, rated=None, bare=True, events=None):
    events = [] if events is None else events
    repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": ["o/forced"], "channels": {"academic": {"arxiv": ["abs:tdd"]}}},
                              "product": {"stop_row": None, "forced_repos": [], "channels": {}}})
    work = work_folder(repo)
    loaded = load_topic(repo, "demo")
    which = (lambda cli: cli != "agy") if same_family else (lambda cli: True)
    environ = {"ANTHROPIC_API_KEY": "fixture"} if bare else {}
    fetch = ScriptedSessions(MODELS["A"]["model"])
    broken = FakeFetch([("repos/p/r2/commits/HEAD", "d" * 40 + "\n"), ("repos/p/r2/git/trees/", ("", "exit 1: HTTP 502")), DNS_DOWN, *EVIDENCE])
    for stratum in RANKS:
        fetch_inputs(loaded, work, stratum, 200, broken if stratum == "product" else FakeFetch(EVIDENCE))
    events.append(f"first fetch: {input_states(work)}")
    try:
        session(repo, work, fetch, which, environ, "--stratum", "product", "--side", "A", "--ranks", "1-2", "--pilot", "--criteria", CRITERIA)
    except SystemExit as refused:
        events.append(f"refused: {refused}")
    for stratum in RANKS:
        for side in "AB":
            session(repo, work, fetch, which, environ, "--stratum", stratum, "--side", side, "--ranks", "1-1", "--pilot", "--criteria", CRITERIA)
        (work / f"screening-packet-{stratum}.md").write_text(f"packet {stratum}\n")
    healed = FakeFetch([("repos/p/r2/commits/HEAD", "d" * 40 + "\n"), ("repos/p/r2/git/trees/", json.dumps({"tree": [{"path": "README.md"}]})), PUBLISHED, *EVIDENCE])
    fetched, kept, failed = fetch_inputs(loaded, work, "product", 200, healed)
    events.append(f"refetch after a scored block: fetched {fetched}, kept {kept}, still transient {failed}, calls to the scored rank {len(healed.called('p/r1'))}")
    events.append(f"after the refetch: {input_states(work)}")
    script("freeze-protocol").main(["--topic", "demo", "--repo", str(repo), "--work", str(work), "--criteria", CRITERIA, "--today", "2026-10-20",
                                    "--amendment", "the pilot draft became the frozen packet"])
    for stratum in RANKS:
        for side in "AB":
            session(repo, work, fetch, which, environ, "--stratum", stratum, "--side", side, "--ranks", "1-9")
        write_stop_row(load_topic(repo, "demo"), stratum, script("compare-screening-sessions").compare(work, stratum, None)["stop"]["row"])
    if rated:
        script("draw-calibration-sample").main(["--topic", "demo", "--repo", str(repo), "--work", str(work)])
        sample = json.loads((work / "calibration-sample.json").read_text())
        for row in sample["rows"]:
            eligible = row["order_rank"] % 3 != 0
            row["user"] = {"Authority": 1 if eligible else 0, "Methodology": 1 if eligible else 0, "Objectivity": 1 if eligible else 0, "Position": 1 if eligible else 0,
                           "decision": "eligible" if eligible else "excluded: irrelevant"}
        if rated == "partial":
            sample["rows"][0]["user"]["decision"] = None
        write_json(work / "calibration-sample.json", sample)
    script("export-sweep-data").export(load_topic(repo, "demo"), repo, work)
    shutil.rmtree(work)
    return repo


if __name__ == "__main__":
    from study_sweep_record import write_record
    built = method_repo(same_family="--same-family" in sys.argv, rated="full" if "--rated" in sys.argv else None, bare="--no-bare" not in sys.argv)
    write_record(built, load_topic(built, "demo"))
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
    shutil.rmtree(built)
