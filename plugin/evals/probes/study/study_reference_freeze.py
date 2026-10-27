import hashlib
import json
from pathlib import Path

from study_calibration_set import BATCHES, labelled, labels_file, set_file
from study_citation_check import CORRECTION_DIR, check_holds
from study_protocol import FREEZE_FILE as PROTOCOL_FILE
from study_reference_flags import flagger_key
from study_reference_labels import cites_file, flags_file, notes_file, outcomes_file, reference_option, rerun_keys, session_key
from study_reference_packet import BUNDLE_FILE
from study_screening_core import read_jsonl
from study_session import canonical_sha256
from study_stage1 import HELD_OUT
from study_topic import TopicError, flaggers

OUTCOMES = ("rule", "asked", "contested")
OUTCOME_KEYS = {"id", "stratum", "order_rank", "outcome", "question", "notes", "criteria"}
AFTER_PROTOCOL = "not run: after protocol freeze"


def freeze_file(batch):
    return f"reference-freeze-{batch}.json"


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def optional_sha256(path):
    return sha256_file(path) if Path(path).is_file() else None


def session_hashes(work, sessions, key):
    if key not in sessions:
        raise TopicError(f"meta.json records no session {key}")
    return {"session_sha256": canonical_sha256(sessions[key]), "rows_sha256": optional_sha256(Path(work) / f"{key}.jsonl")}


def block_packets(sessions, keys):
    return {b.get("packet_sha256") for k in keys for b in sessions[k].get("blocks") or []}


def rerun_round(key):
    return int(key.rsplit("-notes-", 1)[1]) if "-notes-" in key else 0


def reference_part(topic, work, batch, sample, labels, sessions):
    option = reference_option(topic)
    found = labels.get("labeller")
    if not isinstance(found, dict) or found.get("kind") != "reference":
        raise TopicError(f"{labels_file(batch)} carries no reference labeller; derive-reference-labels.py writes the labels a freeze locks")
    if any(found.get(k) != option.get(k) for k in ("cli", "model", "effort")):
        raise TopicError(f"{labels_file(batch)} was labelled by {found.get('cli')} {found.get('model')} (effort {found.get('effort')}); the topic's reference is "
                         f"{option['cli']} {option['model']} (effort {option.get('effort')})")
    keys = sorted(k for s in sample["rows_per_stratum"] for k in [session_key(batch, s), *rerun_keys(work, batch, s)])
    if sorted(found.get("sessions") or []) != keys:
        raise TopicError(f"{labels_file(batch)} was derived from sessions {found.get('sessions')}, the work folder holds {keys}; derive the labels again")
    if found.get("notes_sha256") != optional_sha256(work / notes_file(batch)):
        raise TopicError(f"{notes_file(batch)} changed after {labels_file(batch)} was derived; re-run its rows and derive the labels again")
    first = [k for k in keys if not rerun_round(k)]
    before = block_packets(sessions, first)
    if len(before) != 1 or None in before:
        raise TopicError(f"the first-run reference blocks of {batch} read {len(before)} bundles ({sorted(map(str, before))}); a batch's first run reads one bundle")
    latest = max(map(rerun_round, keys))
    read = block_packets(sessions, [k for k in keys if rerun_round(k) == latest])
    after = optional_sha256(work / BUNDLE_FILE)
    if read != {after}:
        raise TopicError(f"a rubric edit is pending: {BUNDLE_FILE} (sha256 {str(after)[:16]}) is not the bundle the latest reference round of {batch} read; re-run the "
                         "rows it selects with run-judge.py --rerun-notes and derive the labels again")
    return {"cli": option["cli"], "model": option["model"], "effort": option.get("effort"), "sessions": {k: session_hashes(work, sessions, k) for k in keys}}, \
        {"before": before.pop(), "after": after}


def flagger_part(work, batch, sample, sessions, option, role):
    model, answered, unflagged, missing, hashes = option["model"], 0, [], [], {}
    for stratum in sample["rows_per_stratum"]:
        key = flagger_key(batch, stratum, option)
        rows = {r.get("order_rank") for r in read_jsonl(Path(work), f"{key}.jsonl")}
        refused = {r.get("rank") for r in (sessions.get(key) or {}).get("refused") or []}
        if key in sessions:
            hashes[key] = session_hashes(work, sessions, key)
        for row in (r for r in sample["rows"] if r["stratum"] == stratum):
            if row["order_rank"] in rows:
                answered += 1
            elif row["order_rank"] in refused:
                unflagged.append(row["id"])
            else:
                missing.append(row["id"])
    if not hashes:
        return None
    if missing:
        raise TopicError(f"flagger {model} has neither answered nor twice refused {len(missing)} rows of {batch} ({', '.join(missing[:5])}); finish its run before the freeze")
    lists = [b["agy_lists"] for k in sorted(hashes) for b in sessions[k].get("blocks") or [] if b.get("agy_lists")]
    return {"role": role, "sessions": hashes, "answered": answered, "unflagged_by_refusal": unflagged,
            "agy_lists": {"before": lists[0]["before"], "after": lists[-1]["after"]} if lists else None}


