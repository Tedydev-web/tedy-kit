import json
import re

from study_topic import TopicError

CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
AGY_STEPS = {"user_input", "agent_response"}
MECHANISM = re.compile(r"^mechanism: ([a-z0-9]+(?:-[a-z0-9]+)*): (\S.*)$")


def reply_text(option, out, status):
    where = f"{option['cli']} {option['model']}"
    if status != "ok":
        raise TopicError(f"{where}: {status}")
    if option["cli"] == "agy":
        return agy_reply(where, out), None
    try:
        body = json.loads(out)
    except ValueError as error:
        raise TopicError(f"{where}: reply is not JSON: {error}") from error
    if not isinstance(body, dict):
        raise TopicError(f"{where}: reply is not a JSON object")
    if option["cli"] == "claude":
        if body.get("is_error"):
            raise TopicError(f"{where}: {str(body.get('result'))[:200]}")
        if body.get("num_turns") != 1 or body.get("permission_denials"):
            raise TopicError(f"{where}: {body.get('num_turns')} turns, permission denials {body.get('permission_denials')}; a screening session answers in one turn without tools")
        served = sorted(body.get("modelUsage") or {})
        if served != [option["model"]]:
            raise TopicError(f"{where}: served {served}, not the requested {option['model']}")
        return body.get("result") or "", served


def agy_reply(where, out):
    events = []
    for line in out.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    results = [e["result"] for e in events if e.get("event") == "result" and isinstance(e.get("result"), dict)]
    if not results:
        raise TopicError(f"{where}: the stream-json reply holds no result event")
    result = results[-1]
    steps = [e.get("step_update") for e in events if e.get("event") == "step_update"]
    other = sorted({str(s.get("step_type")) if isinstance(s, dict) else repr(s) for s in steps} - AGY_STEPS)
    if result.get("status") != "SUCCESS":
        raise TopicError(f"{where}: status {result.get('status')}")
    if other or result.get("denied_actions"):
        raise TopicError(f"{where}: step types {other} beyond user_input and agent_response, denied actions {str(result.get('denied_actions'))[:200]}; "
                         "a screening session has no tools")
    if result.get("num_turns") != 1:
        raise TopicError(f"{where}: {result.get('num_turns')} turns; a screening session answers in one turn")
    return result.get("response") or ""


def row_problems(row, expected):
    if type(row.get("order_rank")) is not int or row["order_rank"] not in expected:
        return [f"row {row.get('order_rank')!r} was not asked for"]
    rank, problems = row["order_rank"], []
    if str(row.get("repo", "")).lower() != expected[rank]["repo"].lower():
        problems.append(f"rank {rank} names {row.get('repo')!r}, not {expected[rank]['repo']}")
    scores = row.get("scores")
    if not isinstance(scores, dict) or any(not isinstance(scores.get(c), dict) or type(scores[c].get("v")) is bool or scores[c].get("v") not in (0, 0.5, 1) for c in CELLS):
        problems.append(f"rank {rank} lacks a 1 / 0.5 / 0 score for every cell")
    if not isinstance(row.get("mechanisms"), list) or not all(isinstance(m, str) for m in row["mechanisms"]):
        problems.append(f"rank {rank} has no mechanisms list")
    if not str(row.get("decision", "")).startswith(("eligible", "exclude")):
        problems.append(f"rank {rank} has no eligible or exclude decision")
    return problems


STRATA = ("config", "product")


def parse_qgs_reply(text, expected, topic_problems, allowed=("yes", "no", "unsure"), strata=False):
    rows, problems = {}, []
    for line in (raw.strip() for raw in text.splitlines()):
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except ValueError:
            problems.append(f"unparsable row line {line[:80]!r}")
            continue
        rank = row.get("order_rank")
        if type(rank) is not int or rank not in expected:
            problems.append(f"row {rank!r} was not asked for")
            continue
        issues = []
        if str(row.get("repo", "")).lower() != expected[rank]["repo"].lower():
            issues.append(f"rank {rank} names {row.get('repo')!r}, not {expected[rank]['repo']}")
        if row.get("verdict") not in allowed:
            issues.append(f"rank {rank} has no {', '.join(allowed)} verdict")
        if not isinstance(row.get("problems"), list) or not all(isinstance(p, str) for p in row["problems"]):
            issues.append(f"rank {rank} has no problems list")
        else:
            outside = sorted(set(row["problems"]) - set(topic_problems))
            if outside:
                issues.append(f"rank {rank} names problems {outside} outside the topic")
            if row.get("verdict") == "yes" and not row["problems"]:
                issues.append(f"rank {rank} answers yes without a problem id")
        if strata:
            named = row.get("strata")
            if not isinstance(named, list) or not set(named) <= set(STRATA) or (row.get("verdict") == "yes") != bool(named):
                issues.append(f"rank {rank} needs strata naming config, product or both for a yes, and none otherwise")
        if rank in rows:
            issues.append(f"rank {rank} appears twice")
        problems += issues
        if not issues:
            rows[rank] = {"id": rank, "order_rank": rank, "repo": expected[rank]["repo"], "verdict": row["verdict"], "problems": row["problems"], **({"strata": sorted(set(row["strata"]))} if strata else {}), "why": str(row.get("why", ""))}
    problems += [f"rank {rank} missing from the reply" for rank in expected if rank not in rows and not any(f"rank {rank} " in p for p in problems)]
    return [rows[r] for r in sorted(rows)], problems


