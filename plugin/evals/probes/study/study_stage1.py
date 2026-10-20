import hashlib
import json
from pathlib import Path

from study_agreement import clopper_pearson, lower_bound
from study_pool import ASSET, cache_name, read_json, work_file
from study_screening_core import read_jsonl
from study_session import STAGE1_BATCH_MAX
from study_session_prompt import STAGE1_TEMPLATE_SHA256
from study_topic import TopicError

SONNET, OPUS = "claude-sonnet-5-5", "claude-opus-5-5"
LADDER = ({"rung": 1, "models": [SONNET], "shape": "brief"}, {"rung": 2, "models": [OPUS, SONNET], "shape": "brief"},
          {"rung": 3, "models": [OPUS, SONNET], "shape": "paths"}, {"rung": 4, "models": [OPUS, SONNET], "shape": "readme"})
SHAPES = ("brief", "paths", "readme")
BATCH_MAX = STAGE1_BATCH_MAX
PATHS_MAX, README_LINES, README_CHARS = 40, 20, 1500
POSITIVES_NEEDED, SENSITIVITY_BOUND = 59, 0.95
FREEZE_FILE, RUNG_FILE = "stage1-freeze.json", "stage1-rung.json"
VERDICT_KEYS = ("repo", "description", "verdict", "problems", "why")


def inputs_name(stratum, shape):
    return f"stage1-inputs-{stratum}-{shape}.jsonl"


def pool_name(stratum, shape, model):
    return f"stage1-{stratum}-{shape}-{model}"


def calibration_name(stratum, shape, model, run):
    return f"judge-{stratum}-stage1-{shape}-{model}-run{run}"


def held_out_name(stratum, shape, model):
    return f"judge-{stratum}-stage1-{shape}-{model}-held-out"


def sha256_text(text):
    return hashlib.sha256(text.encode()).hexdigest()


def examples(topic):
    listed = topic.get("stage1_examples")
    if not isinstance(listed, list):
        raise TopicError(f"{topic['path']}: stage1_examples must list the worked examples the stage-1 prompt carries")
    problems = set(topic.get("problems") or [])
    for example in listed:
        if not isinstance(example, dict) or set(example) != set(VERDICT_KEYS) or example["verdict"] not in ("yes", "unsure", "no"):
            raise TopicError(f"{topic['path']}: every stage1_examples entry holds exactly {', '.join(VERDICT_KEYS)}, with a yes, unsure or no verdict")
        if not set(example["problems"]) <= problems or (example["verdict"] == "yes" and not example["problems"]):
            raise TopicError(f"{topic['path']}: stage1_examples entry {example['repo']} names problems outside the topic, or a yes without one")
    counts = {v: sum(e["verdict"] == v for e in listed) for v in ("yes", "unsure", "no")}
    if any(not 2 <= n <= 3 for n in counts.values()):
        raise TopicError(f"{topic['path']}: stage1_examples holds {counts}; the prompt carries 2 or 3 worked examples per verdict")
    return listed


def examples_text(topic):
    return "\n".join(json.dumps(e, ensure_ascii=False, sort_keys=True) for e in examples(topic))


def asset_paths(work, repo):
    tree = read_json(work_file(work, Path("cache") / "trees" / cache_name(repo)), None)
    if tree is None or tree.get("error"):
        raise TopicError(f"no fetched tree for {repo}; run fetch-repo-trees.py before building the paths shape")
    return sorted(p for p in tree.get("paths", []) if ASSET.search(p))[:PATHS_MAX]


