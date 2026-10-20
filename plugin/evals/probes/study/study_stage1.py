import hashlib
import json
import re
from pathlib import Path

from study_agreement import clopper_pearson, lower_bound
from study_pool import ASSET, cache_name, read_json, work_file
from study_screening_core import read_jsonl
from study_session import STAGE1_BATCH_MAX, canonical_sha256
from study_session_prompt import STAGE1_TEMPLATE_SHA256
from study_topic import TopicError

SONNET, OPUS = "claude-sonnet-5-5", "claude-opus-5-5"
LADDER = ({"rung": 1, "models": [SONNET], "shape": "brief"}, {"rung": 2, "models": [OPUS, SONNET], "shape": "brief"},
          {"rung": 3, "models": [OPUS, SONNET], "shape": "paths"}, {"rung": 4, "models": [OPUS, SONNET], "shape": "readme"})
SHAPES = ("brief", "paths", "readme")
BATCH_MAX = STAGE1_BATCH_MAX
PATHS_MAX, README_LINES, README_CHARS = 40, 20, 1500
POSITIVES_NEEDED, SENSITIVITY_BOUND, HELD_OUT_POSITIVES = 59, 0.95, 10
HELD_OUT = re.compile(r"^held-out(?:-\d+)?$")
FREEZE_FILE, RUNG_FILE = "stage1-freeze.json", "stage1-rung.json"
VERDICT_KEYS = ("repo", "description", "verdict", "problems", "why")


def inputs_name(stratum, shape):
    return f"stage1-inputs-{stratum}-{shape}.jsonl"


def pool_name(stratum, shape, model):
    return f"stage1-{stratum}-{shape}-{model}"


def calibration_name(stratum, shape, model, run):
    return f"judge-{stratum}-stage1-{shape}-{model}-run{run}"


def held_out_batches(folder):
    found = [p.name[:-len("-set.json")] for p in Path(folder).glob("held-out*-set.json")]
    return sorted((b for b in found if HELD_OUT.match(b)), key=lambda b: int(b.rsplit("-", 1)[1]) if b[-1].isdigit() else 1)


def held_out_labels_sha256(folder):
    return {b: hashlib.sha256((Path(folder) / f"{b}-labels.json").read_bytes()).hexdigest() for b in held_out_batches(folder)}


def held_out_binding(folder, sessions, strata, rung_number):
    expected, rung = held_out_labels_sha256(folder), ladder_rung(rung_number)
    for stratum in strata:
        for model in rung["models"]:
            key = pool_name(stratum, rung["shape"], model)
            if any(b.get("held_out_labels_sha256") != expected for b in (sessions.get(key) or {}).get("blocks") or []):
                raise TopicError(f"{key}: the stage-1 pool run was not made after the current held-out labels ({', '.join(f'{b}-labels.json' for b in expected)}); the rung is "
                                 "confirmed on the labels as they stood when stage 1 ran on the pool")


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
    pool = {(r["order_rank"], r["repo"].lower()) for r in read_jsonl(Path(folder), f"{stratum}-screening-order.jsonl")}
    held = {(rank, r["repo"].lower()) for rank, r in rows.items()}
    if pool != held:
        shown = sorted(r for _, r in pool ^ held)[:10]
        raise TopicError(f"{inputs_name(stratum, shape)} is not the final {stratum} pool of {stratum}-screening-order.jsonl (differs on {shown}); build it again after "
                         "the config-pool channel and the snowball joined, before stage 1 runs")
    return rows


def sessions(folder):
    path = Path(folder) / "meta.json"
    return (json.loads(path.read_text()).get("sessions") or {}) if path.is_file() else {}


def row_hash(row):
    plain = {k: v for k, v in row.items() if k != "row_sha256"}
    if "row_sha256" in row and "readme_lead_sha256" not in row and canonical_sha256(plain) != row["row_sha256"]:
        raise TopicError(f"stage-1 inputs row {row['order_rank']} does not hash to its recorded row_sha256")
    return row.get("row_sha256") or canonical_sha256(plain)


def provenance(folder, name, model, shape, stratum, inputs, ranks):
    frozen = read_freeze(folder)
    entry = sessions(folder).get(name)
    if not entry or (entry.get("cli"), entry.get("model")) != ("claude", model):
        raise TopicError(f"{name}.jsonl has no claude {model} session in meta.json; only verdicts run-stage1.py recorded count")
    blocks = entry.get("blocks") or []
    expected = (shape, frozen["packets"][stratum], frozen["examples_sha256"], frozen["template_sha256"])
    if any((b.get("shape"), b.get("packet_sha256"), b.get("examples_sha256"), b.get("template_sha256")) != expected or len(b["ranks"]) > frozen["batch_max"] for b in blocks):
        raise TopicError(f"{name}: a block ran on another shape, packet, worked examples or prompt template than the stage-1 freeze, or over {frozen['batch_max']} rows")
    hashes = {int(r): h for b in blocks for r, h in b["row_sha256"].items()}
    wrong = sorted(r for r in ranks if r not in inputs or hashes.get(r) != row_hash(inputs[r]))
    if wrong:
        raise TopicError(f"{name}: ranks {wrong[:10]} were not judged on the rows {inputs_name(stratum, shape)} holds now")


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
        names = {m: held_out_name(stratum, rung["shape"], m) if held_out else calibration_name(stratum, rung["shape"], m, run) for m in rung["models"]}
        answers = {m: verdicts(folder, names[m]) for m in rung["models"]}
        for m, found in answers.items():
            if found:
                provenance(folder, names[m], m, rung["shape"], stratum, inputs, list(found))
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
    if result["positives"] < HELD_OUT_POSITIVES:
        raise TopicError(f"the held-out batches hold {result['positives']} positives, fewer than {HELD_OUT_POSITIVES}; draw more enriched rows with "
                         "draw-calibration-set.py --top-up before the rung is confirmed")
    if result["missed"]:
        raise TopicError(f"rung {rung_number} missed {len(result['missed'])} held-out positives ({', '.join(result['missed'])}); it is not confirmed, so stage 1 cannot run on the pool")
    return result


def option(model):
    return {"cli": "claude", "model": model}
