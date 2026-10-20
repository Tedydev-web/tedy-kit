import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from study_screening_core import read_jsonl
from study_screening_input import inputs_file, repo_level
from study_session_prompt import (QGS_TEMPLATE_SHA256, STAGE1_TEMPLATE_SHA256, build_prompt, build_qgs_prompt, build_stage1_prompt, criteria_version, template_sha256,
                                  with_computed_date)
from study_session_reply import parse_qgs_reply, parse_reply, reply_text
from study_topic import TopicError

MAX_PROMPT = 120_000
STAGE1_BATCH_MAX = 100
AGY_TIMEOUT = "600s"
NO_BARE_THREAT = "plugin hooks not excluded (no --bare)"
AGY_THREAT = "agy MCP servers, hooks and user settings not excluded"
CLAUDE_ISOLATION = ("--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--max-turns", "1")
AGY_ISOLATION = ("--disable-slash-commands",)
SESSION_FIELDS = ("cli", "model", "effort", "isolation", "served")
def model_family(model):
    return re.split(r"[-.]", model.lower(), maxsplit=1)[0]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value):
    return sha256_bytes(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def claude_flags(bare):
    return ("--bare", *CLAUDE_ISOLATION) if bare else CLAUDE_ISOLATION


def isolation(cli, bare):
    flags = claude_flags(bare) if cli == "claude" else AGY_ISOLATION
    return " ".join(f or "''" for f in flags) + "; empty temporary working folder; stdin closed"


def session_command(option, prompt, bare):
    if option["cli"] == "claude":
        effort = ["--effort", option["effort"]] if option.get("effort") else []
        return ["claude", "-p", "--model", option["model"], *effort, "--output-format", "json", *claude_flags(bare), "--", prompt]
    return ["agy", "--model", option["model"], "--output-format", "stream-json", "--print-timeout", AGY_TIMEOUT, *AGY_ISOLATION, "--print", prompt]


def session_header(option, bare):
    effort = option.get("effort") or ("default" if option["cli"] == "claude" else "set by the model id")
    served = "modelUsage must name only the requested model" if option["cli"] == "claude" else "requested only: agy reports no served model"
    threats = ([NO_BARE_THREAT] if not bare else []) if option["cli"] == "claude" else [AGY_THREAT]
    return {"cli": option["cli"], "model": option["model"], "effort": effort, "isolation": isolation(option["cli"], bare), "served": served, "threats": threats}


def update_sessions(work, change, undo=None):
    return update_meta(work, lambda meta: change(meta.setdefault("sessions", {})), undo)


def update_meta(work, change, undo=None):
    meta_file = Path(work) / "meta.json"
    with open(Path(work) / "meta.json.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            meta = json.loads(meta_file.read_text()) if meta_file.is_file() else {}
            result = change(meta)
            temporary = meta_file.with_name(f"meta.json.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
            os.replace(temporary, meta_file)
        except BaseException:
            if undo:
                undo()
            raise
    return result


def append_lines(files):
    sizes = {path: path.stat().st_size if path.is_file() else None for path in files}

    def undo():
        for path, size in sizes.items():
            if size is None:
                path.unlink(missing_ok=True)
            else:
                with path.open("r+") as handle:
                    handle.truncate(size)

    try:
        for path, text in files.items():
            with path.open("a") as out:
                out.write(text)
    except BaseException:
        undo()
        raise
    return undo


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


def expected_rows(job, work, stratum):
    inputs = {r["order_rank"]: r for r in read_jsonl(work, job.get("inputs") or inputs_file(work, stratum).name)}
    wanted = job.get("ranks")
    if wanted is None:
        expected = {r: inputs[r] for r in sorted(inputs) if job["first"] <= r <= job["last"]}
        if not expected:
            raise TopicError(f"no fetched {stratum} inputs between ranks {job['first']} and {job['last']}; run fetch-screening-inputs.py first")
        return expected
    missing = sorted(set(wanted) - set(inputs))
    if missing or not wanted:
        raise TopicError(f"{stratum} ranks {missing or 'none'} have no fetched inputs; run fetch-screening-inputs.py first")
    return {r: inputs[r] for r in sorted(wanted)}


def qgs_shape(row):
    return {k: v for k, v in row.items() if k not in ("files", "facts")}


def shaped(kind, row):
    return qgs_shape(row) if kind == "qgs" else row


def run_block(job, fetch):
    work, stratum, name, option = Path(job["work"]), job["stratum"], job["name"], job["option"]
    kind = job.get("kind", "screening")
    screening = kind == "screening"
    expected = {r: shaped(kind, row) for r, row in expected_rows(job, work, stratum).items()}
    first, last = min(expected), max(expected)
    if kind == "stage1" and len(expected) > STAGE1_BATCH_MAX:
        raise TopicError(f"a stage-1 batch holds at most {STAGE1_BATCH_MAX} rows; this one holds {len(expected)}")
    transient = [r for r, row in expected.items() if "error" in row and row.get("error_kind") != "permanent"]
    if transient:
        error = expected[transient[0]]["error"]
        hint = ", or mark it permanent with --mark-permanent only if a check by hand finds the repository or commit gone" if repo_level(error) else ""
        raise TopicError(f"rank {transient[0]} has a transient fetch error ({error}); run fetch-screening-inputs.py again{hint}")
    done = {r["order_rank"] for r in read_jsonl(work, f"{name}.jsonl")} & set(expected)
    if done:
        raise TopicError(f"{name}.jsonl already holds ranks {sorted(done)}")
    packet = work / (job.get("packet") or f"screening-packet-{stratum}.md")
    if not packet.is_file():
        raise TopicError(f"no {packet.name} in {work}")
    criteria = Path(job["repo"]) / job["criteria"] if screening else None
    template = {"screening": template_sha256(job.get("criteria")), "qgs": QGS_TEMPLATE_SHA256, "stage1": STAGE1_TEMPLATE_SHA256}[kind]
    hashes = {"packet_sha256": sha256_bytes(packet.read_bytes()), **({"criteria_sha256": sha256_bytes(criteria.read_bytes())} if screening else {}),
              **({"examples_sha256": sha256_bytes(job["examples"].encode())} if kind == "stage1" else {})}
    frozen = job.get("frozen")
    if frozen and any(frozen.get(k) != v for k, v in {**hashes, "template_sha256": template}.items() if k in frozen):
        changed = f"{packet.name}, the worked examples or the prompt template" if kind == "stage1" else f"the criteria, {packet.name} or the prompt template"
        raise TopicError(f"{stratum}: {changed} differ from the freeze; no session runs on a changed protocol")
    version, status, _ = fetch.run([option["cli"], "--version"], timeout=60)
    if status != "ok":
        raise TopicError(f"{option['cli']} --version: {status}")
    cli_version = version.strip().splitlines()[0] if version.strip() else "unknown"
    header = session_header(option, job["bare"])
    update_sessions(work, lambda sessions: check_header(sessions, job["key"], header, list(expected)))
    if job.get("pilot"):
        snapshot = work / f"screening-packet-{stratum}-pilot-{hashes['packet_sha256'][:12]}.md"
        if not snapshot.exists():
            shutil.copyfile(packet, snapshot)
    mech_file = work / f"{name}-mechanisms.md"
    known = mech_file.read_text() if mech_file.is_file() else ""
    if screening:
        prompt = build_prompt(packet.read_text(), job["criteria"], criteria.read_text(), known, list(expected.values()), job["sweep_date"])
    elif kind == "stage1":
        prompt = build_stage1_prompt(packet.read_text(), job["examples"], list(expected.values()))
    else:
        prompt = build_qgs_prompt(packet.read_text(), list(expected.values()))
    if len(prompt.encode()) > MAX_PROMPT:
        raise TopicError(f"the prompt for ranks {first}-{last} is {len(prompt.encode())} bytes, over {MAX_PROMPT}; run a smaller block")
    prompts = work / "prompts"
    prompts.mkdir(exist_ok=True)
    stem = f"{name}-{first}-{last}"
    (prompts / f"{stem}.md").write_text(prompt)
    text, served = reply_text(option, *call_isolated(fetch, session_command(option, prompt, job["bare"])))
    if screening:
        rows, mechanisms, problems = parse_reply(text, expected, (job.get("problems") or []) if criteria_version(job.get("criteria")) >= 4 else None)
        rows = [with_computed_date(r, expected[r["order_rank"]], job["sweep_date"]) for r in rows]
    else:
        (rows, problems), mechanisms = parse_qgs_reply(text, expected, job["problems"], ("yes", "unsure", "no"), kind == "qgs"), []
    if problems:
        (prompts / f"{stem}.response.txt").write_text(text)
        raise TopicError(f"{name} ranks {first}-{last}: {'; '.join(problems)}; reply kept in prompts/{stem}.response.txt, nothing written")
    names, fresh = {line.split(":", 1)[0] for line in known.splitlines()}, []
    for n, d in mechanisms:
        if n not in names:
            names.add(n)
            fresh.append(f"{n}: {d}\n")
    block = {"ranks": list(expected), **hashes, **({} if screening else {"template_sha256": template}), **({"shape": job["shape"]} if job.get("shape") else {}),
             "prompt_sha256": sha256_bytes(prompt.encode()), "inputs_sha256": canonical_sha256(list(expected.values())),
             "row_sha256": {str(r): canonical_sha256(row) for r, row in expected.items()}, "cli_version": cli_version, "date": job["today"],
             "mechanisms_added": [line.split(":", 1)[0] for line in fresh],
             **({"served_models": served} if served else {}), **({"fallback_reason": job["fallback_reason"]} if job.get("fallback_reason") else {}),
             **({"held_out_labels_sha256": job["held_out_labels_sha256"]} if job.get("held_out_labels_sha256") else {})}
    undo = []

    def commit(sessions):
        add_block(sessions, job["key"], header, block)
        files = {work / f"{name}.jsonl": "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), **({mech_file: "".join(fresh)} if screening else {})}
        undo.append(append_lines(files))

    update_sessions(work, commit, lambda: undo and undo[0]())
    return len(rows)
