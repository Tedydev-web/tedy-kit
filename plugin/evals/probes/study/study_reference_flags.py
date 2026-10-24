import contextlib
import hashlib
import json
from pathlib import Path

from study_agreement import cohen_kappa, rounded
from study_calibration_set import LABELLED, pinned_inputs, row_date, set_file
from study_protocol import FREEZE_FILE
from study_reference_labels import checked_reply, flags_file, packet_rows, read_session, reference_option, row_label, session_key
from study_session import agy_lists, model_family
from study_session_prompt import required_sweep_date
from study_stage1 import LADDER
from study_topic import TopicError, flaggers

FIELDS = ("eligibility", "problems", *LABELLED)
STEP = {"Relevance": 0.5}
AGY_EXTENSIONS = (("mcp", "context-mode", "context_mode_enabled"), ("plugin", "ponytail", "ponytail_enabled"))
RETEST_FAMILY = ("same family as the reference: a second independent pass of it (test-retest) catches its stochastic errors, not its systematic same-family "
                 "errors")


def flagger_key(batch, stratum, option):
    return f"{session_key(batch, stratum)}-flagger-{option['model']}" + ("-pass2" if option.get("retest") else "")


def differs(reference, flagger):
    changed = {"eligibility"} if (reference["decision"] == "eligible") != (flagger["decision"] == "eligible") else set()
    changed |= {"problems"} if reference["problems"] != flagger["problems"] else set()
    changed |= {c for c in LABELLED if abs(reference[c] - flagger[c]) >= STEP.get(c, 1)}
    return [f for f in FIELDS if f in changed]


def rubric_criteria(fields):
    return [c for c in (*LABELLED, "problems", "eligibility") if c in fields]


def agy_switch(fetch, kind, name, state):
    status = fetch.run(["agy", kind, state, name], timeout=60)[1]
    if status != "ok":
        raise TopicError(f"agy {kind} {state} {name}: {status}")


@contextlib.contextmanager
def agy_window(fetch):
    before, switched = agy_lists(fetch), []
    try:
        for kind, name, key in AGY_EXTENSIONS:
            if before[key]:
                agy_switch(fetch, kind, name, "disable")
                switched.append((kind, name))
        during = agy_lists(fetch)
        still = [name for _, name, key in AGY_EXTENSIONS if during[key]]
        if still:
            raise TopicError(f"agy still lists {', '.join(still)} as enabled after the disable; the flagger run does not start")
        yield
    finally:
        failed = []
        for kind, name in switched:
            try:
                agy_switch(fetch, kind, name, "enable")
            except TopicError as error:
                failed.append(str(error))
        if failed:
            raise TopicError(f"agy left disabled after the flagger run; enable them by hand: {'; '.join(failed)}")
        if switched and agy_lists(fetch) != before:
            raise TopicError("agy mcp list or agy plugin list differs from before the flagger run; check them by hand")


def first_labels(work, sample, key, option, packets, problems, dates, need_all):
    meta = Path(work) / "meta.json"
    sessions = (json.loads(meta.read_text()).get("sessions") or {}) if meta.is_file() else {}
    strata = sample["rows_per_stratum"]
    replies = {s: read_session(work, key(s), option, packets[s]) if need_all or key(s) in sessions else {} for s in strata}
    refused = {(s, r["rank"]) for s in strata for r in (sessions.get(key(s)) or {}).get("refused") or []}
    labels = {}
    for row in sample["rows"]:
        reply = replies[row["stratum"]].get(row["order_rank"])
        if reply is None:
            continue
        checked_reply(f"{row['id']} ({key(row['stratum'])})", reply, row["repo"], problems)
        labels[row["id"]] = row_label(row["id"], reply, {}, packets[row["stratum"]][row["order_rank"]], dates[row["id"]])[0]
    return labels, refused, any(key(s) in sessions for s in strata)


