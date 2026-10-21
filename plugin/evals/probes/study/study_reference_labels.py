import hashlib
import json
import re
from pathlib import Path

from study_calibration_set import BATCHES, EXCLUDE_CODES, LABELLED, RATINGS, README_CUES, checked_label, cue_lines, import_labels, labels_file, pinned_inputs, row_date, set_file
from study_protocol import EMPTY_TABLE
from study_screening_core import COPYLIKE, MechanismTable, derive, read_jsonl
from study_session import canonical_sha256, session_header
from study_session_prompt import date_cell, required_sweep_date
from study_stage1 import HELD_OUT
from study_topic import TopicError, screened_strata, session_option

REPLY_KEYS = ("order_rank", "repo", "scores", "mechanisms", "decision", "decision_cite")
MECHANISM_KEYS = ("problem", "path", "why")
NOTE_KEYS = ("line", "quote", "criterion", "cue")
CITE = re.compile(r"(path|readme|fact):(.*)", re.S)
CITE_MAX = 200
FACT_CUE = re.compile(r"fact:((?:prefilled|evidence)\.[A-Za-z0-9_]+)")
README_CUE_NAMES = {f"{group}:{word}": word for group, words in README_CUES for word in words}
PURPOSE = re.compile(r"exclusion-audit-[1-9][0-9]*|stage1-flags|adjudication")
RERUN = re.compile(r"[1-9][0-9]*")
MISSING = object()


def reference_option(topic):
    if topic.get("reference") is None:
        raise TopicError(f"topic {topic['name']} names no reference; its labels are the user's, kept by import-calibration-labels.py")
    return session_option(topic, "reference", topic["reference"])


def session_key(batch, stratum, rerun=None):
    return f"reference-{batch}-{stratum}" + (f"-notes-{rerun}" if rerun else "")


def notes_file(batch):
    return f"reference-notes-{batch}.json"


def cites_file(batch):
    return f"{batch}-reference-cites.json"


def purpose_file(purpose):
    return f"{purpose}-reference-labels.json"


def field(row, dotted):
    value = row
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def normalised(text):
    return " ".join(text.split())


def checked_cite(where, cite):
    found = CITE.fullmatch(cite) if isinstance(cite, str) else None
    if not found or not found.group(2).strip() or (found.group(1) == "readme" and len(found.group(2)) > CITE_MAX):
        raise TopicError(f"{where}: cite {cite!r} is not path:<tree path>, readme:<verbatim README text of at most {CITE_MAX} characters> or fact:<packet field>")


def cite_holds(cite, packet):
    kind, _, value = cite.partition(":")
    if kind == "path":
        return value in (packet.get("tree") or [])
    if kind == "readme":
        return normalised(value) in normalised(packet.get("readme") or "")
    return field(packet, value) not in (MISSING, None)


def checked_reply(where, reply, repo, problems):
    if not isinstance(reply, dict) or set(reply) != set(REPLY_KEYS):
        raise TopicError(f"{where}: a reference reply row holds exactly {', '.join(REPLY_KEYS)}; the reply is refused, never patched")
    if reply["repo"] != repo:
        raise TopicError(f"{where}: the reply names {reply['repo']!r}, the row is {repo}")
    scores = reply["scores"]
    if not isinstance(scores, dict) or set(scores) != set(LABELLED):
        raise TopicError(f"{where}: scores hold exactly {', '.join(LABELLED)}; Date is computed by the toolchain")
    for criterion in LABELLED:
        cell = scores[criterion]
        if not isinstance(cell, dict) or set(cell) != {"v", "cite"} or isinstance(cell["v"], bool) or cell["v"] not in RATINGS:
            raise TopicError(f"{where}: {criterion} must be {{\"v\": 1, 0.5 or 0, \"cite\": ...}}, the reply gives {cell!r}")
        checked_cite(f"{where} {criterion}", cell["cite"])
    mechanisms = reply["mechanisms"]
    if not isinstance(mechanisms, list) or any(not isinstance(m, dict) or set(m) != set(MECHANISM_KEYS) or not all(isinstance(m[k], str) and m[k].strip() for k in MECHANISM_KEYS)
                                               for m in mechanisms):
        raise TopicError(f"{where}: every mechanism holds exactly a non-empty {', '.join(MECHANISM_KEYS)}")
    unknown = sorted({m["problem"] for m in mechanisms} - set(problems))
    if unknown:
        raise TopicError(f"{where}: problem ids {unknown} are not the topic's")
    decision = reply["decision"]
    if not (decision == "eligible" or (isinstance(decision, str) and decision.startswith("excluded: ") and decision[10:] in EXCLUDE_CODES)):
        raise TopicError(f"{where}: decision {decision!r}; it is eligible or excluded: <code>, the code one of {', '.join(EXCLUDE_CODES)}")
    checked_cite(f"{where} decision", reply["decision_cite"])


