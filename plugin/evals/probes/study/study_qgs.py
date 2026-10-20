from pathlib import Path

from study_agreement import cohen_kappa, rounded
from study_screening_core import read_jsonl
from study_topic import TopicError, session_option

VERDICTS = ("yes", "no", "unsure")
STANDARD_RULE = ("a member is a candidate both Claude judges answered yes, or the reader's yes on a queued candidate: one the judges disagree on or call unsure, "
                 "or one both Claude judges reject and the cross-family judge accepts; its problem labels are the union of the yes judges' labels, or the reader's")


def whole_topic(topic, step):
    if topic.get("facet"):
        raise TopicError(f"{step} runs once per topic with the topic's terms; run it with --topic {topic['name'].partition(':')[0]}")


def cross_family(topic):
    option = topic.get("cross_family")
    return session_option(topic, "cross_family", option) if option is not None else None


def read_verdicts(folder, name, problems, required=True):
    path = Path(folder) / name
    if not path.is_file():
        if required:
            raise TopicError(f"no {name} in {folder}")
        return {}
    rows = {}
    for row in read_jsonl(path.parent, path.name):
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
        rows[row["id"]] = row
    return rows


def reader_queue(a, b, cross):
    both = sorted(set(a) & set(b))
    disputed = [i for i in both if a[i]["verdict"] != b[i]["verdict"] or a[i]["verdict"] == "unsure"]
    rejected = [i for i in both if a[i]["verdict"] == b[i]["verdict"] == "no" and cross.get(i, {}).get("verdict") == "yes"]
    return both, {"disputed": disputed, "cross_family_only": rejected}


def qgs_standard(topic, folder, stratum):
    whole_topic(topic, "the quasi-gold standard")
    problems = topic.get("problems") or []
    a, b = (read_verdicts(folder, f"{stratum}-qgs-judge-{side}.jsonl", problems) for side in "AB")
    option = cross_family(topic)
    cross_name = f"{stratum}-qgs-cross-{option['model']}.jsonl" if option else None
    cross = read_verdicts(folder, cross_name, problems, required=False) if option else {}
    reader = read_verdicts(folder, f"{stratum}-qgs-reader.jsonl", problems, required=False)
    both, queue = reader_queue(a, b, cross)
    queued = queue["disputed"] + queue["cross_family_only"]
    unread = sorted(i for i in queued if i not in reader)
    if unread:
        raise TopicError(f"the reader has not judged queued candidates {unread}; write {stratum}-qgs-reader.jsonl first")
    final, labels = [], {}
    for i in both:
        if a[i]["verdict"] == b[i]["verdict"] == "yes":
            final.append(a[i]["repo"])
            labels[a[i]["repo"]] = sorted(set(a[i]["problems"]) | set(b[i]["problems"]))
    for i in sorted(queued):
        if reader[i]["verdict"] == "yes":
            final.append(reader[i]["repo"])
            labels[reader[i]["repo"]] = sorted(reader[i]["problems"])
    out = {"final": final, "labels": labels, "queue": queue, "rule": STANDARD_RULE, "judged_by_both": len(both)}
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
