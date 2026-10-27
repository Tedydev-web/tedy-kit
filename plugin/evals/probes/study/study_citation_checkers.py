import hashlib
import json
import re
from pathlib import Path

from study_calibration_set import anchors, labels_file, set_file
from study_citation_check import BATCH, STOP_AT, UNSUPPORTED, drawn, sha256_file, statements, summary
from study_reference_labels import cites_file, packet_rows, reference_option
from study_screening_input import read_file
from study_session import MAX_PROMPT, call_isolated, isolation, session_command
from study_session_reply import reply_text
from study_topic import TopicError

FILE_BYTES, CHECKERS = 10_000, 3
VOTE = re.compile(r"^answer:\s*(yes|no)\s*\nreason:\s*(\S.*)$", re.IGNORECASE)
REPLY_FORMAT = "Reply with exactly two lines and nothing else:\nanswer: yes  (or: answer: no)\nreason: <one sentence naming the file and the line that decides it>"


def votes_file(model):
    return f"citation-check-votes-{model}.json"


def file_block(fetch, packet, path):
    entry = read_file(fetch, packet["repo"], packet["sha"], path, FILE_BYTES)
    if entry.get("error"):
        body = f"(not readable at the pinned commit: {entry['error']})"
    elif entry.get("binary"):
        body = "(binary file, not shown)"
    else:
        body = entry["text"] + (f"\n(cut at {FILE_BYTES} bytes)" if entry["truncated"] else "")
    return f'<file path="{path}">\n{body}\n</file>'


def checker_prompt(topic, row, packet, mechanisms, anchor, problems, fetch):
    meaning = (topic.get("eligibility") or {}).get("en")
    head = ["You check one label of a repository against its files. Answer from the files below only; do not guess what other files hold.",
            *([f"What counts: {meaning}"] if meaning and meaning != "-" else []), f"Row: {row['id']}", f"Repository: {packet['repo']} at commit {packet['sha']}"]
    if row["kind"] == "relevance-1":
        cited = list(dict.fromkeys((m["path"], m["problem"]) for m in mechanisms))
        body = [f"The label is Relevance = 1. Criteria anchor: {anchor['1']}", "Each cited file is listed with the problem the label says it carries a mechanism for:",
                *(f"- {path}: {problem}: {problems.get(problem, '')}" for path, problem in cited), *(file_block(fetch, packet, p) for p in dict.fromkeys(p for p, _ in cited)),
                "Question: Does at least one cited file carry a mechanism for the problem listed beside it?"]
    else:
        assets = [a["path"] for a in packet.get("assets") or []]
        body = [f"The label is Relevance = 0. Criteria anchor: {anchor['0']}", "Problems:", *(f"- {p}: {s}" for p, s in problems.items()),
                *([file_block(fetch, packet, p) for p in assets] or ["(the inputs hold no agent-asset file)"]),
                "Question: Does any of these files carry a mechanism for a listed problem?"]
    prompt = "\n\n".join([*head, *body, REPLY_FORMAT])
    if len(prompt.encode()) > MAX_PROMPT:
        raise TopicError(f"the check prompt for {row['id']} is {len(prompt.encode())} bytes, over {MAX_PROMPT}")
    return prompt


def checker_prompts(topic, repo, work, fetch):
    work = Path(work)
    sample = json.loads((work / set_file(BATCH)).read_text())
    rows = drawn(topic["sweep"], json.loads((work / labels_file(BATCH)).read_text())["rows"])
    cited = {r["id"]: r.get("mechanisms") or [] for r in json.loads((work / cites_file(BATCH)).read_text())["rows"]}
    packets = {s: packet_rows(work, s) for s in sample["rows_per_stratum"]}
    anchor, problems = anchors((Path(repo) / sample["criteria"]).read_text())["Relevance"], statements(repo, topic)
    return [(r, checker_prompt(topic, r, packets[r["stratum"]][r["order_rank"]], cited.get(r["id"], []), anchor, problems, fetch)) for r in rows]


def parse_vote(text):
    match = VOTE.match((text or "").strip())
    if not match:
        raise TopicError(f"the reply is not 'answer: yes|no' then 'reason: ...': {(text or '')[:120]!r}")
    return {"answer": match.group(1).lower(), "reason": match.group(2).strip()}


