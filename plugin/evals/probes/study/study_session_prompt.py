import hashlib
import json
import re
from datetime import date

from study_topic import TopicError

SWEEP_DATE = re.compile(r"^(\d{2})(\d{2})(\d{2})-")
DATE_ANCHORS = ((90, 1), (365, 0.5))
ROWS_NOTE = ("Each row below is one JSON object: the pinned commit, the repository facts from discovery, the top-level listing, the README excerpt, up to two asset files "
             "read at that commit, and the evidence the anchors score on (releases, tags, published packages, the owner's public repository count and top repositories, "
             "workflows, test paths, the CHANGELOG head). Score only from these inputs; you have no tools. Score from what is present: a file listed under missing could "
             "not be read at the pinned commit and counts as absent. A row whose tree is partial was too large to list in full. A row whose error_kind is permanent could "
             "not be read because the repository or commit is gone: code it dead. The sweep date is {sweep_date}; the toolchain computes Date from facts.pushed and this "
             "date and replaces your Date value.")
REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, file, "
                "scores (an object of the seven cells Authority, Methodology, Objectivity, Date, Position, Novelty, Relevance, each {\"v\": 1 | 0.5 | 0, \"why\": \"...\"}), "
                "mechanisms (names), new (true when a mechanism is new to you), decision (eligible, or exclude: <code>) and note. Then one line per mechanism you name "
                "for the first time: mechanism: <kebab-case-name>: <one-line definition>.")
TEMPLATE_SHA256 = hashlib.sha256((ROWS_NOTE + "\n\n" + REPLY_FORMAT).encode()).hexdigest()
REPLY_FORMAT_V4 = REPLY_FORMAT.replace("mechanisms (names), ", "mechanisms (names), problems (the ids of the registry problems the repository carries a mechanism for; "
                                                             "at least one for an eligible row), ")
TEMPLATE_SHA256_V4 = hashlib.sha256((ROWS_NOTE + "\n\n" + REPLY_FORMAT_V4).encode()).hexdigest()


def criteria_version(path):
    found = re.search(r"quality-criteria-v(\d+)\.md$", str(path or ""))
    return int(found.group(1)) if found else 0


def reply_format(criteria):
    return REPLY_FORMAT_V4 if criteria_version(criteria) >= 4 else REPLY_FORMAT


def template_sha256(criteria):
    return TEMPLATE_SHA256_V4 if criteria_version(criteria) >= 4 else TEMPLATE_SHA256
QGS_ROWS_NOTE = ("Each row below is one JSON object: the pinned commit, the repository facts from discovery, the top-level listing, the README excerpt, up to two asset files "
                 "read at that commit, and the evidence the toolchain fetched. Judge only from these inputs; you have no tools. A file listed under missing could not be read "
                 "at the pinned commit and counts as absent.")
QGS_REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, "
                    "verdict (\"yes\", \"no\" or \"unsure\"), problems (the ids of the problems the repository carries a mechanism for; at least one for a yes, none otherwise), "
                    "strata (\"config\" when the repository's own agent assets carry the mechanism, \"product\" when it ships the mechanism as source code a harness runs, "
                    "or both; at least one for a yes, none otherwise) and why (one sentence).")
QGS_TEMPLATE_SHA256 = hashlib.sha256((QGS_ROWS_NOTE + "\n\n" + QGS_REPLY_FORMAT).encode()).hexdigest()
STAGE1_ROWS_NOTE = ("Each row below is one repository: its name and description and, when given, its agent-asset paths or the first lines of its README. Answer yes when it "
                    "plausibly carries a mechanism for a listed problem; unsure when the text is empty, vague or could plausibly address a listed problem; no only when it clearly "
                    "addresses none of them. When in doubt, include: only no excludes a row. You have no tools.")
STAGE1_REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, "
                       "verdict (\"yes\", \"unsure\" or \"no\"), problems (the ids of the problems it may address; at least one for a yes) and why (one short sentence).")
