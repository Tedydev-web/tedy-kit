import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from study_screening_core import read_jsonl
from study_screening_input import inputs_file
from study_session_reply import parse_reply, reply_text
from study_topic import TopicError

MAX_PROMPT = 120_000
AGY_TIMEOUT = "600s"
CLAUDE_ISOLATION = ("--bare", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--max-turns", "1")
AGY_ISOLATION = ("--disable-slash-commands",)
SESSION_FIELDS = ("cli", "model", "effort", "cli_version", "isolation", "served")
ROWS_NOTE = ("Each row below is one JSON object: the pinned commit, the repository facts from discovery, the top-level listing, the README excerpt and up to two asset files "
             "read at that commit. Score only from these inputs; you have no tools. A row with an error field could not be read: code it dead.")
REPLY_FORMAT = ("## Reply format\n\nReply with nothing but these lines. One JSON object per row, on one line, in order_rank order, with the fields order_rank, repo, file, "
                "scores (an object of the seven cells Authority, Methodology, Objectivity, Date, Position, Novelty, Relevance, each {\"v\": 1 | 0.5 | 0, \"why\": \"...\"}), "
                "mechanisms (names), new (true when a mechanism is new to you), decision (eligible, or exclude: <code>) and note. Then one line per mechanism you name "
                "for the first time: mechanism: <kebab-case-name>: <one-line definition>.")


def model_family(model):
    return re.split(r"[-.]", model.lower(), maxsplit=1)[0]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value):
    return sha256_bytes(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def isolation(cli):
    flags = CLAUDE_ISOLATION if cli == "claude" else AGY_ISOLATION
    return " ".join(f or "''" for f in flags) + "; empty temporary working folder; stdin closed"


def session_command(option, prompt):
    if option["cli"] == "claude":
        effort = ["--effort", option["effort"]] if option.get("effort") else []
        return ["claude", "-p", prompt, "--model", option["model"], *effort, "--output-format", "json", *CLAUDE_ISOLATION]
    return ["agy", "--model", option["model"], "--output-format", "json", "--print-timeout", AGY_TIMEOUT, *AGY_ISOLATION, "--print", prompt]


def session_header(option, cli_version):
    effort = option.get("effort") or ("default" if option["cli"] == "claude" else "set by the model id")
    served = "modelUsage must name only the requested model" if option["cli"] == "claude" else "requested only: agy reports no served model"
    return {"cli": option["cli"], "model": option["model"], "effort": effort, "cli_version": cli_version, "isolation": isolation(option["cli"]), "served": served}


def build_prompt(packet, criteria_path, criteria_text, mechanisms_text, rows):
    blocks = ["```json\n" + json.dumps(r, ensure_ascii=False) + "\n```" for r in rows]
    parts = [packet.rstrip(), f"## Criteria ({criteria_path})", criteria_text.rstrip(), "## Your mechanism names so far", mechanisms_text.strip() or "none yet",
             "## Rows", ROWS_NOTE, *blocks, REPLY_FORMAT]
    return "\n\n".join(parts) + "\n"


def update_sessions(work, change):
    meta_file = Path(work) / "meta.json"
    with open(Path(work) / "meta.json.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        meta = json.loads(meta_file.read_text()) if meta_file.is_file() else {}
        result = change(meta.setdefault("sessions", {}))
        temporary = meta_file.with_name(f"meta.json.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
        os.replace(temporary, meta_file)
    return result


def check_header(sessions, key, header, ranks):
    existing = sessions.get(key)
    if existing is None:
        return
    for field in SESSION_FIELDS:
        if existing.get(field) != header[field]:
            raise TopicError(f"meta.json sessions.{key} ran with {field} {existing.get(field)!r}; this block would use {header[field]!r}")
    taken = {r for block in existing["blocks"] for r in block["ranks"]} & set(ranks)
    if taken:
        raise TopicError(f"meta.json sessions.{key} already holds a block for ranks {sorted(taken)}")


def add_block(sessions, key, header, block):
    check_header(sessions, key, header, block["ranks"])
    sessions[key] = {**header, "blocks": sessions.get(key, {}).get("blocks", []) + [block]}


def call_isolated(fetch, cmd):
    cwd = Path(tempfile.mkdtemp(prefix="screening-session-"))
    try:
        out, status, _ = fetch.run(cmd, timeout=1800, cwd=str(cwd))
        left = sorted(p.name for p in cwd.iterdir())
    finally:
        shutil.rmtree(cwd)
    if left:
        raise TopicError(f"the session wrote {left} into its empty working folder; a screening session has no tools")
    return out, status


def run_block(job, fetch):
    work, stratum, name, option = Path(job["work"]), job["stratum"], job["name"], job["option"]
    inputs = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
    expected = {r: inputs[r] for r in sorted(inputs) if job["first"] <= r <= job["last"]}
    if not expected:
        raise TopicError(f"no fetched {stratum} inputs between ranks {job['first']} and {job['last']}; run fetch-screening-inputs.py first")
    done = {r["order_rank"] for r in read_jsonl(work, f"{name}.jsonl")} & set(expected)
    if done:
        raise TopicError(f"{name}.jsonl already holds ranks {sorted(done)}")
    packet, criteria = work / f"screening-packet-{stratum}.md", Path(job["repo"]) / job["criteria"]
    if not packet.is_file():
        raise TopicError(f"no {packet.name} in {work}")
    hashes = {"packet_sha256": sha256_bytes(packet.read_bytes()), "criteria_sha256": sha256_bytes(criteria.read_bytes())}
    frozen = job.get("frozen")
    if frozen and any(frozen[k] != v for k, v in hashes.items()):
        raise TopicError(f"{stratum}: the criteria or {packet.name} differ from the freeze; no session runs on a changed protocol")
    version, status, _ = fetch.run([option["cli"], "--version"], timeout=60)
    if status != "ok":
        raise TopicError(f"{option['cli']} --version: {status}")
    header = session_header(option, version.strip().splitlines()[0] if version.strip() else "unknown")
    update_sessions(work, lambda sessions: check_header(sessions, job["key"], header, list(expected)))
    if job.get("pilot"):
        snapshot = work / f"screening-packet-{stratum}-pilot-{hashes['packet_sha256'][:12]}.md"
        if not snapshot.exists():
            shutil.copyfile(packet, snapshot)
    mech_file = work / f"{name}-mechanisms.md"
    known = mech_file.read_text() if mech_file.is_file() else ""
    prompt = build_prompt(packet.read_text(), job["criteria"], criteria.read_text(), known, list(expected.values()))
    if len(prompt.encode()) > MAX_PROMPT:
        raise TopicError(f"the prompt for ranks {job['first']}-{job['last']} is {len(prompt.encode())} bytes, over {MAX_PROMPT}; run a smaller block")
    prompts = work / "prompts"
    prompts.mkdir(exist_ok=True)
    stem = f"{name}-{job['first']}-{job['last']}"
    (prompts / f"{stem}.md").write_text(prompt)
    text, served = reply_text(option, *call_isolated(fetch, session_command(option, prompt)))
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
    block = {"ranks": list(expected), **hashes, "inputs_sha256": canonical_sha256(list(expected.values())),
             "row_sha256": {str(r): canonical_sha256(row) for r, row in expected.items()}, "date": job["today"], **({"served_models": served} if served else {})}
    update_sessions(work, lambda sessions: add_block(sessions, job["key"], header, block))
    return len(rows)
