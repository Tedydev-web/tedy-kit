import atexit
import contextlib
import hashlib
import io
import json
import sys
import re
import shutil
import tempfile
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, write_json, write_jsonl
from study_screening_input import fetch_inputs
from study_session_prompt import QGS_REPLY_FORMAT
from study_topic import load_topic

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
              "product": {"stop_row": None, "forced_repos": [], "channels": {"harness": "claude", "config_pool": True}}, "local": {"stop_row": None, "forced_repos": []}}
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
    return FakeFetch([("repos/o/missing7/commits/HEAD", ("", "exit 1: HTTP 404")), ("repos/p/missing7/commits/HEAD", ("", "exit 1: HTTP 404")), ("contents/README.md", README), ("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", "[]"), ("users/", json.dumps({"public_repos": 3})),
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
        kind = "qgs" if QGS_REPLY_FORMAT in prompt else "screening"
        build = qgs_row if kind == "qgs" else screening_row
        text = "\n".join(json.dumps(build(r, r["repo"] in self.flip)) for r in rows) + ("\nmechanism: gate: blocks edits until a test fails\n" if kind == "screening" else "\n")
        if cmd[0] == "claude":
            return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": text, "modelUsage": {model: {}}}), "ok", 0
        events = [{"event": "step_update", "step_update": {"step_type": "user_input"}}, {"event": "step_update", "step_update": {"step_type": "agent_response"}},
                  {"event": "result", "result": {"status": "SUCCESS", "num_turns": 1, "response": text}}]
        return "".join(json.dumps(e) + "\n" for e in events), "ok", 0


def call(repo, name, *args, fetch=None):
    kwargs = {"fetch": fetch} if fetch is not None else {}
    if name in ("run-screening-session", "run-judge"):
        kwargs.update(which=lambda cli: True, environ={"ANTHROPIC_API_KEY": "fixture"})
    script(name).main(["--topic", "demo", "--repo", str(repo), *args], **kwargs)


def labelled(repo, work, labels=None):
    call(repo, "draw-calibration-set", "--work", str(work), "--criteria", CRITERIA, fetch=inputs_fetch())
    sample = json.loads((work / "calibration-set.json").read_text())
    saved = work / "saved-labels.json"
    saved.write_text(json.dumps({"sweep": SWEEP, "set_sha256": hashlib.sha256((work / "calibration-set.json").read_bytes()).hexdigest(), "labels": labels or user_labels(sample)}))
    call(repo, "import-calibration-labels", "--work", str(work), "--labels", str(saved))
    saved.unlink()
    return sample


def frozen(repo, work, judges):
    topic = load_topic(repo, "demo")
    for stratum in ("config", "product"):
        (work / f"screening-packet-{stratum}.md").write_text(f"screening packet {stratum}: score the rows under the criteria\n")
        (work / f"qgs-packet-{stratum}.md").write_text(f"qgs packet {stratum}: problems X1 X2 X3 X4\n")
        fetch_inputs(topic, work, stratum, 200, inputs_fetch())
        for side in "AB":
            call(repo, "run-screening-session", "--work", str(work), "--stratum", stratum, "--side", side, "--ranks", "1-2", "--pilot", "--criteria", CRITERIA,
                 "--today", "2026-10-20", fetch=judges)
    call(repo, "freeze-protocol", "--work", str(work), "--criteria", CRITERIA, "--today", "2026-10-20")


def judged(repo, work, judges, names=("screening-A", "screening-B", "qgs-A", "qgs-B", "reader"), strata=("config", "product")):
    for stratum in strata:
        for name in names:
            for run in ("1", "2"):
                call(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", name, "--set", "calibration", "--run", run, "--today", "2026-10-20", fetch=judges)


def quiet(repo, name, *args, fetch=None):
    with contextlib.redirect_stdout(io.StringIO()):
        call(repo, name, *args, fetch=fetch)


def topic_qgs(repo, work, judges, stratum):
    listed = [json.loads(line) for line in (work / f"{stratum}-qgs-candidates.jsonl").read_text().splitlines()]
    canonical = json.loads((work / "cache/canonical.json").read_text()) if (work / "cache/canonical.json").is_file() else {}
    write_json(work / "cache/canonical.json", {**canonical, **{c["repo"].lower(): (None if "missing" in c["repo"] else c["repo"]) for c in listed}})
    quiet(repo, "fetch-screening-inputs", "--work", str(work), "--stratum", stratum, "--set", "qgs", fetch=inputs_fetch())
    call(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "qgs-A", "--set", "qgs", "--today", "2026-10-20", fetch=judges)
    judges.flip = {next(c["repo"] for c in listed if relevant(c["repo"]))}
    call(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "qgs-B", "--set", "qgs", "--today", "2026-10-20", fetch=judges)
    judges.flip = set()
    outsider = next(c for c in listed if not relevant(c["repo"]))
    cross = [{"id": c["id"], "repo": c["repo"], "verdict": "yes" if relevant(c["repo"]) or c is outsider else "no",
              "problems": problems_for(c["repo"]) if relevant(c["repo"]) or c is outsider else [], "why": "gemini"} for c in listed[:12]]
    write_jsonl(work / f"{stratum}-qgs-cross-{GEMINI['model']}.jsonl", cross)
    call(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "reader", "--set", "qgs", "--today", "2026-10-20", fetch=judges)
    quiet(repo, "qgs-standard", "--work", str(work), "--stratum", stratum, "--write")
    quiet(repo, "qgs-recall", "--work", str(work), "--stratum", stratum, "--states", "product", "--write", fetch=FakeFetch())


def screened(repo, work, judges, stratum):
    order = [json.loads(line) for line in (work / f"{stratum}-screening-order.jsonl").read_text().splitlines()]
    for side in "AB":
        call(repo, "run-screening-session", "--work", str(work), "--stratum", stratum, "--side", side, "--ranks", f"1-{len(order)}", "--today", "2026-10-20", fetch=judges)
    quiet(repo, "facet-depth", "--work", str(work), "--stratum", stratum, "--write-stop")


def v4_sweep(audit=True):
    repo = v4_repo()
    work = v4_work(repo)
    shutil.copytree(repo / "docs/prior-art/sweeps" / SWEEP, work, dirs_exist_ok=True)
    write_json(work / "mechanism-table.json", {"aliases": {}, "class": {}, "default": "new"})
    for stratum in ("config", "product"):
        write_json(work / f"{stratum}-mechanism-map.json", {"A": {}, "B": {}})
        write_json(work / f"{stratum}-adjudication.json", {"rows": {}, "capture_recapture": {"union": 1}})
    judges = ScriptedJudges()
    labelled(repo, work)
    frozen(repo, work, judges)
    judged(repo, work, judges)
    for stratum in ("config", "product"):
        topic_qgs(repo, work, judges, stratum)
        screened(repo, work, judges, stratum)
    if audit:
        quiet(repo, "draw-audit-sample", "--work", str(work))
        for stratum in ("config", "product"):
            call(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "audit", "--set", "audit", "--today", "2026-10-20", fetch=judges)
    quiet(repo, "export-sweep-data", "--work", str(work))
    shutil.rmtree(work)
    return repo


def user_labels(sample):
    labels = {}
    for row in sample["rows"]:
        yes = eligible(row["repo"])
        rel = relevant(row["repo"])
        labels[row["id"]] = {"Authority": 1 if yes else 0, "Methodology": 1 if yes else 0.5, "Objectivity": 1 if yes else 0, "Position": 1 if yes else 0,
                             "Relevance": 1 if rel else 0, "decision": "eligible" if yes else "excluded: irrelevant" if not rel else "excluded: below-threshold"}
    return labels


if __name__ == "__main__":
    from study_sweep_record import write_record
    from study_topic import load_topic
    built = v4_sweep(audit="--no-audit" not in sys.argv)
    write_record(built, load_topic(built, "demo"))
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
    shutil.rmtree(built)