STAGE1_TEMPLATE_SHA256 = hashlib.sha256((STAGE1_ROWS_NOTE + "\n\n" + STAGE1_REPLY_FORMAT).encode()).hexdigest()
REFERENCE_ROWS_NOTE = ("Each row below is one JSON object read at its pinned commit sha: the repository facts and the evidence the anchors score on, the README, the "
                       "tree (agent-asset paths first), and as lists of {path, text}: up to ten asset files, up to ten test files of which only the first 40 lines are "
                       "given, and up to two manifests; then the CHANGELOG head, the prefilled facts (released, changelog, paid_tier_cues) and, under truncated, the bytes "
                       "each part held before and after its cap. Label only from these inputs; you have no tools. A file listed under missing, with the reason, could not "
                       "be read at the pinned commit and counts as absent; a test file's lines past the first 40 are not absent, only not shown. Date is not asked: the "
                       "toolchain computes it.")
REFERENCE_REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, "
                          "scores (an object of the five criteria Authority, Methodology, Objectivity, Position and Relevance, each {\"v\": 1 | 0.5 | 0, \"cite\": \"...\"}), "
                          "mechanisms (a list of {\"problem\": \"<registry problem id>\", \"path\": \"<tree path of the file that carries the mechanism>\", "
                          "\"why\": \"<one sentence>\"}; empty when the repository carries none), decision (eligible, or excluded: <code> with the code irrelevant, "
                          "below-threshold, copy, dead or aggregator) and decision_cite. Every cite is path:<a path from tree>, readme:<a verbatim README quote of at most "
                          "200 characters> or fact:<a field of the row, such as prefilled.released>.")
REFERENCE_TEMPLATE_SHA256 = hashlib.sha256((REFERENCE_ROWS_NOTE + "\n\n" + REFERENCE_REPLY_FORMAT).encode()).hexdigest()


def sweep_date(topic):
    found = SWEEP_DATE.match(topic["sweep"])
    try:
        return date(2000 + int(found.group(1)), int(found.group(2)), int(found.group(3))) if found else None
    except ValueError:
        return None


def required_sweep_date(topic):
    when = sweep_date(topic)
    if when is None:
        raise TopicError(f"{topic['path']}: sweep {topic['sweep']!r} does not start with a yymmdd date, so Date cannot be computed")
    return when


def date_cell(pushed, when):
    try:
        days = (when - date.fromisoformat(str(pushed)[:10])).days
    except ValueError:
        return {"v": 0, "why": f"computed by the toolchain: no push date in the facts, sweep date {when}"}
    value = next((v for limit, v in DATE_ANCHORS if days <= limit), 0)
    return {"v": value, "why": f"computed by the toolchain: pushed {str(pushed)[:10]}, {days} days before the sweep date {when}"}


def with_computed_date(row, inputs, when):
    scores = dict(row["scores"])
    session = scores.get("Date", {}).get("v")
    scores["Date"] = date_cell(inputs.get("facts", {}).get("pushed"), when)
    return {**row, "scores": scores, "session_date": session}


def build_prompt(packet, criteria_path, criteria_text, mechanisms_text, rows, when):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    parts = [packet.rstrip(), f"## Criteria ({criteria_path})", criteria_text.rstrip(), "## Your mechanism names so far", mechanisms_text.strip() or "none yet",
             "## Rows", ROWS_NOTE.format(sweep_date=when.isoformat()), *blocks, reply_format(criteria_path)]
    return "\n\n".join(parts) + "\n"


def build_stage1_prompt(packet, worked, rows):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    return "\n\n".join([packet.rstrip(), "## Worked examples", worked, "## Rows", STAGE1_ROWS_NOTE, *blocks, STAGE1_REPLY_FORMAT]) + "\n"


def build_reference_prompt(bundle, notes, rows):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    noted = ["## Rubric notes", "\n".join(f"- line {n['line']} ({n['criterion']}): {n['quote']}" for n in notes)] if notes else []
    return "\n\n".join([bundle.rstrip(), *noted, "## Rows", REFERENCE_ROWS_NOTE, *blocks, REFERENCE_REPLY_FORMAT]) + "\n"


def build_qgs_prompt(packet, rows):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    return "\n\n".join([packet.rstrip(), "## Rows", QGS_ROWS_NOTE, *blocks, QGS_REPLY_FORMAT]) + "\n"