def flagger_entry(role, option, keys, sample, reference, labels, refused):
    entry = {"role": role, "cli": option["cli"], "model": option["model"], "same_family": model_family(option["model"]) == model_family(reference["model"]),
             **({"family": RETEST_FAMILY} if option.get("retest") else {}), "sessions": keys}
    rows = sample["rows"]
    entry["unflagged_by_refusal"] = [r["id"] for r in rows if r["id"] not in labels and (r["stratum"], r["order_rank"]) in refused]
    pending = [r["id"] for r in rows if r["id"] not in labels and r["id"] not in entry["unflagged_by_refusal"]]
    if pending:
        raise TopicError(f"{option['model']} has neither answered nor refused rows {pending[:10]}; finish its run with run-judge.py --judge flagger first")
    fields = {r["id"]: differs(reference["labels"][r["id"]], labels[r["id"]]) for r in rows if r["id"] in labels}
    entry["answered"] = len(fields)
    entry["strata"] = {}
    for stratum in sample["rows_per_stratum"]:
        answered = [i for i in fields if i in {r["id"] for r in rows if r["stratum"] == stratum}]
        flagged = {f: sum(f in fields[i] for i in answered) for f in FIELDS}
        entry["strata"][stratum] = {"answered": len(answered), "flagged": flagged, "rate": {f: rounded(n / len(answered)) if answered else None for f, n in flagged.items()}}
    pairs = [(reference["labels"][i]["decision"] == "eligible", labels[i]["decision"] == "eligible") for i in fields]
    entry["eligibility_kappa"] = rounded(cohen_kappa(pairs)[1]) if pairs else None
    entry["rows"] = [{"id": r["id"], "stratum": r["stratum"], "order_rank": r["order_rank"], "fields": fields[r["id"]]} for r in rows if fields.get(r["id"])]
    return entry


def write_flags(topic, work, batch):
    work = Path(work)
    path = work / set_file(batch)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; flags compare the reference and its flaggers on a drawn calibration, top-up or held-out batch")
    sample, option, problems = json.loads(path.read_text()), reference_option(topic), topic.get("problems") or []
    held, when = pinned_inputs(work, sample), required_sweep_date(topic)
    dates = {r["id"]: row_date(held[r["id"]], when)["v"] for r in sample["rows"]}
    packets = {s: packet_rows(work, s) for s in sample["rows_per_stratum"]}
    labels = first_labels(work, sample, lambda s: session_key(batch, s), option, packets, problems, dates, True)[0]
    missing = [r["id"] for r in sample["rows"] if r["id"] not in labels]
    if missing:
        raise TopicError(f"no reference reply for {missing[:10]}; flags compare against the reference's first run, so run run-judge.py --judge reference first")
    reference = {"model": option["model"], "sessions": [session_key(batch, s) for s in sample["rows_per_stratum"]], "labels": labels}
    entries, trigger = [], {r["id"]: {f: False for f in FIELDS} for r in sample["rows"]}
    unflagged, asked = {r["id"]: [] for r in sample["rows"]}, {r["id"]: set() for r in sample["rows"]}
    for role, listed in flaggers(topic, [m for rung in LADDER for m in rung["models"]]).items():
        for flagger in listed:
            run = {k: v for k, v in flagger.items() if k != "retest"}
            key = lambda s, flagger=flagger: flagger_key(batch, s, flagger)
            keys = [key(s) for s in sample["rows_per_stratum"]]
            found, refused, ran = first_labels(work, sample, key, run, packets, problems, dates, False)
            if not ran:
                entries.append({"role": role, "cli": flagger["cli"], "model": flagger["model"], "sessions": keys, "not_run": "no session recorded"})
                continue
            entry = flagger_entry(role, flagger, keys, sample, reference, found, refused)
            entries.append(entry)
            if role == "rubric_trigger":
                for row in entry["rows"]:
                    trigger[row["id"]].update({f: True for f in row["fields"]})
                    asked[row["id"]].update(rubric_criteria(row["fields"]))
                for row_id in entry["unflagged_by_refusal"]:
                    unflagged[row_id].append(flagger["model"])
    routed = not (work / FREEZE_FILE).is_file()
    rows = [{"id": r["id"], "stratum": r["stratum"], "order_rank": r["order_rank"], "criteria": trigger[r["id"]],
             **({"unflagged_by_refusal": unflagged[r["id"]]} if unflagged[r["id"]] else {})} for r in sample["rows"]]
    rubric = [{"id": r["id"], "stratum": r["stratum"], "order_rank": r["order_rank"], "criteria": rubric_criteria(asked[r["id"]])}
              for r in sample["rows"] if asked[r["id"]]]
    out = {"batch": batch, "set_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "reference": {k: reference[k] for k in ("model", "sessions")}, "fields": list(FIELDS),
           "routed": routed, **({} if routed else {"for_the_record": f"{FREEZE_FILE} exists and no rubric wording enters after it; these flags are reported, never routed"}),
           "flaggers": entries, "rows": rows, "rubric_rows": rubric if routed else []}
    (work / flags_file(batch)).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out, flags_file(batch)
