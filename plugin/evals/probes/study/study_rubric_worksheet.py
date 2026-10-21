import hashlib
import json
from pathlib import Path

from study_calibration_set import BATCHES, LABELLED, anchors, set_file
from study_protocol import FREEZE_FILE
from study_reference_labels import NOTED, checked_notes, checked_reply, cite_holds, notes_file, packet_rows, read_session, reference_option, selects, session_key
from study_reference_packet import bundle_text
from study_screening_core import COPYLIKE, read_jsonl
from study_stage1 import HELD_OUT
from study_topic import TopicError, flaggers

QUESTIONS_MAX = 5
FLAGGED = (*LABELLED, "problems", "eligibility", "decision")
ROW_KEYS = ("id", "stratum", "order_rank", "criteria")
CELLS = {1: 1, 0.5: 2, 0: 3}
RULE = ("Objectivity", "fact:prefilled.paid_tier_cues", "a hosted cloud or a paid tier")
DECISION_LINES = {"aggregator": ("**Aggregators.**", None), "copy": ("| Novelty for the kit |", 3), "dead": ("coded dead", None)}
OUTCOMES = ("rule", "asked", "contested")
NO_CODE = "none"
UNANCHORED = {"problems": "the problem ids differ under the same Relevance; no criteria line anchors them",
              "eligibility": "the eligibility differs with no criterion or decision code apart; no criteria line anchors it"}


def flags_file(batch):
    return f"reference-flags-{batch}.json"


def questions_file(batch):
    return f"rubric-questions-{batch}.md"


def wordings_file(batch):
    return f"rubric-wordings-{batch}.json"


def outcomes_file(batch):
    return f"rubric-outcomes-{batch}.json"


def batch_freeze_file(batch):
    return f"reference-freeze-{batch}.json"


def sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


def shown(value):
    return value if isinstance(value, str) else format(value, "g")


def rubric_rows(flags):
    listed = flags.get("rubric_rows") if isinstance(flags, dict) else None
    if not isinstance(listed, list):
        raise TopicError("the flags file holds rubric_rows, a list of {id, stratum, order_rank, criteria}; build it with the flag step")
    rows = []
    for number, row in enumerate(listed, 1):
        if (not isinstance(row, dict) or not set(ROW_KEYS) <= set(row) or not isinstance(row["criteria"], list) or not row["criteria"]
                or any(c not in FLAGGED for c in row["criteria"])):
            raise TopicError(f"rubric_rows[{number}] holds id, stratum, order_rank and a non-empty criteria list of {', '.join(FLAGGED)}")
        rows.append({"id": row["id"], "stratum": row["stratum"], "order_rank": row["order_rank"], "criteria": list(dict.fromkeys(row["criteria"]))})
    return rows


def reading(reply, criterion):
    if criterion != "decision":
        return reply["scores"][criterion]["v"]
    code = reply["decision"][10:] if reply["decision"].startswith("excluded: ") else NO_CODE
    return code if code in COPYLIKE else NO_CODE


def reasons(reply, criterion):
    if criterion == "decision":
        return [reply["decision"], reply["decision_cite"]]
    mechanisms = [f"{m['problem']} at {m['path']}: {m['why']}" for m in reply["mechanisms"]] if criterion == "Relevance" else []
    return [reply["scores"][criterion]["cite"], *mechanisms]


def parts(row, first, replies):
    def differing(criterion):
        return [(criterion, reading(first, criterion), reading(reply, criterion), model) for model, reply in replies if reading(reply, criterion) != reading(first, criterion)]
    found = []
    for name in row["criteria"]:
        if name in LABELLED:
            hits = differing(name)
            if not hits:
                raise TopicError(f"{row['id']}: no rubric-trigger flagger differs from the reference on {name}; build the flags again")
        elif name == "problems":
            hits = differing("Relevance") or [(name, None, None, None)]
        else:
            hits = differing("decision") or [h for c in LABELLED for h in differing(c)] or [("eligibility", None, None, None)]
        found += [h for h in hits if h not in found]
    return found