def counted(reply, packet, flags):
    kept = []
    for mechanism in reply["mechanisms"]:
        if mechanism["path"] not in (packet.get("tree") or []):
            flags.append(f"citation failed: mechanism {mechanism['path']}")
        elif not Path(mechanism["path"]).name.lower().startswith("readme"):
            kept.append(mechanism)
    return kept


def row_label(where, first, chosen, packet, date):
    flags, cites, label = [], {}, {}
    for criterion in LABELLED:
        cell = chosen.get(criterion, (None, first))[1]["scores"][criterion]
        held = cite_holds(cell["cite"], packet)
        label[criterion], cites[criterion] = cell["v"] if held else 0, cell["cite"]
        if not held:
            flags.append(f"citation failed: {criterion} {cell['cite']}")
    mechanisms = counted(chosen.get("Relevance", (None, first))[1], packet, flags)
    if label["Relevance"] == 1 and not mechanisms:
        label["Relevance"] = 0.5
        flags.append("Relevance 1 needs a mechanism outside a README at a path in the tree; Relevance kept at 0.5")
    label["problems"] = sorted({m["problem"] for m in mechanisms}) if label["Relevance"] == 1 else []
    copied = first["decision"].startswith("excluded: ") and first["decision"][10:] in COPYLIKE
    kept = copied and cite_holds(first["decision_cite"], packet)
    if kept:
        cites["decision"] = first["decision_cite"]
    elif copied:
        flags.append(f"citation failed: decision {first['decision_cite']}")
    scores = {**{c: {"v": label[c]} for c in LABELLED}, "Date": {"v": date}}
    label["decision"] = derive(MechanismTable(EMPTY_TABLE), "reference", {"A": {}, "B": {}}, "A",
                               {"order_rank": where, "scores": scores, "mechanisms": label["problems"], "decision": first["decision"] if kept else "eligible"})["decision"]
    rerun = {c: key for c, (key, _) in chosen.items()}
    return label, {"cites": cites, "mechanisms": mechanisms if label["Relevance"] == 1 else [], "flags": flags, **({"rerun": rerun} if rerun else {})}


def checked_notes(notes, lines, packets):
    if not isinstance(notes, list):
        raise TopicError("the notes file holds a list of notes")
    for number, note in enumerate(notes, 1):
        where = f"note {number}"
        if not isinstance(note, dict) or set(note) != set(NOTE_KEYS):
            raise TopicError(f"{where}: a note holds exactly {', '.join(NOTE_KEYS)}; a note never sets a value, the reference re-runs the rows its cue selects")
        line = note["line"]
        if isinstance(line, bool) or not isinstance(line, int) or not 1 <= line <= len(lines) or not lines[line - 1].strip() or note["quote"] != lines[line - 1]:
            raise TopicError(f"{where}: line {line!r} with its quote is not a verbatim non-empty line of the criteria file")
        if note["criterion"] not in LABELLED:
            raise TopicError(f"{where}: criterion {note['criterion']!r} is not one of {', '.join(LABELLED)}")
        fact = FACT_CUE.fullmatch(note["cue"]) if isinstance(note["cue"], str) else None
        if note["cue"] not in README_CUE_NAMES and not (fact and any(field(p, fact.group(1)) is not MISSING for p in packets)):
            raise TopicError(f"{where}: cue {note['cue']!r} is neither a frozen README cue nor a prefilled or evidence field of the packet rows")


