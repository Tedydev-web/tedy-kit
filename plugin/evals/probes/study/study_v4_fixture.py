import atexit
import contextlib
import hashlib
import io
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, write_json, write_jsonl
from study_session_prompt import QGS_REPLY_FORMAT, STAGE1_REPLY_FORMAT
from study_topic import load_topic

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
    return relevant(repo) and (repo.endswith("shared") or number(repo) % 7 != 0)


def problems_for(repo):
    if repo.endswith("shared"):
        return ["X1", "X3"]
    return ["X3"] if repo.split("/", 1)[1].startswith("b") else ["X1"]


def description(repo):
    if number(repo) % 10 == 9:
        return ""
    return f"{repo}: a web kit" if number(repo) % 6 == 0 else f"{repo} guards a tdd loop"


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
    channels = ["code"] + (["repo"] if number(repo) % 4 == 0 else []) + (["config-pool"] if stratum == "product" and number(repo) % 5 == 0 else [])
    return {"order_rank": rank, "repo": repo, "description": description(repo), "pushed": "2026-09-01", "stars": 3, "forced": False, "channels": channels, **shape}


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
        (work / f"screening-packet-{stratum}.md").write_text(f"screening packet {stratum}: score the rows under the criteria\n")
    (work / "qgs-packet.md").write_text("qgs packet: problems X1 X2 X3 X4\n")
    write_json(work / "cache/trees" / (OUTSIDE.replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md", "skills/tdd/SKILL.md"]})
    candidates = [r for s in ("config", "product") for f in FACETS for r in facet_repos(s, f)[:16]] + ["o/missing7", OUTSIDE]
    write_jsonl(work / "qgs-candidates.jsonl", [{"id": i, "repo": r, "list": "l/awesome-claude", "heading": "Kits", "line": f"- {r}: a claude tdd kit" if r.startswith("p/") or r == OUTSIDE else f"- {r}"} for i, r in enumerate(dict.fromkeys(candidates), 1)])
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


STRATA = ("config", "product")
QGS_JUDGE_NAMES = ("qgs-A", "qgs-B", "reader")
SCREENING_JUDGE_NAMES = ("screening-A", "screening-B")


def stage1_frozen(repo, work):
    quiet(repo, "freeze-stage1", "--work", str(work), "--today", TODAY)


def protocol_frozen(repo, work, judges):
    for stratum in STRATA:
        quiet(repo, "fetch-screening-inputs", "--work", str(work), "--stratum", stratum, "--through", "2", fetch=inputs_fetch())
        for side in "AB":
            quiet(repo, "run-screening-session", "--work", str(work), "--stratum", stratum, "--side", side, "--ranks", "1-2", "--pilot", "--criteria", CRITERIA,
                  "--today", TODAY, fetch=judges)
    quiet(repo, "freeze-protocol", "--work", str(work), "--criteria", CRITERIA, "--today", TODAY)


def calibrated_work(judges):
    repo = v4_repo()
    work = v4_work(repo)
    shutil.copytree(repo / "docs/prior-art/sweeps" / SWEEP, work, dirs_exist_ok=True)
    write_json(work / "mechanism-table.json", {"aliases": {}, "class": {}, "default": "new"})
    for stratum in STRATA:
        write_json(work / f"{stratum}-mechanism-map.json", {"A": {}, "B": {}})
        write_json(work / f"{stratum}-adjudication.json", {"rows": {}, "capture_recapture": {"union": 1}})
    stage1_frozen(repo, work)
    drawn_and_labelled(repo, work)
    protocol_frozen(repo, work, judges)
    return repo, work


def judged(repo, work, judges, names=SCREENING_JUDGE_NAMES + QGS_JUDGE_NAMES, strata=STRATA):
    for stratum in strata:
        for name in names:
            for run in ("1", "2"):
                quiet(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", name, "--set", "calibration", "--run", run, "--today", TODAY, fetch=judges)


def stage1_calibrated(repo, work, judges, models=("claude-sonnet-5-5",)):
    for stratum in STRATA:
        for model in models:
            for run in ("1", "2"):
                quiet(repo, "run-stage1", "--work", str(work), "--stratum", stratum, "--shape", "brief", "--model", model, "--set", "calibration", "--run", run,
                      "--today", TODAY, fetch=judges)
    quiet(repo, "choose-stage1-rung", "--work", str(work), "--today", TODAY)


def topic_qgs(repo, work, judges):
    listed = [json.loads(line) for line in (work / "qgs-candidates.jsonl").read_text().splitlines()]
    quiet(repo, "fetch-screening-inputs", "--work", str(work), "--set", "qgs", fetch=inputs_fetch())
    gone = [str(c["id"]) for c in listed if "missing" in c["repo"]]
    quiet(repo, "drop-qgs-candidates", "--work", str(work), "--ids", ",".join(gone), "--reason", "the repository is gone (HTTP 404)", "--today", TODAY)
    quiet(repo, "run-judge", "--work", str(work), "--judge", "qgs-A", "--set", "qgs", "--today", TODAY, fetch=judges)
    quiet(repo, "run-judge", "--work", str(work), "--judge", "qgs-B", "--set", "qgs", "--rows", "1-5", "--today", TODAY, fetch=judges)
    quiet(repo, "drop-run", "--work", str(work), "--key", "qgs-judge-B", "--ranks", "1-5", "--reason", "run before the packet fix", "--today", TODAY)
    judges.flip = {next(c["repo"] for c in listed if relevant(c["repo"]) and "missing" not in c["repo"])}
    quiet(repo, "run-judge", "--work", str(work), "--judge", "qgs-B", "--set", "qgs", "--today", TODAY, fetch=judges)
    judges.flip = set()
    outsider = next(c for c in listed if not relevant(c["repo"]))
    cross = [{"repo": c["repo"], "verdict": "yes" if relevant(c["repo"]) or c is outsider else "no",
              "problems": problems_for(c["repo"]) if relevant(c["repo"]) or c is outsider else [], "why": "gemini"} for c in listed[:12]]
    write_jsonl(work / f"qgs-cross-{GEMINI['model']}.jsonl", cross)
    quiet(repo, "run-judge", "--work", str(work), "--judge", "reader", "--set", "qgs", "--today", TODAY, fetch=judges)
    quiet(repo, "qgs-standard", "--work", str(work), "--write")


def stage1_pooled(repo, work, judges):
    rung = json.loads((work / "stage1-rung.json").read_text())["rung"]
    models = ["claude-sonnet-5-5"] if rung == 1 else ["claude-opus-5-5", "claude-sonnet-5-5"]
    for stratum in STRATA:
        for model in models:
            quiet(repo, "run-stage1", "--work", str(work), "--stratum", stratum, "--shape", "brief", "--model", model, "--set", "pool", "--today", TODAY, fetch=judges)


def stage1_audited(repo, work, judges):
    for stratum in STRATA:
        quiet(repo, "draw-stage1-audit", "--work", str(work), "--stratum", stratum)
        quiet(repo, "fetch-screening-inputs", "--work", str(work), "--stratum", stratum, "--set", "stage1-audit", fetch=inputs_fetch())
        quiet(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "screening-A", "--set", "stage1-audit", "--today", TODAY, fetch=judges)
        from study_stage1_audit import flagged
        flags = flagged(work, stratum, OPUS)[1]
        checks = work / f"saved-{stratum}-checks.json"
        checks.write_text(json.dumps({str(r): "excluded" for r in flags}))
        quiet(repo, "import-audit-checks", "--work", str(work), "--stratum", stratum, "--checks", str(checks))
        checks.unlink()


def stage2_screened(repo, work, judges, limits=None):
    for stratum in STRATA:
        limit = (limits or {}).get(stratum)
        quiet(repo, "plan-stage2", "--work", str(work), "--stratum", stratum, *(("--limit", str(limit)) if limit else ()))
        quiet(repo, "fetch-screening-inputs", "--work", str(work), "--stratum", stratum, "--set", "stage2", fetch=inputs_fetch())
        for side in "AB":
            quiet(repo, "run-screening-session", "--work", str(work), "--stratum", stratum, "--side", side, "--ranks", "1-2000", "--today", TODAY, fetch=judges)


def cross_audited(repo, work, judges):
    quiet(repo, "draw-audit-sample", "--work", str(work))
    for stratum in STRATA:
        quiet(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "audit", "--set", "audit", "--today", TODAY, fetch=judges)


def swept_work(limits=None):
    judges = ScriptedJudges()
    repo, work = calibrated_work(judges)
    judged(repo, work, judges)
    stage1_calibrated(repo, work, judges)
    topic_qgs(repo, work, judges)
    stage1_pooled(repo, work, judges)
    stage1_audited(repo, work, judges)
    stage2_screened(repo, work, judges, limits)
    cross_audited(repo, work, judges)
    return repo, work, judges


def v4_sweep(audit=True):
    judges = ScriptedJudges()
    repo, work = calibrated_work(judges)
    judged(repo, work, judges)
    stage1_calibrated(repo, work, judges)
    topic_qgs(repo, work, judges)
    stage1_pooled(repo, work, judges)
    stage1_audited(repo, work, judges)
    stage2_screened(repo, work, judges, {"product": 60})
    if audit:
        cross_audited(repo, work, judges)
    quiet(repo, "export-sweep-data", "--work", str(work))
    from study_sweep_record import write_record
    write_record(repo, load_topic(repo, "demo"))
    return repo


if __name__ == "__main__":
    built = v4_sweep(audit="--no-audit" not in sys.argv)
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
