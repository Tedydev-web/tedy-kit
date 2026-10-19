import hashlib
import json
import re
from pathlib import Path

from study_screening_input import inputs_file
from study_screening_core import read_jsonl
from study_topic import TopicError

MAX_PROMPT = 120_000
AGY_TIMEOUT = "600s"
CELLS = ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")
MECHANISM = re.compile(r"^mechanism: ([a-z0-9]+(?:-[a-z0-9]+)*): (\S.*)$")
ROWS_NOTE = ("Each row below is one JSON object: the pinned commit, the repository facts from discovery, the top-level listing, the README excerpt and up to two asset files "
             "read at that commit. Score only from these inputs; you have no tools. A row with an error field could not be read: code it dead.")
REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, file, "
                "scores (an object of the seven cells Authority, Methodology, Objectivity, Date, Position, Novelty, Relevance, each {\"v\": 1 | 0.5 | 0, \"why\": \"...\"}), "
                "mechanisms (names), new (true when a mechanism is new to you), decision (eligible, or exclude: <code>) and note. Then one line per mechanism you name "
                "for the first time: mechanism: <kebab-case-name>: <one-line definition>.")


def model_family(model):
    return re.split(r"[-.]", model.lower(), maxsplit=1)[0]


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def session_command(option, prompt):
    if option["cli"] == "claude":
        effort = ["--effort", option["effort"]] if option.get("effort") else []
        return ["claude", "-p", prompt, "--model", option["model"], *effort, "--output-format", "json", "--tools", "", "--max-turns", "1"]
    return ["agy", "--model", option["model"], "--output-format", "json", "--print-timeout", AGY_TIMEOUT, "--print", prompt]


def reply_text(option, out, status):
    where = f"{option['cli']} {option['model']}"
    if status != "ok":
        raise TopicError(f"{where}: {status}")
    try:
        body = json.loads(out)
    except ValueError as error:
        raise TopicError(f"{where}: reply is not JSON: {error}") from error
    if option["cli"] == "claude":
        if body.get("is_error"):
            raise TopicError(f"{where}: {str(body.get('result'))[:200]}")
        return body.get("result") or "", sorted(body.get("modelUsage") or {})
    if body.get("status") != "SUCCESS":
        raise TopicError(f"{where}: status {body.get('status')}")
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
            problems += issues
            if not issues:
                rows[row["order_rank"]] = {**{k: v for k, v in row.items() if k != "sha"}, "sha": expected[row["order_rank"]].get("sha")}
    problems += [f"rank {rank} missing from the reply" for rank in expected if rank not in rows]
    return [rows[r] for r in sorted(rows)], mechanisms, problems


def build_prompt(packet, criteria_path, criteria_text, mechanisms_text, rows):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    parts = [packet.rstrip(), f"## Criteria ({criteria_path})", criteria_text.rstrip(), "## Your mechanism names so far", mechanisms_text.strip() or "none yet",
             "## Rows", ROWS_NOTE, *blocks, REPLY_FORMAT]
    return "\n\n".join(parts) + "\n"


def record_session(work, key, option, packet_sha, inputs_sha, today, served):
    meta_file = Path(work) / "meta.json"
    meta = json.loads(meta_file.read_text()) if meta_file.is_file() else {}
    entry = {"cli": option["cli"], "model": option["model"], "effort": option.get("effort") or "set by the model id",
             "packet_sha256": packet_sha, "inputs_sha256": inputs_sha, "date": today}
    meta.setdefault("sessions", {})[key] = entry if served is None else {**entry, "served_models": served}
    meta_file.write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")


def run_block(job, fetch):
    work, stratum, name = Path(job["work"]), job["stratum"], job["name"]
    inputs = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
    expected = {r: inputs[r] for r in sorted(inputs) if job["first"] <= r <= job["last"]}
    if not expected:
        raise TopicError(f"no fetched {stratum} inputs between ranks {job['first']} and {job['last']}; run fetch-screening-inputs.py first")
    done = {r["order_rank"] for r in read_jsonl(work, f"{name}.jsonl")} & set(expected)
    if done:
        raise TopicError(f"{name}.jsonl already holds ranks {sorted(done)}")
    packet = work / f"screening-packet-{stratum}.md"
    if not packet.is_file():
        raise TopicError(f"no {packet.name} in {work}")
    mech_file = work / f"{name}-mechanisms.md"
    known = mech_file.read_text() if mech_file.is_file() else ""
    prompt = build_prompt(packet.read_text(), job["criteria"], (Path(job["repo"]) / job["criteria"]).read_text(), known, list(expected.values()))
    if len(prompt.encode()) > MAX_PROMPT:
        raise TopicError(f"the prompt for ranks {job['first']}-{job['last']} is {len(prompt.encode())} bytes, over {MAX_PROMPT}; run a smaller block")
    prompts = work / "prompts"
    prompts.mkdir(exist_ok=True)
    stem = f"{name}-{job['first']}-{job['last']}"
    (prompts / f"{stem}.md").write_text(prompt)
    text, served = reply_text(job["option"], *fetch.run(session_command(job["option"], prompt), timeout=1800)[:2])
    rows, mechanisms, problems = parse_reply(text, expected)
    if problems:
        (prompts / f"{stem}.response.txt").write_text(text)
        raise TopicError(f"{name} ranks {job['first']}-{job['last']}: {'; '.join(problems)}; reply kept in prompts/{stem}.response.txt, nothing written")
    with (work / f"{name}.jsonl").open("a") as out:
        out.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    names, fresh = {line.split(":", 1)[0] for line in known.splitlines()}, []
    for n, d in mechanisms:
        if n not in names:
            names.add(n)
            fresh.append(f"{n}: {d}\n")
    with mech_file.open("a") as out:
        out.write("".join(fresh))
    record_session(work, job["key"], job["option"], sha256_file(packet), sha256_file(inputs_file(work, stratum)), job["today"], served)
    return len(rows)