def selects(note, packet):
    if note["cue"] in README_CUE_NAMES:
        return bool(cue_lines(packet.get("readme"), (README_CUE_NAMES[note["cue"]],)))
    return field(packet, note["cue"][5:]) not in (MISSING, None, False, "", [], {})


def read_session(work, key, option, packets):
    meta = Path(work) / "meta.json"
    session = (json.loads(meta.read_text()).get("sessions") or {}).get(key) if meta.is_file() else None
    if session is None:
        raise TopicError(f"meta.json records no session {key}; reference rows come only from run-judge.py --judge reference")
    header = session_header(option, False)
    if any(session.get(f) != header[f] for f in ("cli", "model", "effort")):
        raise TopicError(f"meta.json sessions.{key} ran {session.get('cli')} {session.get('model')} (effort {session.get('effort')}); the topic's reference is "
                         f"{header['cli']} {header['model']} (effort {header['effort']})")
    read = {r: (block.get("row_sha256") or {}).get(str(r)) for block in session.get("blocks") or [] for r in block.get("ranks") or []}
    rows = {}
    for reply in read_jsonl(Path(work), f"{key}.jsonl"):
        rank = reply.get("order_rank") if isinstance(reply, dict) else None
        if rank in rows or rank not in packets or read.get(rank) != canonical_sha256(packets[rank]):
            raise TopicError(f"{key}.jsonl rank {rank!r}: the reference inputs no longer hold the row the reference read, or the rank is repeated or has no inputs row")
        rows[rank] = reply
    return rows


def rerun_keys(work, batch, stratum):
    prefix = f"{session_key(batch, stratum)}-notes-"
    rounds = [p.stem[len(prefix):] for p in Path(work).glob(f"{prefix}*.jsonl")]
    return [session_key(batch, stratum, n) for n in sorted(int(n) for n in rounds if RERUN.fullmatch(n))]


def labeller(option, keys, notes_sha):
    return {"kind": "reference", **option, "sessions": sorted(keys), "notes_sha256": notes_sha}


def packet_rows(work, stratum):
    return {r["order_rank"]: r for r in read_jsonl(Path(work), f"reference-inputs-{stratum}.jsonl")}