def anchor_lines(lines):
    start = next((i for i, text in enumerate(lines) if text.startswith("## GitHub assets")), None)
    if start is None:
        raise TopicError("the criteria file has no ## GitHub assets section")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    found = {c: [i for i in range(start, end) if lines[i].startswith(f"| {c} |")] for c in LABELLED}
    found.update({code: [i for i, text in enumerate(lines) if marker in text] for code, (marker, _) in DECISION_LINES.items()})
    unclear = [k for k, hits in found.items() if len(hits) != 1]
    if unclear:
        raise TopicError(f"the criteria file needs exactly one anchor line for {', '.join(unclear)}")
    return {k: hits[0] + 1 for k, hits in found.items()}


def target(criterion, ours, theirs):
    if criterion in LABELLED:
        return criterion, CELLS[ours], CELLS[theirs]
    cell = DECISION_LINES[ours if ours != NO_CODE else theirs][1]
    return ours if ours != NO_CODE else theirs, cell, cell


def split(line, cell):
    return [line] if cell is None else line[2:-2].split(" | ")


def joined(cells, cell):
    return cells[0] if cell is None else "| " + " | ".join(cells) + " |"


def edited(line, cell, sentence):
    cells = split(line, cell)
    cells[cell or 0] = f"{cells[cell or 0]} {sentence}"
    return joined(cells, cell)


def unedited(line, cell, sentence):
    cells, tail = split(line, cell), f" {sentence}"
    if not cells[cell or 0].endswith(tail):
        return None
    cells[cell or 0] = cells[cell or 0][:-len(tail)]
    return joined(cells, cell)


def checked_edit(qid, option, lines, number, criterion, cell, sentence):
    if not isinstance(sentence, str) or not sentence.strip():
        raise TopicError(f"{qid} wording {option}: a wording is a non-empty sentence")
    line = edited(lines[number - 1], cell, sentence)
    try:
        held = anchors("\n".join([*lines[:number - 1], line, *lines[number:]]) + "\n")
    except TopicError as error:
        raise TopicError(f"{qid} wording {option}: {error}") from None
    if ("\n" in line or "\r" in line or line.count("|") != lines[number - 1].count("|")
            or (criterion in LABELLED and held[criterion] != dict(zip(("1", "0.5", "0"), line[2:-2].split(" | ")[1:])))):
        raise TopicError(f"{qid} wording {option}: the wording keeps the anchor line on one line and inside its cell, without a | or a line break")
    return line


def swap(bundle, old, new):
    if bundle.count(old) > 1:
        raise TopicError(f"the anchors bundle holds the line {old[:60]!r} more than once")
    return bundle.replace(old, new)


def checked_wordings(path, ids):
    wordings = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(wordings, dict) or set(wordings) - set(ids):
        raise TopicError(f"{path.name} maps this worksheet's question ids ({', '.join(ids) or 'none'}) to their wordings; it names {sorted(set(wordings) - set(ids))}")
    for qid, entry in wordings.items():
        if not isinstance(entry, dict) or set(entry) - {"chosen"} != {"cue", "A", "B"} or entry.get("chosen", "A") not in ("A", "B"):
            raise TopicError(f"{qid} in {path.name} holds exactly cue, A and B, the two sentences, and chosen, A or B, once the user has answered")
    return wordings


