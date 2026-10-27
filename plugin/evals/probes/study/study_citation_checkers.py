import hashlib
import json
import re
from pathlib import Path

from study_calibration_set import anchors, labels_file, set_file
from study_citation_check import BATCH, STOP_AT, UNSUPPORTED, check_rows, sha256_file, statements, summary
from study_reference_labels import cites_file, packet_rows, reference_option
from study_screening_input import read_file
from study_session import LEDGER, MAX_PROMPT, append_lines, aperture_call, aperture_reply, call_isolated, isolation, session_command, spend_line
from study_session_reply import reply_text
from study_topic import TopicError, saigon_today

FILE_BYTES, CHECKERS = 10_000, (2, 3)
VOTE = re.compile(r"^answer:\s*(yes|no)\s*\nreason:\s*(\S.*)$", re.IGNORECASE)
REPLY_FORMAT = "Reply with exactly two lines and nothing else:\nanswer: yes  (or: answer: no)\nreason: <one sentence naming the file and the line that decides it>"
RULES = ("You check one label of a repository against its files. You have no tools in this session: do not run commands, read files, browse or search. "
         "Everything you may use is in this message; answer from the files below only and do not guess what other files hold.")
RULES_SHA256 = hashlib.sha256(f"{RULES}\n{REPLY_FORMAT}".encode()).hexdigest()


def votes_file(model):
    return f"citation-check-votes-{model.replace('/', '--')}.json"


def file_body(fetch, packet, path):
    entry = read_file(fetch, packet["repo"], packet["sha"], path, FILE_BYTES)
    if entry.get("error"):
        return f"(not readable at the pinned commit: {entry['error']})", False
    if entry.get("binary"):
        return "(binary file, not shown)", False
    return entry["text"], entry["truncated"]


def file_block(path, body, cap):
    text, cut = body
    data = text.encode()
    if len(data) > cap:
        text, cut = data[:cap].decode(errors="ignore"), True
    return f'<file path="{path}">\n{text}' + (f"\n(cut at {cap} bytes)" if cut else "") + "\n</file>"