def derive_batch(topic, repo, work, batch, criteria):
    work, option, problems = Path(work), reference_option(topic), topic.get("problems") or []
    sample_bytes = (work / set_file(batch)).read_bytes() if (work / set_file(batch)).is_file() else None
    if sample_bytes is None:
        raise TopicError(f"no {set_file(batch)} in {work}; draw it with draw-calibration-set.py")
    sample, when = json.loads(sample_bytes), required_sweep_date(topic)
    held = pinned_inputs(work, sample)
    packets = {s: packet_rows(work, s) for s in sample["rows_per_stratum"]}
    notes_path = work / notes_file(batch)
    notes = json.loads(notes_path.read_text()) if notes_path.is_file() else []
    checked_notes(notes, (Path(repo) / criteria).read_text().splitlines(), [p for s in packets.values() for p in s.values()])
    first, reruns, keys = {}, {}, []
    for stratum in sample["rows_per_stratum"]:
        keys.append(session_key(batch, stratum))
        first[stratum] = read_session(work, keys[-1], option, packets[stratum])
        reruns[stratum] = [(k, read_session(work, k, option, packets[stratum])) for k in rerun_keys(work, batch, stratum)]
        keys += [k for k, _ in reruns[stratum]]
    labels, records, used = {}, [], set()
    for row in sample["rows"]:
        stratum, rank, where = row["stratum"], row["order_rank"], row["id"]
        if rank not in first[stratum] or rank not in packets[stratum]:
            raise TopicError(f"{where}: no reference reply for {stratum} rank {rank} in {session_key(batch, stratum)}.jsonl; run run-judge.py --judge reference first")
        checked_reply(where, first[stratum][rank], row["repo"], problems)
        chosen = {}
        for number, note in enumerate(notes, 1):
            if not selects(note, packets[stratum][rank]):
                continue
            latest = [(k, rows[rank]) for k, rows in reruns[stratum] if rank in rows]
            if not latest:
                raise TopicError(f"{where}: note {number} selects the row and no session re-ran it; re-run it with run-judge.py --judge reference --rerun-notes")
            checked_reply(f"{where} ({latest[-1][0]})", latest[-1][1], row["repo"], problems)
            chosen[note["criterion"]] = latest[-1]
            used.add((stratum, rank))
        labels[where], record = row_label(where, first[stratum][rank], chosen, packets[stratum][rank], row_date(held[where], when)["v"])
        records.append({"id": where, "stratum": stratum, "order_rank": rank, **record})
    outside = sorted({(s, r) for s in first for r in first[s]} - {(r["stratum"], r["order_rank"]) for r in sample["rows"]})
    if outside:
        raise TopicError(f"reference replies for {outside[:10]} are rows {set_file(batch)} does not hold")
    extra = sorted((s, r) for s in reruns for _, rows in reruns[s] for r in rows if (s, r) not in used)
    if extra:
        raise TopicError(f"re-run rows {extra[:10]} are rows no note selects; a re-run value replaces a criterion only for the rows a note's cue selects")
    notes_sha = hashlib.sha256(notes_path.read_bytes()).hexdigest() if notes_path.is_file() else None
    import_labels(topic, work, {"sweep": sample["sweep"], "set_sha256": hashlib.sha256(sample_bytes).hexdigest(), "labels": labels}, batch, labeller(option, keys, notes_sha))
    labels_sha = hashlib.sha256((work / labels_file(batch)).read_bytes()).hexdigest()
    (work / cites_file(batch)).write_text(json.dumps({"batch": batch, "set_sha256": hashlib.sha256(sample_bytes).hexdigest(), "labels_sha256": labels_sha, "rows": records},
                                                     indent=1, ensure_ascii=False) + "\n")
    return records, labels_file(batch)


def derive_purpose(topic, work, purpose):
    work, option, problems = Path(work), reference_option(topic), topic.get("problems") or []
    if (work / notes_file(purpose)).exists():
        raise TopicError(f"{notes_file(purpose)}: notes apply to calibration-family batches only; {purpose} rows take the reference and the citation rule only")
    strata = [s for s in screened_strata(topic) if (work / f"{session_key(purpose, s)}.jsonl").is_file()]
    if not strata:
        raise TopicError(f"no {session_key(purpose, '<stratum>')}.jsonl in {work}; run run-judge.py --judge reference --batch {purpose} first")
    when, rows = required_sweep_date(topic), []
    for stratum in strata:
        packets = packet_rows(work, stratum)
        for rank, reply in sorted(read_session(work, session_key(purpose, stratum), option, packets).items()):
            where, packet = f"{purpose}-{stratum}-{rank}", packets[rank]
            checked_reply(where, reply, packet.get("repo"), problems)
            date = date_cell((packet.get("facts") or {}).get("pushed"), when)["v"]
            label, record = row_label(where, reply, {}, packet, date)
            rows.append({"stratum": stratum, "order_rank": rank, "repo": packet["repo"], "label": checked_label(where, label, problems, date), **record})
    out = {"purpose": purpose, "labeller": labeller(option, [session_key(purpose, s) for s in strata], None), "rows": rows}
    (work / purpose_file(purpose)).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return rows, purpose_file(purpose)


def derive_labels(topic, repo, work, batch, criteria):
    if batch in BATCHES[:2] or HELD_OUT.match(batch):
        return derive_batch(topic, repo, work, batch, criteria)
    if PURPOSE.fullmatch(batch):
        return derive_purpose(topic, work, batch)
    raise TopicError(f"batch {batch!r} is not a calibration-family batch (calibration, top-up, held-out[-<n>]) nor a reference purpose (exclusion-audit-<rung>, stage1-flags, "
                     "adjudication)")