def write_worksheet(topic, repo, work, batch, criteria):
    work = Path(work)
    if not (batch in BATCHES[:2] or HELD_OUT.match(batch)):
        raise TopicError(f"batch {batch!r} is not a calibration-family batch; rubric questions come from calibration, top-up and held-out flags")
    if (work / FREEZE_FILE).exists():
        raise TopicError(f"{FREEZE_FILE} exists: no wording enters the criteria after the protocol freeze, and a flagged row stays contested")
    if (work / batch_freeze_file(batch)).exists():
        raise TopicError(f"{batch_freeze_file(batch)} exists: a frozen batch keeps its labels and its rubric outcomes")
    (work / outcomes_file(batch)).unlink(missing_ok=True)
    for name in (set_file(batch), flags_file(batch)):
        if not (work / name).is_file():
            raise TopicError(f"no {name} in {work}; the worksheet reads the drawn batch and the flags of its reference and flagger sessions")
    flagged = rubric_rows(json.loads((work / flags_file(batch)).read_text()))
    sample, option, problems = json.loads((work / set_file(batch)).read_text()), reference_option(topic), topic.get("problems") or []
    strata = list(sample["rows_per_stratum"])
    packets = {s: packet_rows(work, s) for s in strata}
    firsts = {s: read_session(work, session_key(batch, s), option, packets[s]) for s in strata}
    models = [o["model"] for o in flaggers(topic)["rubric_trigger"]]
    blind = {(s, m): {r.get("order_rank"): r for r in read_jsonl(work, f"{session_key(batch, s)}-flagger-{m}.jsonl")} for s in strata for m in models}
    drawn = {r["id"]: r for r in sample["rows"]}
    lines = (Path(repo) / criteria).read_text().splitlines()
    at, every = anchor_lines(lines), [p for s in strata for p in packets[s].values()]
    notes = json.loads((work / notes_file(batch)).read_text()) if (work / notes_file(batch)).is_file() else []
    checked_notes(notes, lines, every)

    def packet_of(row):
        return packets[row["stratum"]].get(row["order_rank"]) or {}

    def selected(note):
        return sorted(r["id"] for r in sample["rows"] if selects(note, packet_of(r)))

    def noted(note):
        return [i for i, n in enumerate(notes, 1) if n == note]

    row_parts, groups, ruled, contested = {}, {}, [], []
    for row in flagged:
        held = drawn.get(row["id"])
        if held is None or (held["stratum"], held["order_rank"]) != (row["stratum"], row["order_rank"]) or row["order_rank"] not in firsts.get(row["stratum"], {}):
            raise TopicError(f"{row['id']}: the flags name a row that {set_file(batch)} or its reference session does not hold")
        first = firsts[row["stratum"]][row["order_rank"]]
        checked_reply(row["id"], first, held["repo"], problems)
        replies = [(m, blind[(row["stratum"], m)][row["order_rank"]]) for m in models if row["order_rank"] in blind[(row["stratum"], m)]]
        for model, reply in replies:
            checked_reply(f"{row['id']} flagger {model}", reply, held["repo"], problems)
        if not replies:
            raise TopicError(f"{row['id']}: no rubric-trigger flagger differs from the reference; none of {', '.join(models)} answered the row")
        row_parts[row["id"]] = []
        for criterion, ours, theirs, model in parts(row, first, replies):
            if ours is None:
                row_parts[row["id"]].append((criterion, "contested", None))
                contested.append({"id": row["id"], "part": criterion, "reason": UNANCHORED[criterion]})
            elif criterion == RULE[0] and 1 in (ours, theirs) and selects({"cue": RULE[1]}, packet_of(row)):
                row_parts[row["id"]].append((criterion, "rule", None))
                ruled += [row["id"]] if row["id"] not in ruled else []
            else:
                row_parts[row["id"]].append((criterion, "asked", (criterion, ours, theirs)))
                groups.setdefault((criterion, ours, theirs), []).append((held, first, model, dict(replies)[model]))

    def qid(key):
        return "-".join(shown(v) for v in key)

    order = sorted(groups, key=lambda k: (-len({m[0]["id"] for m in groups[k]}), NOTED.index(k[0]), qid(k)))
    asked = order[:QUESTIONS_MAX]
    for key in order[QUESTIONS_MAX:]:
        contested += [{"id": i, "part": key[0], "reason": f"beyond the {QUESTIONS_MAX}-question cap"} for i in dict.fromkeys(m[0]["id"] for m in groups[key])]
    wordings = checked_wordings(work / wordings_file(batch), [qid(k) for k in asked])
    bundle = bundle_text(repo, topic, criteria)
    before, pending, rules, questions = bundle, [], [], []
    if ruled:
        number = at[RULE[0]]
        if RULE[2] not in lines[number - 1]:
            raise TopicError(f"criteria line {number} no longer holds {RULE[2]!r}; the hosted-tier rule cannot be applied")
        note = {"line": number, "quote": lines[number - 1], "criterion": RULE[0], "cue": RULE[1]}
        rules.append({"criterion": RULE[0], "rows": ruled, "note": note, "rerun": selected(note), "notes": noted(note)})
        pending += [] if rules[0]["notes"] else [f"rule {RULE[0]}: {notes_file(batch)} holds no note {json.dumps(note, ensure_ascii=False)}"]
    for key in asked:
        criterion, ours, theirs = key
        where, cells = target(*key)[0], dict(zip("AB", target(*key)[1:]))
        number, current, entry = at[where], lines[at[where] - 1], wordings.get(qid(key))
        held, first, model, reply = min(groups[key], key=lambda m: (m[0]["stratum"], m[0]["order_rank"]))
        chosen = (entry or {}).get("chosen")
        old = (unedited(current, cells[chosen], entry[chosen]) if chosen else None) or current
        applied = old != current
        base = [*lines[:number - 1], old, *lines[number:]]
        before = swap(before, current, old)
        cite = first["decision_cite"] if criterion == "decision" else first["scores"][criterion]["cite"]
        question = {"id": qid(key), "criterion": criterion, "rows": list(dict.fromkeys(m[0]["id"] for m in groups[key])), "line": number, "quote": old, "example": held["id"],
                    "repo": held["repo"], "readings": {"A": {"by": "reference", "value": ours, "anchor": split(old, cells["A"])[cells["A"] or 0], "reasons": reasons(first, criterion)},
                                                       "B": {"by": model, "value": theirs, "anchor": split(old, cells["B"])[cells["B"] or 0], "reasons": reasons(reply, criterion)}},
                    "recommended": "A" if cite_holds(cite, packet_of(held)) else "B", "options": None, "chosen": chosen, "applied": applied, "notes": [], "unselected": []}
        if entry:
            question["options"] = {}
            for name in "AB":
                line = checked_edit(question["id"], name, base, number, criterion, cells[name], entry[name])
                note = {"line": number, "quote": line, "criterion": criterion, "cue": entry["cue"]}
                checked_notes([note], [*base[:number - 1], line, *base[number:]], every)
                question["options"][name] = {"sentence": entry[name], "note": note, "anchors_sha256": sha256(swap(bundle, current, line)), "rerun": selected(note)}
            question["unselected"] = [m[0]["id"] for m in groups[key] if not selects({"cue": entry["cue"]}, packet_of(m[0]))]
            question["notes"] = noted({"line": number, "quote": current, "criterion": criterion, "cue": entry["cue"]}) if applied else []
        pending += [] if question["notes"] else [f"{question['id']}: " + ("no wording in " + wordings_file(batch) if not entry else "the user has not chosen A or B" if not chosen
                                                                          else f"criteria line {number} does not hold wording {chosen} yet" if not applied
                                                                          else f"{notes_file(batch)} holds no note for wording {chosen}")]
        questions.append(question)
    outcomes = []
    for row in flagged:
        details = {}
        for name, kind, key in row_parts[row["id"]]:
            kind = "contested" if kind == "asked" and key not in asked else kind
            if name not in details or OUTCOMES.index(kind) > OUTCOMES.index(details[name]["outcome"]):
                details[name] = {"outcome": kind, "question": qid(key) if kind == "asked" else None}
        firsts_asked = [details[n]["question"] for n in NOTED if details.get(n, {}).get("outcome") == "asked"]
        outcomes.append({**{k: row[k] for k in ROW_KEYS[:3]}, "outcome": max((d["outcome"] for d in details.values()), key=OUTCOMES.index),
                         "question": firsts_asked[0] if firsts_asked else None,
                         "notes": [i for i, n in enumerate(notes, 1) if n["criterion"] in details and selects(n, packet_of(row))], "criteria": details})
    sheet = {"rules": rules, "questions": questions, "contested": contested, "pending": pending, "outcomes": None if pending else outcomes_file(batch),
             "anchors_sha256": {"before": sha256(before), "after": sha256(bundle)}, "criteria_sha256": hashlib.sha256((Path(repo) / criteria).read_bytes()).hexdigest()}
    (work / questions_file(batch)).write_text(page(batch, criteria, sheet, len(flagged)))
    if not pending:
        (work / outcomes_file(batch)).write_text(json.dumps({"rows": outcomes}, indent=1, ensure_ascii=False) + "\n")
    return sheet


