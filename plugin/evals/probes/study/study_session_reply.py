import json
import re

from study_topic import TopicError

CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
MECHANISM = re.compile(r"^mechanism: ([a-z0-9]+(?:-[a-z0-9]+)*): (\S.*)$")


def reply_text(option, out, status):
    where = f"{option['cli']} {option['model']}"
    if status != "ok":
        raise TopicError(f"{where}: {status}")
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
    if body.get("status") != "SUCCESS":
        raise TopicError(f"{where}: status {body.get('status')}")
    if body.get("denied_actions"):
        raise TopicError(f"{where}: tried tools in print mode ({str(body['denied_actions'])[:200]}); a screening session has no tools")
    return body.get("response") or "", None


def row_problems(row, expected):
    if not isinstance(row.get("order_rank"), int) or row["order_rank"] not in expected:
        return [f"row {row.get('order_rank')!r} was not asked for"]
    rank, problems = row["order_rank"], []
    if str(row.get("repo", "")).lower() != expected[rank]["repo"].lower():
        problems.append(f"rank {rank} names {row.get('repo')!r}, not {expected[rank]['repo']}")
    scores = row.get("scores")
    if not isinstance(scores, dict) or any(not isinstance(scores.get(c), dict) or scores[c].get("v") not in (0, 0.5, 1) for c in CELLS):
        problems.append(f"rank {rank} lacks a 1 / 0.5 / 0 score for every cell")
    if not isinstance(row.get("mechanisms"), list) or not all(isinstance(m, str) for m in row["mechanisms"]):
        problems.append(f"rank {rank} has no mechanisms list")
    if not str(row.get("decision", "")).startswith(("eligible", "exclude")):
        problems.append(f"rank {rank} has no eligible or exclude decision")
    return problems


def parse_reply(text, expected):
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
            if not issues and row["order_rank"] in rows:
                issues = [f"rank {row['order_rank']} appears twice"]
            problems += issues
            if not issues:
                rows[row["order_rank"]] = {**{k: v for k, v in row.items() if k != "sha"}, "sha": expected[row["order_rank"]].get("sha")}
    problems += [f"rank {rank} missing from the reply" for rank in expected if rank not in rows and not any(f"rank {rank} " in p for p in problems)]
    return [rows[r] for r in sorted(rows)], mechanisms, problems
