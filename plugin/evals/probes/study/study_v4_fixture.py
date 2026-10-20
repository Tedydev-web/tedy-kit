import atexit
import json
import re
import shutil
import tempfile
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, write_json, write_jsonl

KIT = HERE.parents[3]
CRITERIA = "docs/prior-art/quality-criteria-v4.md"
SWEEP = "261020-demo"
OPUS = {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}
SONNET = {"cli": "claude", "model": "claude-sonnet-5-5", "effort": "high"}
GEMINI = {"cli": "agy", "model": "gemini-3.8-flash-high"}
FACETS = {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1", "X2"], "terms": ["tdd", "test"], "strata": {"config": {"stop_row": None, "forced_repos": []},
                                                                                                                "product": {"stop_row": None, "forced_repos": []}}},
          "beta": {"sweep": "261020-demo-beta", "problems": ["X3", "X4"], "terms": ["guard", "lint"], "strata": {"config": {"stop_row": None, "forced_repos": []},
                                                                                                                "product": {"stop_row": None, "forced_repos": []}}}}
ROWS_PER_FACET = 40
SHARED = {"config": ("o/shared", 3, 5), "product": ("p/shared", 4, 6)}
CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
SECRET = "JUDGE-ANSWER-MUST-NOT-LEAK"
README = "# Demo readme <img src=https://example.com/x.png onerror=alert(1)>\nIt guards a tdd loop."


def prefix(stratum):
    return "o" if stratum == "config" else "p"


def facet_repos(stratum, facet):
    repos = [f"{prefix(stratum)}/{facet[0]}{i}" for i in range(1, ROWS_PER_FACET + 1)]
    name, alpha, beta = SHARED[stratum]
    repos[(alpha if facet == "alpha" else beta) - 1] = name
    return repos


def number(repo):
    found = re.search(r"(\d+)$", repo)
    return int(found.group(1)) if found else 0


def relevant(repo):
    return repo.endswith("shared") or number(repo) % 3 != 0


def eligible(repo):
    return relevant(repo) and number(repo) % 4 != 0


def problems_for(repo):
    return ["X3"] if repo.split("/", 1)[1].startswith("b") else ["X1"]


def v4_repo():
    repo = Path(tempfile.mkdtemp(prefix="study-v4-"))
    atexit.register(shutil.rmtree, repo, ignore_errors=True)
    (repo / "docs/prior-art").mkdir(parents=True)
    shutil.copyfile(KIT / CRITERIA, repo / CRITERIA)
    strata = {"config": {"stop_row": None, "forced_repos": [], "channels": {"code_queries": ['"tdd" filename:SKILL.md', '"guard" filename:SKILL.md']}},
              "product": {"stop_row": None, "forced_repos": [], "channels": {"harness": "claude", "config_pool": True}}}
    write_json(repo / "docs/prior-art/topics/demo.json", {"registry": "docs/prior-art/problems-demo.md", "sweep": SWEEP, "problems": ["X1", "X2", "X3", "X4"],
                                                          "terms": ["tdd", "test", "guard", "lint"], "qgs_list_topic": "claude", "pilot_rows": 2,
                                                          "sessions": {"A": OPUS, "B": SONNET}, "qgs_judges": {"A": OPUS, "B": SONNET}, "reader": OPUS, "cross_family": GEMINI,
                                                          "strata": strata, "facets": FACETS})
    D = repo / "docs/prior-art/sweeps" / SWEEP
    write_json(D / "meta.json", {"title": "Sweep demo v4", "role": "demo", "date": "2026-10-20", "criteria": CRITERIA, "inventory_digest": "0" * 16, "problems": ["X1", "X2", "X3", "X4"],
                                 "terms_matched": ["tdd"], "stop": {}, "query_log": {"config": ['repos "tdd"']}, "prisma": {"config": {"identified": 80}}, "recall": "see below", "gaps": ["none"]})
    write_json(D / "study.json", {"budget": "b", "method": "m", "coverage": "c", "study": {}, "flags": {}})
    write_json(D / "surface-map.json", {"considered": {"PreToolUse": ["config:gate"]}, "not relevant": {"Stop": "r"}, "outside the inventory": {}})
    return repo


