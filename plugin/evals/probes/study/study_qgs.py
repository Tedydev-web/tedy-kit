import json
from pathlib import Path

from study_agreement import cohen_kappa, rounded
from study_screening_core import read_jsonl
from study_topic import TopicError, product_filter, session_option

VERDICTS = ("yes", "no", "unsure")
CANDIDATES, DROPPED, ADJUDICATED, INPUTS, PACKET = "qgs-candidates.jsonl", "qgs-dropped.json", "qgs-adjudicated.json", "qgs-inputs.jsonl", "qgs-packet.md"
JUDGE_FILES = {"qgs-A": "qgs-judge-A", "qgs-B": "qgs-judge-B", "reader": "qgs-reader"}
STANDARD_RULE = ("every candidate is judged by both Claude judges, or dropped with a recorded reason; a member is a candidate both answered yes, or the reader's yes on a "
                 "queued candidate: one the judges disagree on or call unsure, or one both reject and the cross-family judge accepts; its problem labels are the union "
                 "of the yes judges' labels, or the reader's")
UPPER_ESTIMATE = ("QGS recall is an upper estimate: the QGS judges are the stage-1 models, and the candidates come from curated lists filtered by the topic's terms")


def whole_topic(topic, step):
    if topic.get("facet"):
        raise TopicError(f"{step} runs once per topic with the topic's terms; run it with --topic {topic['name'].partition(':')[0]}")


def cross_family(topic):
    option = topic.get("cross_family")
    return session_option(topic, "cross_family", option) if option is not None else None


def candidates_file(folder):
    return Path(folder) / CANDIDATES


def candidates(folder):
    return {r["id"]: r["repo"] for r in candidate_rows(folder)}


def candidate_rows(folder):
    rows = read_jsonl(Path(folder), CANDIDATES)
    if not rows:
        raise TopicError(f"no {CANDIDATES} in {folder}; extract the topic's candidates with extract-qgs-candidates.py --topic <topic>")
    return rows


def cross_name(option):
    return f"qgs-cross-{option['model']}.jsonl"


def dropped(folder):
    path = Path(folder) / DROPPED
    return {int(k): v for k, v in json.loads(path.read_text()).items()} if path.is_file() else {}


def checked_row(name, row, problems):
    where = f"{name} id {row.get('id')}"
    if row.get("verdict") not in VERDICTS:
        raise TopicError(f"{where}: verdict must be yes, no or unsure, not {row.get('verdict')!r}")
    labels = row.get("problems", [])
    if not isinstance(labels, list) or not all(isinstance(p, str) for p in labels):
        raise TopicError(f"{where}: problems must be a list of problem ids")
    outside = sorted(set(labels) - set(problems))
    if outside:
        raise TopicError(f"{where}: problems {outside} are not topic problems")
    if row["verdict"] == "yes" and not labels:
        raise TopicError(f"{where}: a yes verdict needs at least one problem id")
    return row


def read_verdicts(folder, name, problems, listed, required=True):
    path = Path(folder) / name
    if not path.is_file():
        if required:
            raise TopicError(f"no {name} in {folder}")
        return {}
    rows = {}
    for row in read_jsonl(path.parent, path.name):
        checked_row(name, row, problems)
        if listed.get(row.get("id"), "").lower() != str(row.get("repo", "")).lower():
            raise TopicError(f"{name} id {row.get('id')} names {row.get('repo')!r}, but candidate {row.get('id')} is {listed.get(row.get('id'))!r}")
        rows[row["id"]] = row
    return rows


def read_cross(folder, name, problems, listed):
    path = Path(folder) / name
    if not path.is_file():
        return {}
    by_repo = {repo.lower(): i for i, repo in listed.items()}
    rows = {}
    for row in read_jsonl(path.parent, path.name):
        checked_row(name, row, problems)
        joined = by_repo.get(str(row.get("repo", "")).lower())
        if joined is None:
            raise TopicError(f"{name} names {row.get('repo')!r}, which is not a candidate; the cross-family judgments join the candidates by repository name")
        if "id" in row and row["id"] != joined:
            raise TopicError(f"{name} row id {row['id']} names {row['repo']}, which is candidate {joined}; the join is by repository name and the two disagree")
        rows[joined] = {**row, "id": joined}
    return rows


