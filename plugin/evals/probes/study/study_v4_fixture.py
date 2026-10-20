import atexit
import contextlib
import hashlib
import io
import json
import re
import shutil
import tempfile
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, write_json, write_jsonl
from study_session_prompt import QGS_REPLY_FORMAT, STAGE1_REPLY_FORMAT

KIT = HERE.parents[3]
CRITERIA = "docs/prior-art/quality-criteria-v4.md"
SWEEP = "261020-demo"
OPUS = {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}
SONNET = {"cli": "claude", "model": "claude-sonnet-5-5", "effort": "high"}
GEMINI = {"cli": "agy", "model": "gemini-3.8-flash-high"}
PROBLEMS = ["X1", "X2", "X3", "X4"]
FACETS = {"alpha": {"sweep": "261020-demo-alpha", "problems": ["X1", "X2"], "terms": ["tdd", "test"]},
          "beta": {"sweep": "261020-demo-beta", "problems": ["X3", "X4"], "terms": ["guard", "lint"]}}
EXAMPLES = [{"repo": f"e/{v}{i}", "description": f"{v} example {i}", "verdict": v, "problems": ["X1"] if v == "yes" else [], "why": "worked example"}
            for v in ("yes", "unsure", "no") for i in (1, 2)]
ROWS_PER_FACET = 50
SHARED = {"config": ("o/shared", 3, 5), "product": ("p/shared", 4, 6)}
OUTSIDE = "o/outside1"
CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
SECRET = "JUDGE-ANSWER-MUST-NOT-LEAK"
README = "# Demo readme <img src=https://example.com/x.png onerror=alert(1)>\nIt guards a tdd loop."
TODAY = "2026-10-20"


def prefix(stratum):
    return "o" if stratum == "config" else "p"


def facet_repos(stratum, facet):
    repos = [f"{prefix(stratum)}/{facet[0]}{i}" for i in range(1, ROWS_PER_FACET + 1)]
    name, alpha, beta = SHARED[stratum]
    repos[(alpha if facet == "alpha" else beta) - 1] = name
    return repos


def pool_repos(stratum):
    alpha, beta = facet_repos(stratum, "alpha"), facet_repos(stratum, "beta")
    return list(dict.fromkeys(r for pair in zip(alpha, beta) for r in pair))


def number(repo):
    found = re.search(r"(\d+)$", repo)
    return int(found.group(1)) if found else 0


def relevant(repo):
    return repo.endswith("shared") or repo == OUTSIDE or number(repo) % 3 != 0


def eligible(repo):
    return relevant(repo) and number(repo) % 7 != 0


def problems_for(repo):
    if repo.endswith("shared"):
        return ["X1", "X3"]
    return ["X3"] if repo.split("/", 1)[1].startswith("b") else ["X1"]


def description(repo):
    return "" if number(repo) % 10 == 9 else f"{repo} guards a tdd loop"


def v4_repo():
    repo = Path(tempfile.mkdtemp(prefix="study-v4-"))
    atexit.register(shutil.rmtree, repo, ignore_errors=True)
    (repo / "docs/prior-art").mkdir(parents=True)
    shutil.copyfile(KIT / CRITERIA, repo / CRITERIA)
    strata = {"config": {"stop_row": None, "forced_repos": [], "channels": {"code_queries": ['"tdd" filename:SKILL.md', '"guard" filename:SKILL.md']}},
              "product": {"stop_row": None, "forced_repos": [], "channels": {"harness": "claude", "config_pool": True}}, "local": {"stop_row": None, "forced_repos": []}}
    write_json(repo / "docs/prior-art/topics/demo.json", {"registry": "docs/prior-art/problems-demo.md", "sweep": SWEEP, "problems": PROBLEMS,
                                                          "terms": ["tdd", "test", "guard", "lint"], "qgs_list_topic": "claude", "pilot_rows": 2,
                                                          "sessions": {"A": OPUS, "B": SONNET}, "qgs_judges": {"A": OPUS, "B": SONNET}, "reader": OPUS, "cross_family": GEMINI,
                                                          "stage1_examples": EXAMPLES, "strata": strata, "facets": FACETS})
    D = repo / "docs/prior-art/sweeps" / SWEEP
    write_json(D / "meta.json", {"title": "Sweep demo v4", "role": "demo", "date": TODAY, "criteria": CRITERIA, "inventory_digest": "0" * 16, "problems": PROBLEMS,
                                 "terms_matched": ["tdd"], "stop": {}, "query_log": {"config": ['repos "tdd"']}, "gaps": ["none"]})
    write_json(D / "study.json", {"budget": "b", "method": "m", "coverage": "c", "study": {}, "flags": {}})
    write_json(D / "surface-map.json", {"considered": {"PreToolUse": ["config:gate"]}, "not relevant": {"Stop": "r"}, "outside the inventory": {}})
    return repo


def order_row(stratum, rank, repo):
    shape = {"units": ["skills/tdd"]} if stratum == "config" else {"contract_files": ["src/hook.ts"]}
    return {"order_rank": rank, "repo": repo, "description": description(repo), "pushed": "2026-09-01", "stars": 3, "forced": False, **shape}


