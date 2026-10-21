import atexit
import contextlib
import hashlib
import io
import json
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from study_fixtures import HERE, FakeFetch, script, write_json, write_jsonl
from study_session_prompt import QGS_REPLY_FORMAT, STAGE1_REPLY_FORMAT
from study_topic import load_topic, terms_digest

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
    if number(repo) % 6 == 0:
        return f"{repo}: a web kit"
    return f"{repo}: a claude hook guarding a tdd loop" if number(repo) % 5 == 0 else f"{repo} guards a tdd loop"


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


AGGREGATOR = "l/awesome-claude"
SNOWBALLED = ["s/snow1", "s/snow2", "s/snow3"]
NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)


def meta_info(repo):
    about = "awesome claude tdd list" if repo == AGGREGATOR else description(repo)
    return {"nameWithOwner": repo, "description": about, "createdAt": "2026-01-01T00:00:00Z", "pushedAt": "2026-09-01T00:00:00Z", "stargazerCount": 3,
            "isArchived": False, "isFork": False, "licenseInfo": {"spdxId": "MIT"}, "defaultBranchRef": {"name": "main", "target": {"oid": "e" * 40}},
            "issues": {"totalCount": 1}, "pullRequests": {"totalCount": 1}}


def state(work, name, hits, terms):
    write_json(work / name, {"hits": {r.lower(): {"repo": r, "channels": channels} for r, channels in hits.items()}, "log": [], "done": [], "terms_sha256": terms_digest(terms)})