def problem_ids(row, topic_problems):
    rank, ids = row["order_rank"], row.get("problems")
    if not isinstance(ids, list) or not all(isinstance(p, str) for p in ids):
        return [f"rank {rank} has no problems list naming the registry problems it addresses"]
    outside = sorted(set(ids) - set(topic_problems))
    if outside:
        return [f"rank {rank} names problems {outside} outside the topic"]
    if str(row.get("decision", "")).startswith("eligible") and not ids:
        return [f"rank {rank} is eligible but names no registry problem"]
    return []


REFERENCE_CRITERIA = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")
REFERENCE_CODES = ("irrelevant", "below-threshold", "copy", "dead", "aggregator")
CITE = re.compile(r"^(path|readme|fact):(.*\S.*)$", re.S)
DECISION = re.compile(r"^(?:eligible|excluded: (?:" + "|".join(REFERENCE_CODES) + r"))$")


def cite_ok(value):
    found = CITE.match(value) if isinstance(value, str) else None
    return bool(found) and (found.group(1) != "readme" or len(found.group(2)) <= 200)


def reference_issues(row, expected, topic_problems):
    rank, issues = row["order_rank"], []
    if str(row.get("repo", "")).lower() != expected[rank]["repo"].lower():
        issues.append(f"rank {rank} names {row.get('repo')!r}, not {expected[rank]['repo']}")
    scores = row.get("scores")
    if not isinstance(scores, dict) or set(scores) != set(REFERENCE_CRITERIA) or not all(
            isinstance(s, dict) and type(s.get("v")) is not bool and s.get("v") in (0, 0.5, 1) and cite_ok(s.get("cite")) for s in scores.values()):
        issues.append(f"rank {rank} needs scores of exactly {', '.join(REFERENCE_CRITERIA)}, each a 1 / 0.5 / 0 value with a path:, readme: or fact: cite")
    mechanisms = row.get("mechanisms")
    if not isinstance(mechanisms, list) or not all(isinstance(m, dict) and all(isinstance(m.get(k), str) and m[k].strip() for k in ("problem", "path", "why")) for m in mechanisms):
        issues.append(f"rank {rank} needs mechanisms as a list of problem, path and why")
    else:
        outside = sorted({m["problem"] for m in mechanisms} - set(topic_problems))
        if outside:
            issues.append(f"rank {rank} names problems {outside} outside the topic")
    if not isinstance(row.get("decision"), str) or not DECISION.match(row["decision"]):
        issues.append(f"rank {rank} needs a decision of eligible or excluded: <{' | '.join(REFERENCE_CODES)}>")
    if not cite_ok(row.get("decision_cite")):
        issues.append(f"rank {rank} needs a decision_cite of path:, readme: or fact:")
    return issues


def parse_reference_reply(text, expected, topic_problems):
    rows, problems = {}, []
    for line in (raw.strip() for raw in text.splitlines()):
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except ValueError:
            problems.append(f"unparsable row line {line[:80]!r}")
            continue
        rank = row.get("order_rank") if isinstance(row, dict) else None
        if type(rank) is not int or rank not in expected:
            problems.append(f"row {rank!r} was not asked for")
            continue
        issues = reference_issues(row, expected, topic_problems) + ([f"rank {rank} appears twice"] if rank in rows else [])
        problems += issues
        if not issues:
            rows[rank] = {"order_rank": rank, "repo": expected[rank]["repo"], "sha": expected[rank].get("sha"),
                          "scores": {c: {"v": row["scores"][c]["v"], "cite": row["scores"][c]["cite"]} for c in REFERENCE_CRITERIA},
                          "mechanisms": [{k: m[k] for k in ("problem", "path", "why")} for m in row["mechanisms"]], "decision": row["decision"], "decision_cite": row["decision_cite"]}
    problems += [f"rank {rank} missing from the reply" for rank in expected if rank not in rows and not any(f"rank {rank} " in p for p in problems)]
    return [rows[r] for r in sorted(rows)], problems


def parse_reply(text, expected, topic_problems=None):
    rows, mechanisms, problems = {}, [], []
    for line in (raw.strip() for raw in text.splitlines()):
        found = MECHANISM.match(line)
        if found:
            mechanisms.append(found.groups())
        elif line.startswith("{"):
            try:
                row = json.loads(line)
            except ValueError:
                problems.append(f"unparsable row line {line[:80]!r}")
                continue
            issues = row_problems(row, expected)
            if not issues and topic_problems is not None:
                issues = problem_ids(row, topic_problems)
            if not issues and row["order_rank"] in rows:
                issues = [f"rank {row['order_rank']} appears twice"]
            problems += issues
            if not issues:
                rows[row["order_rank"]] = {**{k: v for k, v in row.items() if k != "sha"}, "sha": expected[row["order_rank"]].get("sha")}
    problems += [f"rank {rank} missing from the reply" for rank in expected if rank not in rows and not any(f"rank {rank} " in p for p in problems)]
    return [rows[r] for r in sorted(rows)], mechanisms, problems
