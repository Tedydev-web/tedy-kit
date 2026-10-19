import atexit
import importlib.util
import json
import shutil
import tempfile
from pathlib import Path


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def scores(value, relevance=1, authority=None):
    judged = {k: {"v": value, "why": "w"} for k in ("Authority", "Methodology", "Objectivity", "Date", "Position")}
    if authority is not None:
        judged["Authority"] = {"v": authority, "why": "w"}
    return {**judged, "Relevance": {"v": relevance, "why": "w"}}


def screen_row(rank, repo, value, mechanisms, decision="eligible", authority=None):
    return {"order_rank": rank, "repo": repo, "scores": scores(value, authority=authority), "mechanisms": mechanisms, "decision": decision, "commit": f"https://github.com/{repo}/commit/{'a' * 40}"}


def topic_repo(strata=None, sweep="261001-demo", topic="demo"):
    repo = Path(tempfile.mkdtemp(prefix="study-topic-"))
    atexit.register(shutil.rmtree, repo, ignore_errors=True)
    strata = strata or {"config": {"stop_row": 2, "forced_repos": ["o/forced"], "channels": {}}, "local": {"stop_row": 1, "forced_repos": []}}
    write_json(repo / "docs/prior-art/topics" / f"{topic}.json", {"sweep": sweep, "terms": ["tdd", "test"], "strata": strata})
    (repo / "docs/prior-art/quality-criteria-v2.md").write_text("criteria\n")
    D = repo / "docs/prior-art/sweeps" / sweep
    write_json(D / "meta.json", {"title": "Sweep demo", "role": topic, "date": "2026-10-01", "criteria": "docs/prior-art/quality-criteria-v2.md",
                                 "inventory_digest": "0" * 16, "problems": ["X1"], "terms_matched": ["tdd"], "stop": {s: f"stop: row {r.get('stop_row')}" for s, r in strata.items()},
                                 "query_log": {"config": ["repos \"tdd\""]}, "prisma": {"config": {"identified": 4}}, "recall": "QGS 1 of 1", "gaps": ["none"]})
    write_json(D / "study.json", {"budget": "b", "method": "m", "coverage": "c", "study": {"o/one": "picked for the ledger"}, "flags": {}})
    write_json(D / "surface-map.json", {"considered": {"PreToolUse": ["config:gate"]}, "not relevant": {"Stop": "r"}, "outside the inventory": {}})
    write_json(D / "mechanism-table.json", {"aliases": {}, "class": {"config:gate": "new", "local:note": "K1", "config:proof": "evidence"}, "default": "new"})
    for stratum in strata:
        write_json(D / f"{stratum}-mechanism-map.json", {"A": {}, "B": {}})
        write_json(D / f"{stratum}-adjudication.json", {"rows": {}, "capture_recapture": {"union": 1}})
    write_jsonl(D / "config-screening-order.jsonl", [{"order_rank": r, "repo": n, "forced": n == "o/forced"} for r, n in ((1, "o/one"), (2, "o/two"), (3, "o/three"), (5, "o/forced"))])
    for side in "AB":
        write_jsonl(D / f"config-screen-{side}.jsonl", [screen_row(1, "o/one", 1, ["gate"]), screen_row(2, "o/two", 0, [], "exclude: irrelevant"),
                                                       screen_row(3, "o/three", 1, ["gate"]), screen_row(5, "o/forced", 1, ["gate", "proof"], authority=1 if side == "A" else 0.5)])
    if "local" in strata:
        write_jsonl(D / "local-screening-order.jsonl", [{"order_rank": 1, "repo": "plugin:skill", "forced": False}])
        for side in "AB":
            write_jsonl(D / f"local-screen-{side}.jsonl", [screen_row(1, "plugin:skill", 1, ["note"])])
    return repo


HERE = Path(__file__).resolve().parent


def script(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeFetch:
    def __init__(self, rules=()):
        self.rules = list(rules)
        self.calls, self.cwds = [], []

    def run(self, cmd, timeout=180, cwd=None):
        line = " ".join(cmd)
        self.calls.append(line)
        self.cwds.append(cwd)
        self.last_stderr = ""
        for needle, out in self.rules:
            if needle in line:
                if isinstance(out, str):
                    return out, "ok", 0
                self.last_stderr = out[2] if len(out) > 2 else ""
                return out[0], out[1], 0
        return "", "ok", 0

    def pace(self, seconds):
        pass

    def called(self, needle):
        return [c for c in self.calls if needle in c]