def checker_option(spec):
    parts = spec.split(":")
    if len(parts) not in (2, 3) or parts[0] not in ("claude", "agy") or not parts[1] or (parts[0] == "agy" and len(parts) == 3):
        raise TopicError(f"--checker {spec!r} reads claude:<model>[:<effort>] or agy:<model>")
    return {"cli": parts[0], "model": parts[1], **({"effort": parts[2]} if len(parts) == 3 else {})}


def run_checker(topic, repo, work, option, freeze_sha, fetch):
    work = Path(work)
    if option["model"] == reference_option(topic)["model"]:
        raise TopicError(f"{option['model']} is the reference; a checker is another model")
    path = work / votes_file(option["model"])
    header = {"sweep": topic["sweep"], "set_sha256": sha256_file(work / set_file(BATCH)), "freeze_sha256": freeze_sha,
              "checker": {**option, "effort": option.get("effort") or ("default" if option["cli"] == "claude" else "set by the model id"),
                          "isolation": isolation(option["cli"], False)}}
    saved = json.loads(path.read_text()) if path.is_file() else {**header, "votes": {}, "refused": {}}
    if {k: saved.get(k) for k in header} != header:
        raise TopicError(f"{path.name} was written for another freeze, set or checker setup; move it aside to start again")
    for row, prompt in checker_prompts(topic, repo, work, fetch):
        if row["id"] in saved["votes"]:
            continue
        for attempt in (1, 2):
            try:
                out, status, left = call_isolated(fetch, session_command(option, prompt, False), work, f"citation-check-{option['model']}")
                if left:
                    raise TopicError(f"the session left files behind: {left[:5]}")
                text, served = reply_text(option, out, status)
                saved["votes"][row["id"]] = {**parse_vote(text), "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "served": served}
                saved["refused"].pop(row["id"], None)
                break
            except TopicError as error:
                if attempt == 2:
                    saved["refused"][row["id"]] = str(error)[:300]
        path.write_text(json.dumps(saved, indent=1, ensure_ascii=False) + "\n")
    return saved


def import_votes(topic, work, saved_list, freeze_sha):
    work = Path(work)
    if len(saved_list) != CHECKERS:
        raise TopicError(f"a model check takes three checkers' votes, not {len(saved_list)}")
    models = [(s.get("checker") or {}).get("model") if isinstance(s, dict) else None for s in saved_list]
    if len(set(models)) != CHECKERS or None in models:
        raise TopicError(f"the votes come from {models}; a model check takes three different models")
    reference = reference_option(topic)["model"]
    if reference in models:
        raise TopicError(f"{reference} is the reference; it never checks its own labels")
    set_sha = sha256_file(work / set_file(BATCH))
    rows = drawn(topic["sweep"], json.loads((work / labels_file(BATCH)).read_text())["rows"])
    for model, saved in zip(models, saved_list):
        if (saved.get("sweep"), saved.get("set_sha256"), saved.get("freeze_sha256")) != (topic["sweep"], set_sha, freeze_sha):
            raise TopicError(f"{model}'s votes were saved for another freeze (freeze sha256 {str(saved.get('freeze_sha256'))[:16]}); this freeze is {freeze_sha[:16]}")
        for row in rows:
            vote = (saved.get("votes") or {}).get(row["id"])
            if not isinstance(vote, dict) or vote.get("answer") not in ("yes", "no"):
                raise TopicError(f"{model} has no vote on {row['id']}; run its checker again before the import")
    out_rows = []
    for row in rows:
        votes = {m: s["votes"][row["id"]]["answer"] for m, s in zip(models, saved_list)}
        answer = max(("yes", "no"), key=list(votes.values()).count)
        out_rows.append({"id": row["id"], "kind": row["kind"], "answer": answer, "unsupported": answer == UNSUPPORTED[row["kind"]], "votes": votes,
                         "any_unsupported": UNSUPPORTED[row["kind"]] in votes.values()})
    out = summary(freeze_sha, out_rows)
    any_count = sum(r["any_unsupported"] for r in out_rows)
    return {**out, "checkers": [s["checker"] for s in saved_list], "unsupported_any": any_count, "straddle": any_count >= STOP_AT and not out["stopped"]}