def readme_lead(work, fetch, repo):
    cached = work_file(work, Path("cache") / "readmes" / (repo.lower().replace("/", "__") + ".md"))
    if cached.exists():
        text = cached.read_text()
    else:
        out, status, _ = fetch.run(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/readme"], timeout=120)
        if status != "ok" and "404" not in status:
            raise TopicError(f"README of {repo}: {status}; build the readme shape again")
        text = out if status == "ok" else ""
        target = Path(work) / "cache" / "readmes" / cached.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    return "\n".join(text.splitlines()[:README_LINES])[:README_CHARS]


def stage1_row(work, stratum, row, shape, fetch=None):
    out = {"order_rank": row["order_rank"], "repo": row["repo"], "description": (row.get("description") or "").strip()}
    if shape in ("paths", "readme") and stratum == "config":
        out["asset_paths"] = asset_paths(work, row["repo"])
    if shape == "readme":
        out["readme_lead"] = readme_lead(work, fetch, row["repo"])
    return out


def auto_pass(row):
    return not (row["description"] or row.get("asset_paths") or row.get("readme_lead") or row.get("readme_lead_sha256"))


def build_inputs(work, stratum, shape, fetch):
    if shape not in SHAPES:
        raise TopicError(f"shape {shape!r} is not one of {', '.join(SHAPES)}")
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order:
        raise TopicError(f"no {stratum}-screening-order.jsonl in {work}; export the whole pool with export-screening-order.py --all")
    rows = [stage1_row(work, stratum, r, shape, fetch) for r in order]
    target = Path(work) / inputs_name(stratum, shape)
    target.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return rows


def stage1_inputs(folder, stratum, shape):
    rows = {r["order_rank"]: r for r in read_jsonl(Path(folder), inputs_name(stratum, shape))}
    if not rows:
        raise TopicError(f"no {inputs_name(stratum, shape)} in {folder}; build it with build-stage1-inputs.py")
    return rows


def freeze(topic, work, strata, today):
    work = Path(work)
    if (work / FREEZE_FILE).exists():
        raise TopicError(f"{work / FREEZE_FILE} already exists; the stage-1 ladder is frozen once")
    labelled = sorted(p.name for p in work.glob("*-labels.json"))
    if labelled:
        raise TopicError(f"{', '.join(labelled)} already hold calibration labels; the ladder must be frozen before any label is read")
    packets = {}
    for stratum in strata:
        packet = work / f"stage1-packet-{stratum}.md"
        if not packet.is_file():
            raise TopicError(f"no {packet.name} in {work}; the stage-1 packet lists the problems and the task")
        packets[stratum] = hashlib.sha256(packet.read_bytes()).hexdigest()
    return {"ladder": [dict(r) for r in LADDER], "examples_sha256": sha256_text(examples_text(topic)), "packets": packets, "template_sha256": STAGE1_TEMPLATE_SHA256,
            "batch_max": BATCH_MAX, "date": today}


def read_freeze(folder):
    path = Path(folder) / FREEZE_FILE
    if not path.is_file():
        raise TopicError(f"no {FREEZE_FILE} in {folder}; freeze the stage-1 ladder with freeze-stage1.py before any calibration label is read")
    frozen = json.loads(path.read_text())
    if frozen.get("ladder") != [dict(r) for r in LADDER]:
        raise TopicError(f"{path} froze another ladder than the toolchain's")
    return frozen


def verdicts(folder, name):
    return {r["order_rank"]: r for r in read_jsonl(Path(folder), f"{name}.jsonl")}


def rung_run(folder, rung, run, labelled, held_out=False):
    per_stratum, passed = {}, {}
    for stratum in sorted({r["stratum"] for r in labelled}):
        rows = [r for r in labelled if r["stratum"] == stratum]
        inputs = stage1_inputs(folder, stratum, rung["shape"])
        answers = {m: verdicts(folder, held_out_name(stratum, rung["shape"], m) if held_out else calibration_name(stratum, rung["shape"], m, run)) for m in rung["models"]}
        for r in rows:
            row = inputs.get(r["order_rank"])
            if row is None or row["repo"].lower() != r["repo"].lower():
                raise TopicError(f"calibration row {r['id']} ({r['repo']}) is not row {r['order_rank']} of {inputs_name(stratum, rung['shape'])}")
            if auto_pass(row):
                passed[r["id"]] = True
                continue
            missing = [m for m in rung["models"] if r["order_rank"] not in answers[m]]
            if missing:
                return None
            passed[r["id"]] = any(answers[m][r["order_rank"]]["verdict"] != "no" for m in rung["models"])
        positives = [r for r in rows if r["user"]["decision"] == "eligible"]
        hits = sum(passed[r["id"]] for r in positives)
        per_stratum[stratum] = {"positives": len(positives), "passed": hits, "interval": clopper_pearson(hits, len(positives)) if positives else None,
                                "pass_rate": sum(passed[r["id"]] for r in rows) / len(rows)}
    positives = [r for r in labelled if r["user"]["decision"] == "eligible"]
    hits = sum(passed[r["id"]] for r in positives)
    return {"positives": len(positives), "passed": hits, "missed": sorted(r["repo"] for r in positives if not passed[r["id"]]),
            "lower": lower_bound(hits, len(positives)) if positives else 0.0, "strata": per_stratum, "rows": passed}


def choose_rung(folder, labelled):
    read_freeze(folder)
    positives = sum(r["user"]["decision"] == "eligible" for r in labelled)
    if positives < POSITIVES_NEEDED:
        raise TopicError(f"the calibration labels hold {positives} positives pooled, fewer than {POSITIVES_NEEDED}; draw the top-up batch "
                         "(draw-calibration-set.py --top-up) so it joins the pooled bound")
    tried = []
    for rung in LADDER:
        runs = [rung_run(folder, rung, n, labelled) for n in (1, 2)]
        if None in runs:
            break
        meets = all(r["lower"] >= SENSITIVITY_BOUND for r in runs)
        differ = sum(runs[0]["rows"][i] != runs[1]["rows"][i] for i in runs[0]["rows"])
        tried.append({"rung": rung["rung"], "runs": [{k: v for k, v in r.items() if k != "rows"} for r in runs], "differ": differ, "rows": len(runs[0]["rows"]),
                      "meets": meets})
        if meets:
            return {"rung": rung["rung"], "tried": tried}
    detail = "; ".join(f"rung {t['rung']} lower bounds {[round(r['lower'], 3) for r in t['runs']]}" for t in tried) or "no rung was run twice on the calibration set"
    raise TopicError(f"no stage-1 rung meets the pass rule yet ({detail}); run the next rung, or a rung whose runs miss calibration rows, twice on every calibration "
                     "row with run-stage1.py --set calibration, which skips the rows a run already judged")


def ladder_rung(number):
    return next(r for r in LADDER if r["rung"] == number)


def held_out_check(folder, rung_number, rows):
    rung = ladder_rung(rung_number)
    result = rung_run(folder, rung, None, rows, held_out=True)
    if result is None:
        raise TopicError(f"the held-out batch is not judged by every model of rung {rung_number}; run run-stage1.py --set held-out for {', '.join(rung['models'])}")
    if result["missed"]:
        raise TopicError(f"rung {rung_number} missed {len(result['missed'])} held-out positives ({', '.join(result['missed'])}); it is not confirmed, so stage 1 cannot run on the pool")
    return result


def option(model):
    return {"cli": "claude", "model": model}