def flagger_parts(topic, work, batch, sample, sessions, protocol, without):
    out, absent = {}, []
    for role, options in flaggers(topic).items():
        for option in options:
            out[option["model"]] = flagger_part(work, batch, sample, sessions, option, role)
            if out[option["model"]] is None:
                absent.append(option["model"])
    if without is not None and (not without.strip() or not absent):
        raise TopicError("--without-flaggers records, in a non-empty reason, why a flagger did not run" + ("" if absent else "; every flagger ran on this batch"))
    if absent and not protocol and without is None:
        raise TopicError(f"flaggers {', '.join(absent)} have not run on {batch}; run them, or freeze with --without-flaggers \"<reason>\" once the user chose the no-flagger "
                         "fallback")
    return {m: part if part is not None else (AFTER_PROTOCOL if protocol else f"not run: {without}") for m, part in out.items()}


def read_json(path, what, kind=dict):
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise TopicError(f"{Path(path).name}: {what} is not readable JSON ({error})") from error
    if not isinstance(data, kind):
        raise TopicError(f"{Path(path).name}: {what} must be a JSON {'object' if kind is dict else 'list'}")
    return data


def outcome_rows(work, batch, ids):
    path = work / outcomes_file(batch)
    if not path.is_file():
        return {}
    data = read_json(path, "the rubric outcomes")
    rows = data.get("rows")
    if not isinstance(rows, list):
        raise TopicError(f"{path.name} holds {{\"rows\": [...]}}")
    notes = read_json(work / notes_file(batch), "the notes", list) if (work / notes_file(batch)).is_file() else []
    out = {}
    for number, row in enumerate(rows, 1):
        where = f"{path.name} row {number}"
        if not isinstance(row, dict) or set(row) != OUTCOME_KEYS:
            raise TopicError(f"{where} holds exactly {', '.join(sorted(OUTCOME_KEYS))}")
        if row["id"] not in ids or (row["stratum"], row["order_rank"]) != ids[row["id"]]:
            raise TopicError(f"{where}: {row['id']!r} ({row['stratum']} rank {row['order_rank']}) is no rubric row of {flags_file(batch)}")
        if row["id"] in out:
            raise TopicError(f"{where}: {row['id']} has a second outcome; a rubric row has exactly one")
        if row["outcome"] not in OUTCOMES:
            raise TopicError(f"{where}: outcome {row['outcome']!r} is not one of {', '.join(OUTCOMES)}")
        if not isinstance(row["notes"], list) or any(isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= len(notes) for n in row["notes"]):
            raise TopicError(f"{where}: notes {row['notes']!r} are not note numbers, from 1, of {notes_file(batch)}")
        question = row["question"]
        if question is not None and (isinstance(question, bool) or not isinstance(question, (str, int)) or question == ""):
            raise TopicError(f"{where}: question {question!r} is a question id or null")
        if row["outcome"] == "asked" and question is None:
            raise TopicError(f"{where}: an asked row names its question")
        if not isinstance(row["criteria"], dict) or not row["criteria"]:
            raise TopicError(f"{where}: criteria {row['criteria']!r} is the worksheet's non-empty outcome per flagged criterion")
        out[row["id"]] = row
    return out