def reader_queue(a, b, cross):
    both = sorted(set(a) & set(b))
    disputed = [i for i in both if a[i]["verdict"] != b[i]["verdict"] or a[i]["verdict"] == "unsure"]
    rejected = [i for i in both if a[i]["verdict"] == b[i]["verdict"] == "no" and cross.get(i, {}).get("verdict") == "yes"]
    return both, {"disputed": disputed, "cross_family_only": rejected}


def judging_gaps(listed, a, b, drops):
    return {i: [side for side, rows in (("A", a), ("B", b)) if i not in rows] for i in sorted(listed) if i not in drops and not (i in a and i in b)}


def qgs_standard(topic, folder):
    whole_topic(topic, "the quasi-gold standard")
    problems = topic.get("problems") or []
    listed = candidates(folder)
    a, b = (read_verdicts(folder, f"{JUDGE_FILES[judge]}.jsonl", problems, listed) for judge in ("qgs-A", "qgs-B"))
    drops = dropped(folder)
    gaps = judging_gaps(listed, a, b, drops)
    if gaps:
        shown = "; ".join(f"{i} {listed[i]} (missing judge {', '.join(sides)})" for i, sides in list(gaps.items())[:10])
        raise TopicError(f"{len(gaps)} candidates are not judged by both judges: {shown}; judge them, or drop them with drop-qgs-candidates.py and a reason")
    option = cross_family(topic)
    cross = read_cross(folder, cross_name(option), problems, listed) if option else {}
    reader = read_verdicts(folder, f"{JUDGE_FILES['reader']}.jsonl", problems, listed, required=False)
    both, queue = reader_queue(a, b, cross)
    queued = queue["disputed"] + queue["cross_family_only"]
    unread = sorted(i for i in queued if i not in reader)
    if unread:
        raise TopicError(f"the reader has not judged queued candidates {unread}; run run-judge.py --judge reader --set qgs")
    final, labels = [], {}
    for i in both:
        if a[i]["verdict"] == b[i]["verdict"] == "yes":
            final.append(a[i]["repo"])
            labels[a[i]["repo"]] = sorted(set(a[i]["problems"]) | set(b[i]["problems"]))
    for i in sorted(queued):
        if reader[i]["verdict"] == "yes":
            final.append(reader[i]["repo"])
            labels[reader[i]["repo"]] = sorted(reader[i]["problems"])
    out = {"final": final, "labels": labels, "queue": queue, "rule": STANDARD_RULE, "candidates": len(listed), "judged_by_both": len(both),
           "dropped": {str(i): drops[i] for i in sorted(drops)}}
    if option:
        overlap = sorted(set(cross) & set(both))
        pairs = {side: [(rows[i]["verdict"] == "yes", cross[i]["verdict"] == "yes") for i in overlap] for side, rows in (("A", a), ("B", b))}
        out["cross_family"] = {"model": option["model"], "judged": len(cross), "overlap": len(overlap),
                               "kappa": {side: rounded(cohen_kappa(p)[1]) if p else None for side, p in pairs.items()},
                               "agreement": {side: sum(x == y for x, y in p) for side, p in pairs.items()},
                               "accepted_against_both": queue["cross_family_only"],
                               "reader_yes": [i for i in queue["cross_family_only"] if reader[i]["verdict"] == "yes"]}
    return out


def problem_facets(topic):
    return {p: name for name, rule in (topic.get("facets") or {}).items() for p in rule["problems"]}


def member_facets(topic, labels):
    homes = problem_facets(topic)
    return {member: sorted({homes[p] for p in problems if p in homes}) for member, problems in labels.items()}


def product_members(topic, folder, final):
    passes = product_filter(topic)
    lines = {r["repo"].lower(): r for r in candidate_rows(folder)}
    return [m for m in final if passes(m + " " + lines.get(m.lower(), {}).get("line", ""))]