def v4_work(repo):
    work = Path(tempfile.mkdtemp(prefix="study-v4-work-"))
    atexit.register(shutil.rmtree, work, ignore_errors=True)
    for stratum in ("config", "product"):
        rows = [order_row(stratum, i, r) for i, r in enumerate(pool_repos(stratum), 1)]
        write_jsonl(work / f"{stratum}-screening-order.jsonl", rows)
        write_json(work / f"{stratum}-ranked.json", {"terms": ["tdd", "test", "guard", "lint"], "rows": rows, "aggregators": []})
        for facet in FACETS:
            write_json(work / "facets" / facet / f"{stratum}-ranked.json",
                       {"terms": FACETS[facet]["terms"], "rows": [{"order_rank": i, "repo": r} for i, r in enumerate(facet_repos(stratum, facet), 1)], "aggregators": []})
        for row in rows:
            write_json(work / "cache/trees" / (row["repo"].replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md", "skills/tdd/SKILL.md", "src/hook.ts"]})
        (work / f"stage1-packet-{stratum}.md").write_text(f"stage-1 packet {stratum}: problems X1 X2 X3 X4\n")
        (work / f"qgs-packet-{stratum}.md").write_text(f"qgs packet {stratum}: problems X1 X2 X3 X4\n")
        (work / f"screening-packet-{stratum}.md").write_text(f"screening packet {stratum}: score the rows under the criteria\n")
    candidates = [r for s in ("config", "product") for f in FACETS for r in facet_repos(s, f)[:16]] + ["o/missing7", OUTSIDE]
    write_jsonl(work / "qgs-candidates.jsonl", [{"id": i, "repo": r, "list": "l/awesome-claude", "heading": "Kits", "line": f"- {r}"} for i, r in enumerate(dict.fromkeys(candidates), 1)])
    write_json(work / "product-state.json", {"hits": {"p/a1": {"repo": "p/a1", "channels": {"config-pool": ["c"]}}, "p/a2": {"repo": "p/a2", "channels": {"config-pool": ["c"], "repo": ["r"]}}},
                                             "terms_sha256": "x"})
    for stratum in ("config", "product"):
        quiet(repo, "build-stage1-inputs", "--work", str(work), "--stratum", stratum, "--shape", "brief", fetch=FakeFetch())
    return work


def inputs_fetch():
    return FakeFetch([("repos/o/missing7/commits/HEAD", ("", "exit 1: HTTP 404")), ("contents/README.md", README), ("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", "[]"),
                      ("users/", json.dumps({"public_repos": 3})), ("contents/skills/", "skill text"), ("contents/src/hook.ts", "hook source")])


def screening_row(row, flip=False):
    yes = eligible(row["repo"]) != flip
    value = 1 if yes else 0
    cells = {c: {"v": value, "why": SECRET} for c in CELLS}
    return {"order_rank": row["order_rank"], "repo": row["repo"], "file": "f", "scores": cells, "mechanisms": ["gate"] if yes else [], "new": True,
            "decision": "eligible" if yes else "exclude: irrelevant", "note": SECRET}


def verdict_row(row, flip=False):
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
        screening = QGS_REPLY_FORMAT not in prompt and STAGE1_REPLY_FORMAT not in prompt
        build = screening_row if screening else verdict_row
        text = "\n".join(json.dumps(build(r, r["repo"] in self.flip)) for r in rows) + ("\nmechanism: gate: blocks edits until a test fails\n" if screening else "\n")
        if cmd[0] == "claude":
            return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": text, "modelUsage": {model: {}}}), "ok", 0
        events = [{"event": "step_update", "step_update": {"step_type": "user_input"}}, {"event": "step_update", "step_update": {"step_type": "agent_response"}},
                  {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "response": text}}]
        return "".join(json.dumps(e) + "\n" for e in events), "ok", 0


def call(repo, name, *args, fetch=None):
    kwargs = {"fetch": fetch} if fetch is not None else {}
    if name in ("run-screening-session", "run-judge", "run-stage1"):
        kwargs.update(which=lambda cli: True, environ={"ANTHROPIC_API_KEY": "fixture"})
    script(name).main(["--topic", "demo", "--repo", str(repo), *args], **kwargs)


def quiet(repo, name, *args, fetch=None):
    with contextlib.redirect_stdout(io.StringIO()):
        call(repo, name, *args, fetch=fetch)


def user_labels(sample):
    labels = {}
    for row in sample["rows"]:
        yes = eligible(row["repo"])
        rel = relevant(row["repo"])
        labels[row["id"]] = {"Authority": 1 if yes else 0, "Methodology": 1 if yes else 0.5, "Objectivity": 1 if yes else 0, "Position": 1 if yes else 0,
                             "Relevance": 1 if rel else 0, "problems": problems_for(row["repo"]) if rel else [],
                             "decision": "eligible" if yes else "excluded: irrelevant" if not rel else "excluded: below-threshold"}
    return labels


def saved_labels(work, batch, labels=None):
    sample = json.loads((work / f"{batch}-set.json").read_text())
    path = work / f"saved-{batch}-labels.json"
    path.write_text(json.dumps({"sweep": SWEEP, "batch": batch, "set_sha256": hashlib.sha256((work / f"{batch}-set.json").read_bytes()).hexdigest(),
                                "labels": labels or user_labels(sample)}))
    return path


def drawn_and_labelled(repo, work, top_up=None, labels=None):
    from study_calibration_set import top_up_trigger
    batch = "calibration" if top_up is None else top_up_trigger(work)[0]
    quiet(repo, "draw-calibration-set", "--work", str(work), "--criteria", CRITERIA, *(("--top-up", str(top_up)) if top_up else ()), fetch=inputs_fetch())
    path = saved_labels(work, batch, labels)
    quiet(repo, "import-calibration-labels", "--work", str(work), "--batch", batch, "--labels", str(path))
    path.unlink()
    return json.loads((work / f"{batch}-set.json").read_text())