def run(repo, name, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        script(name).main(["--topic", "demo", "--repo", str(repo), *args], **kwargs)


def qgs_candidate_repos():
    return [r for s in ("config", "product") for f in FACETS for r in facet_repos(s, f)[:16]] + ["o/missing7", OUTSIDE]


def aggregator_readme():
    lines = ["# Kits"] + [f"- [{r.split('/')[1]}](https://github.com/{r}) a claude tdd kit" for r in dict.fromkeys(qgs_candidate_repos())]
    return "\n".join(lines + [f"- [{r.split('/')[1]}](https://github.com/{r}) a tdd snowball" for r in SNOWBALLED]) + "\n"


def padding_repos(pad):
    return [f"o/z{6 * i}" for i in range(1, pad + 1)]


def v4_work(repo, pad=0):
    work = Path(tempfile.mkdtemp(prefix="study-v4-work-"))
    atexit.register(shutil.rmtree, work, ignore_errors=True)
    terms = load_topic(repo, "demo")["terms"]
    known = [*pool_repos("config"), *padding_repos(pad), *pool_repos("product"), *SNOWBALLED, AGGREGATOR]
    write_json(work / "cache/meta.json", {r.lower(): meta_info(r) for r in known})
    for r in [*known, OUTSIDE]:
        write_json(work / "cache/trees" / (r.replace("/", "__") + ".json"), {"oid": "e" * 40, "paths": ["README.md", "skills/tdd/SKILL.md", "src/hook.ts"]})
    (work / "cache/readmes").mkdir(parents=True, exist_ok=True)
    (work / "cache/readmes" / (AGGREGATOR.replace("/", "__") + ".md")).write_text(aggregator_readme())
    code = ['code "tdd" filename:SKILL.md: skills/tdd/SKILL.md']
    state(work, "config-state.json", {**{r: {"github-code-search": code} for r in pool_repos("config") + padding_repos(pad)}, AGGREGATOR: {"repo-search": ['repos "claude tdd"']}}, terms)
    state(work, "product-state.json", {r: {"repo": ['repos "claude tdd"']} for r in pool_repos("product")}, terms)
    args = ["--work", str(work)]
    run(repo, "resolve-pool", *args, "--stratum", "config", "--states", "config", fetch=FakeFetch(), now=NOW)
    run(repo, "rank-config-pool", *args)
    run(repo, "snowball-aggregators", *args, fetch=FakeFetch())
    run(repo, "resolve-pool", *args, "--stratum", "config", "--states", "config,snowball", fetch=FakeFetch(), now=NOW)
    run(repo, "rank-config-pool", *args, "--out", "config-ranked-snowball.json")
    run(repo, "snowball-above-cut", *args, "--all")
    run(repo, "export-screening-order", *args, "--stratum", "config", "--all")
    run(repo, "merge-snowball-order", *args)
    run(repo, "discover-product-pool", *args, "--channels", "config-pool", fetch=FakeFetch())
    run(repo, "resolve-pool", *args, "--stratum", "product", "--states", "product", fetch=FakeFetch(), now=NOW)
    run(repo, "rank-product-pool", *args)
    run(repo, "export-screening-order", *args, "--stratum", "product", "--all")
    run(repo, "extract-qgs-candidates", *args, fetch=FakeFetch())
    for stratum in ("config", "product"):
        for facet in FACETS:
            write_json(work / "facets" / facet / f"{stratum}-ranked.json",
                       {"terms": FACETS[facet]["terms"], "rows": [{"order_rank": i, "repo": r} for i, r in enumerate(facet_repos(stratum, facet), 1)], "aggregators": []})
        (work / f"stage1-packet-{stratum}.md").write_text(f"stage-1 packet {stratum}: problems X1 X2 X3 X4\n")
        (work / f"screening-packet-{stratum}.md").write_text(f"screening packet {stratum}: score the rows under the criteria\n")
        quiet(repo, "build-stage1-inputs", "--work", str(work), "--stratum", stratum, "--shape", "brief", fetch=FakeFetch())
    (work / "qgs-packet.md").write_text("qgs packet: problems X1 X2 X3 X4\n")
    return work


def inputs_fetch():
    return FakeFetch([("repos/o/missing7/commits/HEAD", ("", "exit 1: HTTP 404")), ("contents/README.md", README), ("/releases", "[]"), ("/tags", "[]"), ("/repos?per_page", "[]"),
                      ("users/", json.dumps({"public_repos": 3})), ("contents/skills/", "skill text"), ("contents/src/hook.ts", "hook source")])


def screening_row(row, flip=False):
    yes = eligible(row["repo"]) != flip
    value = 1 if yes else 0
    cells = {c: {"v": value, "why": SECRET} for c in CELLS}
    return {"order_rank": row["order_rank"], "repo": row["repo"], "file": "f", "scores": cells, "mechanisms": ["gate"] if yes else [], "problems": problems_for(row["repo"]) if yes else [], "new": True,
            "decision": "eligible" if yes else "exclude: irrelevant", "note": SECRET}


def verdict_row(row, flip=False):
    yes = relevant(row["repo"]) != flip
    return {"order_rank": row["order_rank"], "repo": row["repo"], "verdict": "yes" if yes else "no", "problems": problems_for(row["repo"]) if yes else [],
            "strata": strata_for(row["repo"]) if yes else [], "why": SECRET}


def strata_for(repo):
    return ["product"] if repo.startswith("p/") or repo == OUTSIDE else ["config"]


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
    quiet(repo, "draw-calibration-set", "--work", str(work), "--criteria", CRITERIA, "--today", TODAY, *(("--top-up", str(top_up)) if top_up else ()), fetch=inputs_fetch())
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


def topped_up(repo, work):
    labels = user_labels(json.loads((work / "calibration-set.json").read_text()))
    for key in [k for k, v in labels.items() if v["decision"] == "eligible"][:10]:
        labels[key] = {**labels[key], "decision": "excluded: below-threshold"}
    path = saved_labels(work, "calibration", labels)
    quiet(repo, "import-calibration-labels", "--work", str(work), "--batch", "calibration", "--labels", str(path))
    path.unlink()
    drawn_and_labelled(repo, work, top_up=30)


def calibrated_work(judges, top_up=False, pad=0):
    repo = v4_repo()
    work = v4_work(repo, pad)
    shutil.copytree(repo / "docs/prior-art/sweeps" / SWEEP, work, dirs_exist_ok=True)
    write_json(work / "mechanism-table.json", {"aliases": {}, "class": {}, "default": "new"})
    for stratum in STRATA:
        write_json(work / f"{stratum}-mechanism-map.json", {"A": {}, "B": {}})
        write_json(work / f"{stratum}-adjudication.json", {"rows": {}, "capture_recapture": {"union": 1}})
    stage1_frozen(repo, work)
    drawn_and_labelled(repo, work)
    if top_up:
        topped_up(repo, work)
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
    judges.flip = {next(c["repo"] for c in listed if not relevant(c["repo"]))}
    quiet(repo, "run-judge", "--work", str(work), "--judge", "audit", "--set", "qgs", "--rows", "1-12", "--today", TODAY, fetch=judges)
    judges.flip = set()
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
        audit = json.loads((work / f"{stratum}-stage1-audit.json").read_text())
        inputs = {json.loads(line)["order_rank"]: json.loads(line)["repo"] for line in (work / f"stage1-inputs-{stratum}-brief.jsonl").read_text().splitlines()}
        judges.flip = {inputs[audit["near"][0]]}
        quiet(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "screening-A", "--set", "stage1-audit", "--today", TODAY, fetch=judges)
        judges.flip = set()
        from study_stage1_audit import flagged
        flags = flagged(work, stratum, OPUS)[1]
        checks = work / f"saved-{stratum}-checks.json"
        checks.write_text(json.dumps({str(r): "excluded" for r in flags}))
        quiet(repo, "import-audit-checks", "--work", str(work), "--stratum", stratum, "--checks", str(checks))
        checks.unlink()


def stage2_screened(repo, work, judges, limit=None):
    quiet(repo, "plan-stage2", "--work", str(work), *(("--limit", str(limit)) if limit else ()))
    for stratum in STRATA:
        quiet(repo, "fetch-screening-inputs", "--work", str(work), "--stratum", stratum, "--set", "stage2", fetch=inputs_fetch())
        order = json.loads((work / f"{stratum}-stage2.json").read_text())["order"]
        blocks = [order[i:i + 50] for i in range(0, len(order), 50)]
        for side in "AB":
            for block in blocks:
                quiet(repo, "run-screening-session", "--work", str(work), "--stratum", stratum, "--side", side, "--ranks", f"{block[0]}-{block[-1]}", "--today", TODAY,
                      fetch=judges)


def cross_audited(repo, work, judges):
    quiet(repo, "draw-audit-sample", "--work", str(work))
    for stratum in STRATA:
        quiet(repo, "run-judge", "--work", str(work), "--stratum", stratum, "--judge", "audit", "--set", "audit", "--today", TODAY, fetch=judges)


def stage1_escalated(repo, work, judges):
    sample = json.loads((work / "calibration-set.json").read_text())
    missed = next(r["repo"] for r in sample["rows"] if r["stratum"] == "config" and eligible(r["repo"]) and description(r["repo"]))
    for stratum in STRATA:
        for model in ("claude-sonnet-5-5", "claude-opus-5-5"):
            for run in ("1", "2"):
                judges.flip = {missed} if (model, run) == ("claude-sonnet-5-5", "1") else set()
                quiet(repo, "run-stage1", "--work", str(work), "--stratum", stratum, "--shape", "brief", "--model", model, "--set", "calibration", "--run", run,
                      "--today", TODAY, fetch=judges)
    judges.flip = set()
    quiet(repo, "choose-stage1-rung", "--work", str(work), "--today", TODAY)
    drawn_and_labelled(repo, work, top_up=30)
    for stratum in STRATA:
        for model in ("claude-opus-5-5", "claude-sonnet-5-5"):
            quiet(repo, "run-stage1", "--work", str(work), "--stratum", stratum, "--shape", "brief", "--model", model, "--set", "held-out", "--today", TODAY, fetch=judges)


def v4_sweep(audit=True, escalate=False, top_up=False, pad=0):
    judges = ScriptedJudges()
    repo, work = calibrated_work(judges, top_up, pad)
    judged(repo, work, judges)
    if escalate:
        stage1_escalated(repo, work, judges)
    else:
        stage1_calibrated(repo, work, judges)
    topic_qgs(repo, work, judges)
    stage1_pooled(repo, work, judges)
    stage1_audited(repo, work, judges)
    stage2_screened(repo, work, judges, 150)
    if audit:
        cross_audited(repo, work, judges)
    quiet(repo, "export-sweep-data", "--work", str(work))
    from study_sweep_record import write_record
    write_record(repo, load_topic(repo, "demo"))
    return repo


if __name__ == "__main__":
    built = v4_sweep(audit="--no-audit" not in sys.argv, escalate="--escalate" in sys.argv, top_up="--top-up" in sys.argv, pad=1000 if "--large-pool" in sys.argv else 0)
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