def v4_work(repo):
    work = Path(tempfile.mkdtemp(prefix="study-v4-work-"))
    atexit.register(shutil.rmtree, work, ignore_errors=True)
    for stratum in ("config", "product"):
        for facet in FACETS:
            folder = work / "facets" / facet
            rows = [{"order_rank": i, "repo": r, "pushed": "2026-09-01", "stars": 3, "forced": False,
                     **({"units": [f"skills/{facet}"]} if stratum == "config" else {"contract_files": ["src/hook.ts"]})} for i, r in enumerate(facet_repos(stratum, facet), 1)]
            write_jsonl(folder / f"{stratum}-screening-order.jsonl", rows)
            write_json(folder / f"{stratum}-ranked.json", {"rows": [], "aggregators": [], "code_queries_counted": ['"tdd" filename:SKILL.md'] if facet == "alpha" else []})
            for row in rows:
                write_json(work / "cache/trees" / (row["repo"].replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md", f"skills/{facet}/SKILL.md", "src/hook.ts"]})
        candidates = [r for f in FACETS for r in facet_repos(stratum, f)[:16]] + [f"{prefix(stratum)}/missing7"]
        write_jsonl(work / f"{stratum}-qgs-candidates.jsonl", [{"id": i, "repo": r, "list": "l/awesome-claude", "heading": "Kits", "line": f"- {r}"} for i, r in enumerate(dict.fromkeys(candidates), 1)])
    write_json(work / "product-state.json", {"hits": {"p/a1": {"repo": "p/a1", "channels": {"config-pool": ["c"]}}, "p/a2": {"repo": "p/a2", "channels": {"config-pool": ["c"], "repo": ["r"]}}},
                                             "terms_sha256": "x"})
    script("merge-facet-orders").main(["--topic", "demo", "--repo", str(repo), "--work", str(work)])
    return work


def inputs_fetch():
    return FakeFetch([("contents/README.md", README), ("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", "[]"), ("users/", json.dumps({"public_repos": 3})),
                      ("contents/skills/", "skill text"), ("contents/src/hook.ts", "hook source")])


def screening_row(row, flip=False):
    yes = eligible(row["repo"]) != flip
    value = 1 if yes else 0
    cells = {c: {"v": value, "why": SECRET} for c in CELLS}
    return {"order_rank": row["order_rank"], "repo": row["repo"], "file": "f", "scores": cells, "mechanisms": ["gate"] if yes else [], "new": True,
            "decision": "eligible" if yes else "exclude: irrelevant", "note": SECRET}


def qgs_row(row, flip=False):
    yes = relevant(row["repo"]) != flip
    return {"order_rank": row["order_rank"], "repo": row["repo"], "verdict": "yes" if yes else "no", "problems": problems_for(row["repo"]) if yes else [], "why": SECRET}


class ScriptedJudges(FakeFetch):
    def __init__(self):
        super().__init__()
        self.flip = set()
        self.prompts = []

    def run(self, cmd, timeout=180, cwd=None):
        super().run(cmd, timeout, cwd)
        if cmd[1:] == ["--version"]:
            return "9.9.9 (fixture)\n", "ok", 0
        prompt = cmd[-1]
        self.prompts.append(prompt)
        model = cmd[cmd.index("--model") + 1]
        rows = [json.loads(block) for block in re.findall(r"```json\n(.+?)\n```", prompt)]
        kind = "qgs" if '"verdict"' in prompt else "screening"
        build = qgs_row if kind == "qgs" else screening_row
        text = "\n".join(json.dumps(build(r, r["repo"] in self.flip)) for r in rows) + ("\nmechanism: gate: blocks edits until a test fails\n" if kind == "screening" else "\n")
        if cmd[0] == "claude":
            return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": text, "modelUsage": {model: {}}}), "ok", 0
        events = [{"event": "step_update", "step_update": {"step_type": "user_input"}}, {"event": "step_update", "step_update": {"step_type": "agent_response"}},
                  {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "response": text}}]
        return "".join(json.dumps(e) + "\n" for e in events), "ok", 0


def user_labels(sample):
    labels = {}
    for row in sample["rows"]:
        yes = eligible(row["repo"])
        rel = relevant(row["repo"])
        labels[row["id"]] = {"Authority": 1 if yes else 0, "Methodology": 1 if yes else 0.5, "Objectivity": 1 if yes else 0, "Position": 1 if yes else 0,
                             "Relevance": 1 if rel else 0, "decision": "eligible" if yes else "excluded: irrelevant" if not rel else "excluded: below-threshold"}
    return labels