def rubric_part(work, batch, sample, ran, protocol):
    path = work / flags_file(batch)
    if not path.is_file():
        if ran:
            raise TopicError(f"no {path.name} in {work}; flaggers ran on {batch}, so their flags are derived before the freeze")
        return {"flags_sha256": None, "outcomes_sha256": None, "flagged": 0, "rule": 0, "asked": 0, "rerun": 0, "contested": 0, "contested_rows": []}
    listed = read_json(path, "the flags").get("rubric_rows")
    drawn = {r["id"]: (r["stratum"], r["order_rank"]) for r in sample["rows"]}
    if not isinstance(listed, list) or any(not isinstance(r, dict) or drawn.get(r.get("id")) != (r.get("stratum"), r.get("order_rank")) for r in listed):
        raise TopicError(f"{path.name} rubric_rows must list rows of {set_file(batch)} by id, stratum and order_rank")
    ids = {r["id"]: drawn[r["id"]] for r in listed}
    outcomes = outcome_rows(work, batch, ids)
    reran = {(s, r.get("order_rank")) for s in sample["rows_per_stratum"] for k in rerun_keys(work, batch, s) for r in read_jsonl(work, f"{k}.jsonl")}
    counts = {o: 0 for o in OUTCOMES}
    contested, rerun = [], 0
    for key, where in ids.items():
        row = outcomes.get(key)
        if row is None and not protocol:
            raise TopicError(f"rubric row {key} has no outcome in {outcomes_file(batch)}: settled by rule, asked, or contested")
        outcome = row["outcome"] if row else "contested"
        if row and row["notes"] and where not in reran:
            raise TopicError(f"rubric row {key} names notes {row['notes']} but no reference-{batch}-{where[0]}-notes-<n>.jsonl re-ran it")
        counts[outcome] += 1
        rerun += bool(row and row["notes"])
        if outcome == "contested":
            contested.append(key)
    return {"flags_sha256": sha256_file(path), "outcomes_sha256": optional_sha256(work / outcomes_file(batch)), "flagged": len(ids), **counts, "rerun": rerun,
            "contested_rows": contested}


def freeze_batch(topic, repo, work, batch, today, without=None):
    work = Path(work)
    if batch not in BATCHES[:2] and not HELD_OUT.match(batch):
        raise TopicError(f"batch {batch!r} is not calibration, top-up or a held-out batch")
    path = work / freeze_file(batch)
    if path.exists():
        raise TopicError(f"{path.name} already exists; a freeze is never rewritten, a later batch gets its own")
    labelled(work, (batch,))
    sample = json.loads((work / set_file(batch)).read_text())
    labels = json.loads((work / labels_file(batch)).read_text())
    labels_sha = sha256_file(work / labels_file(batch))
    cites = work / cites_file(batch)
    if not cites.is_file() or read_json(cites, "the cites").get("labels_sha256") != labels_sha:
        raise TopicError(f"{cites.name} was not written with the current {labels_file(batch)}; derive the labels again")
    criteria = Path(repo) / sample["criteria"]
    if not criteria.is_file():
        raise TopicError(f"no criteria file at {criteria}")
    criteria_sha = sha256_file(criteria)
    protocol = read_json(work / PROTOCOL_FILE, "the protocol freeze") if (work / PROTOCOL_FILE).is_file() else None
    if protocol and criteria_sha not in {s.get("criteria_sha256") for s in (protocol.get("strata") or {}).values()}:
        raise TopicError(f"a rubric edit is pending: {sample['criteria']} differs from the criteria {PROTOCOL_FILE} pinned; no criteria edit lands after the protocol freeze")
    meta = work / "meta.json"
    sessions = (read_json(meta, "the sessions").get("sessions") or {}) if meta.is_file() else {}
    reference, anchors = reference_part(topic, work, batch, sample, labels, sessions)
    flagged = flagger_parts(topic, work, batch, sample, sessions, protocol is not None, without)
    rubric = rubric_part(work, batch, sample, any(isinstance(v, dict) for v in flagged.values()), protocol is not None)
    out = {"batch": batch, "set_sha256": sha256_file(work / set_file(batch)), "labels_sha256": labels_sha, "cites_sha256": sha256_file(cites),
           "notes_sha256": optional_sha256(work / notes_file(batch)), "anchors_sha256": anchors, "criteria_sha256_at_freeze": criteria_sha, "reference": reference,
           "flaggers": flagged, "rubric": rubric, "frozen": today, **({"correction": 1} if batch == "calibration" and (work / CORRECTION_DIR).is_dir() else {})}
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def frozen_sha(work, batch):
    path = Path(work) / freeze_file(batch)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; the {batch} labels are frozen with freeze-reference.py before any judge or stage-1 calibration run reads them")
    freeze = read_json(path, "the freeze")
    for name, key in ((set_file(batch), "set_sha256"), (labels_file(batch), "labels_sha256")):
        if optional_sha256(Path(work) / name) != freeze.get(key):
            raise TopicError(f"{name} differs from the one {path.name} froze; nothing after the freeze changes a label")
    return sha256_file(path)


def require_frozen(topic, work, batches):
    if topic.get("reference") is None:
        return {}
    out = {batch: frozen_sha(work, batch) for batch in batches}
    if "calibration" in out:
        check_holds(topic, work, out["calibration"])
    return out