def page(batch, criteria, sheet, flagged):
    out = [f"# Rubric questions: {batch}", "", f"- anchors_sha256 now: {sheet['anchors_sha256']['after']}",
           f"- anchors_sha256 before the chosen wordings: {sheet['anchors_sha256']['before']}", f"- criteria_sha256 now: {sheet['criteria_sha256']}",
           f"- rubric rows: {flagged}; applied by rule: {sum(len(r['rows']) for r in sheet['rules'])}; questions: {len(sheet['questions'])}; "
           f"contested rows: {len({c['id'] for c in sheet['contested']})}",
           f"- outcomes: {sheet['outcomes']} written" if sheet["outcomes"] else "- outcomes: not written; pending:", *(f"  - {p}" for p in sheet["pending"]), "", "## Applied by rule", ""]
    for rule in sheet["rules"]:
        note = rule["note"]
        out += [f"### {rule['criterion']}: the hosted-tier cap, line {note['line']}", "", "```text", note["quote"], "```", "", f"- flagged rows: {', '.join(rule['rows'])}",
                f"- note: `{json.dumps(note, ensure_ascii=False)}`", f"- re-run: {len(rule['rerun'])} rows the cue selects: {', '.join(rule['rerun'])}",
                f"- in {notes_file(batch)}: " + (", ".join(f"note {i}" for i in rule["notes"]) or "not yet"), ""]
    out += ["## Questions", ""]
    for number, q in enumerate(sheet["questions"], 1):
        out += [f"### Q{number} `{q['id']}` (flagged: {', '.join(q['rows'])})", "", f"Anchor line {q['line']} of {criteria}:", "", "```text", q["quote"], "```", ""]
        values = {n: (f"{q['criterion']} {shown(r['value'])}" if q["criterion"] != "decision" else "not a copy, dead or aggregator" if r["value"] == NO_CODE
                      else f"excluded: {r['value']}") for n, r in q["readings"].items()}
        for name, r in q["readings"].items():
            who = "the reference" if r["by"] == "reference" else f"the flagger {r['by']}"
            out += [f"- {name}, {who}'s reading: {values[name]}: {r['anchor']}", f"  - reasons on the example: {'; '.join(f'`{x}`' for x in r['reasons'])}"]
        out += [f"- example: {q['example']}, https://github.com/{q['repo']}",
                f"- Recommended: {q['recommended']}. " + ("The reference is the strongest rater and its cite holds on the example." if q["recommended"] == "A"
                                                           else "The reference's cite does not hold on the example row."),
                f"- if A: the re-run is expected to keep the flagged rows at {values['A']}; the sentence enters the criteria so the judges read the same anchor.",
                f"- if B: the re-run is expected to move the flagged rows from {values['A']} to {values['B']}; the reference still writes every value.", ""]
        if not q["options"]:
            out += [f"- wording: not written; add {{\"cue\", \"A\", \"B\"}} under \"{q['id']}\" in {wordings_file(batch)}", ""]
            continue
        for name, o in q["options"].items():
            out += [f"#### Wording {name}: {o['sentence']}", "", "```diff", f"--- a/{criteria}", f"+++ b/{criteria}", f"@@ -{q['line']},1 +{q['line']},1 @@", f"-{q['quote']}",
                    f"+{o['note']['quote']}", "```", "", f"- anchors_sha256 after {name}: {o['anchors_sha256']}", f"- note: `{json.dumps(o['note'], ensure_ascii=False)}`",
                    f"- re-run: {len(o['rerun'])} rows the cue selects: {', '.join(o['rerun']) or 'none'}", ""]
        out += [f"- flagged rows the cue does not select, kept under the earlier anchor: {', '.join(q['unselected']) or 'none'}",
                f"- chosen: {q['chosen'] or 'not yet'}; applied to the criteria: {'yes' if q['applied'] else 'no'}; in {notes_file(batch)}: "
                + (", ".join(f"note {i}" for i in q["notes"]) or "not yet"), ""]
    out += ["## Contested", "", *(f"- {c['id']} ({c['part']}): {c['reason']}" for c in sheet["contested"])]
    return "\n".join(out) + "\n"