def with_files(parts, fetch, packet, paths):
    bodies = {p: file_body(fetch, packet, p) for p in paths}
    fixed = len("\n\n".join(parts(lambda _: "")).encode()) + sum(len(file_block(p, ("", False), FILE_BYTES).encode()) + 40 for p in paths)
    cap = min(FILE_BYTES, (MAX_PROMPT - fixed) // max(len(paths), 1))
    if cap <= 0:
        raise TopicError(f"the check prompt leaves no room for the {len(paths)} files it shows")
    return "\n\n".join(parts(lambda p: file_block(p, bodies[p], cap)))


def checker_prompt(topic, row, packet, mechanisms, anchor, problems, fetch):
    meaning = (topic.get("eligibility") or {}).get("en")
    head = [RULES, *([f"What counts: {meaning}"] if meaning and meaning != "-" else []), f"Row: {row['id']}", f"Repository: {packet['repo']} at commit {packet['sha']}"]
    if row["kind"] == "relevance-1":
        cited = list(dict.fromkeys((m["path"], m["problem"]) for m in mechanisms))
        paths = list(dict.fromkeys(p for p, _ in cited))

        def parts(block):
            return [*head, f"The label is Relevance = 1. Criteria anchor: {anchor['1']}", "Each cited file is listed with the problem the label says it carries a mechanism for:",
                    *(f"- {path}: {problem}: {problems.get(problem, '')}" for path, problem in cited), *(block(p) for p in paths),
                    "Question: Does at least one cited file carry a mechanism for the problem listed beside it?", REPLY_FORMAT]
    else:
        paths = [a["path"] for a in packet.get("assets") or []]

        def parts(block):
            return [*head, f"The label is Relevance = 0. Criteria anchor: {anchor['0']}", f"What counts as a mechanism (the Relevance 1 anchor): {anchor['1']}",
                    "Problems:", *(f"- {p}: {s}" for p, s in problems.items()),
                    *([block(p) for p in paths] or ["(the inputs hold no agent-asset file)"]), "Question: Does any of these files carry a mechanism for a listed problem?",
                    REPLY_FORMAT]
    prompt = with_files(parts, fetch, packet, paths)
    if len(prompt.encode()) > MAX_PROMPT:
        raise TopicError(f"the check prompt for {row['id']} is {len(prompt.encode())} bytes, over {MAX_PROMPT}")
    return prompt


def checker_prompts(topic, repo, work, fetch):
    work = Path(work)
    sample = json.loads((work / set_file(BATCH)).read_text())
    rows = check_rows(topic, work)
    cited = {r["id"]: r.get("mechanisms") or [] for r in json.loads((work / cites_file(BATCH)).read_text())["rows"]}
    packets = {s: packet_rows(work, s) for s in sample["rows_per_stratum"]}
    anchor, problems = anchors((Path(repo) / sample["criteria"]).read_text())["Relevance"], statements(repo, topic)
    return [(r, checker_prompt(topic, r, packets[r["stratum"]][r["order_rank"]], cited.get(r["id"], []), anchor, problems, fetch)) for r in rows]


def parse_vote(text):
    match = VOTE.match((text or "").strip())
    if not match:
        raise TopicError(f"the reply is not 'answer: yes|no' then 'reason: ...': {(text or '')[:120]!r}")
    return {"answer": match.group(1).lower(), "reason": match.group(2).strip()}


def checker_option(spec, endpoint=None):
    parts = spec.split(":")
    if len(parts) not in (2, 3) or parts[0] not in ("claude", "agy", "aperture") or not parts[1] or (parts[0] != "claude" and len(parts) == 3):
        raise TopicError(f"--checker {spec!r} reads claude:<model>[:<effort>], agy:<model> or aperture:<model>")
    if (parts[0] == "aperture") != bool(endpoint):
        raise TopicError("--endpoint names the Aperture URL, and only an aperture:<model> checker takes it")
    return {"cli": parts[0], "model": parts[1], **({"effort": parts[2]} if len(parts) == 3 else {}), **({"endpoint": endpoint.rstrip("/")} if endpoint else {})}


def run_checker(topic, repo, work, option, freeze_sha, fetch):
    work = Path(work)
    if option["model"] == reference_option(topic)["model"]:
        raise TopicError(f"{option['model']} is the reference; a checker is another model")
    path = work / votes_file(option["model"])
    aperture = option["cli"] == "aperture"
    where = "one chat completion over HTTP, no tools offered; stdin closed" if aperture else isolation(option["cli"], False)
    header = {"sweep": topic["sweep"], "set_sha256": sha256_file(work / set_file(BATCH)), "freeze_sha256": freeze_sha,
              "checker": {**option, "effort": option.get("effort") or ("default" if option["cli"] == "claude" else "set by the model id"),
                          "isolation": where, "prompt_rules_sha256": RULES_SHA256}}
    saved = json.loads(path.read_text()) if path.is_file() else {**header, "votes": {}, "refused": {}}
    if {k: saved.get(k) for k in header} != header:
        raise TopicError(f"{path.name} was written for another freeze, set or checker setup; move it aside to start again")
    key, today = f"citation-check-{option['model'].replace('/', '--')}", saigon_today()
    for row, prompt in checker_prompts(topic, repo, work, fetch):
        if row["id"] in saved["votes"]:
            continue
        for attempt in (1, 2):
            out, status, left = aperture_call(fetch, option, prompt, row["id"], work, key) if aperture else call_isolated(fetch, session_command(option, prompt, False), work, key)
            try:
                if left:
                    raise TopicError(f"the session left files behind: {left[:5]}")
                text, served = aperture_reply(option, out, status) if aperture else reply_text(option, out, status)
                saved["votes"][row["id"]] = {**parse_vote(text), "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "served": served}
                saved["refused"].pop(row["id"], None)
                append_lines({work / LEDGER: spend_line({"today": today, "key": key, "ranks": [row["id"]], "option": option}, out, prompt)})
                break
            except TopicError as error:
                append_lines({work / LEDGER: spend_line({"today": today, "key": key, "ranks": [row["id"]], "option": option}, out, prompt, str(error)[:300])})
                if attempt == 2:
                    saved["refused"][row["id"]] = str(error)[:300]
        path.write_text(json.dumps(saved, indent=1, ensure_ascii=False) + "\n")
    return saved


def import_votes(topic, work, saved_list, freeze_sha):
    work = Path(work)
    if len(saved_list) not in CHECKERS:
        raise TopicError(f"a model check takes two or three checkers' votes, not {len(saved_list)}")
    models = [(s.get("checker") or {}).get("model") if isinstance(s, dict) else None for s in saved_list]
    if len(set(models)) != len(models) or None in models:
        raise TopicError(f"the votes come from {models}; a model check takes different models")
    reference = reference_option(topic)["model"]
    if reference in models:
        raise TopicError(f"{reference} is the reference; it never checks its own labels")
    set_sha = sha256_file(work / set_file(BATCH))
    rows = check_rows(topic, work)
    for model, saved in zip(models, saved_list):
        if (saved.get("sweep"), saved.get("set_sha256"), saved.get("freeze_sha256")) != (topic["sweep"], set_sha, freeze_sha):
            raise TopicError(f"{model}'s votes were saved for another freeze (freeze sha256 {str(saved.get('freeze_sha256'))[:16]}); this freeze is {freeze_sha[:16]}")
        for row in rows:
            vote = (saved.get("votes") or {}).get(row["id"])
            if not isinstance(vote, dict) or vote.get("answer") not in ("yes", "no"):
                raise TopicError(f"{model} has no vote on {row['id']}; run its checker again before the import")
    out_rows, rule = [], "majority" if len(models) == 3 else "either"
    for row in rows:
        votes = {m: s["votes"][row["id"]]["answer"] for m, s in zip(models, saved_list)}
        bad = UNSUPPORTED[row["kind"]]
        answer = max(("yes", "no"), key=list(votes.values()).count) if rule == "majority" else (bad if bad in votes.values() else next(iter(votes.values())))
        out_rows.append({"id": row["id"], "kind": row["kind"], "answer": answer, "unsupported": answer == UNSUPPORTED[row["kind"]], "votes": votes,
                         "any_unsupported": UNSUPPORTED[row["kind"]] in votes.values()})
    out = summary(freeze_sha, out_rows)
    any_count = sum(r["any_unsupported"] for r in out_rows)
    return {**out, "checkers": [s["checker"] for s in saved_list], "rule": rule, "unsupported_any": any_count, "straddle": any_count >= STOP_AT and not out["stopped"]}
