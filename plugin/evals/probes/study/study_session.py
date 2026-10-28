import bisect
import contextlib
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
from study_session_prompt import (QGS_TEMPLATE_SHA256, REFERENCE_TEMPLATE_SHA256, STAGE1_TEMPLATE_SHA256, build_qgs_prompt, build_stage1_prompt, criteria_version,
                                  reference_prompt_parts, screening_prompt_parts, template_sha256, with_computed_date)
from study_session_reply import parse_qgs_reply, parse_reference_reply, parse_reply, reply_body, reply_text
from study_topic import TopicError

MAX_PROMPT = 120_000
STAGE1_BATCH_MAX = 100
AGY_TIMEOUT = "600s"
NO_BARE_THREAT = "plugin hooks not excluded (no --bare)"
AGY_THREAT = "agy MCP servers, hooks and user settings not excluded"
CLAUDE_ISOLATION = ("--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--max-turns", "1")
AGY_ISOLATION = ("--disable-slash-commands",)
CACHED_PREFIX = ("--exclude-dynamic-system-prompt-sections", "--append-system-prompt")
SESSION_FIELDS = ("cli", "model", "effort", "isolation", "served")
LEDGER = "claude-spend-ledger.jsonl"


class ReplyRefused(TopicError):
    pass


def model_family(model):
    return re.split(r"[-.]", model.lower(), maxsplit=1)[0]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha256(value):
    return sha256_bytes(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def claude_flags(bare):
    return ("--bare", *CLAUDE_ISOLATION) if bare else CLAUDE_ISOLATION


def isolation(cli, bare, shared=False, endpoint=None, split=False):
    if cli == "aperture":
        return f"one chat completion to {endpoint}/v1/chat/completions, no tools offered; stdin closed"
    system = "<everything before the first row>" if shared else "<the packet and the criteria>" if split else None
    flags = (*claude_flags(bare), *((*CACHED_PREFIX, system) if system else ())) if cli == "claude" else AGY_ISOLATION
    folder = "a fixed empty working folder per session key, emptied before each call" if shared else "empty temporary working folder"
    return " ".join(f or "''" for f in flags) + f"; {folder}; stdin closed"


def session_command(option, prompt, bare, system=None):
    if option["cli"] == "claude":
        effort = ["--effort", option["effort"]] if option.get("effort") else []
        cached = [*CACHED_PREFIX, system] if system is not None else []
        return ["claude", "-p", "--model", option["model"], *effort, "--output-format", "json", *claude_flags(bare), *cached, "--", prompt]
    return ["agy", "--model", option["model"], "--output-format", "stream-json", "--print-timeout", AGY_TIMEOUT, *AGY_ISOLATION, "--print", prompt]


def session_header(option, bare, shared=False, split=False):
    effort = option.get("effort") or ("default" if option["cli"] == "claude" else "set by the model id")
    served = {"claude": "modelUsage must name only the requested model", "aperture": "the completion's model must be the requested model"}.get(
        option["cli"], "requested only: agy reports no served model")
    threats = [AGY_THREAT] if option["cli"] == "agy" else []
    return {"cli": option["cli"], "model": option["model"], "effort": effort, "isolation": isolation(option["cli"], bare, shared, option.get("endpoint"), split),
            "served": served, "threats": threats}


def split_prompt(job):
    return job.get("kind", "screening") == "screening" and job["option"]["cli"] in ("claude", "aperture")


def job_header(job):
    return session_header(job["option"], job["bare"], job.get("kind") == "reference", split_prompt(job) and job["option"]["cli"] == "claude")


def session_folder(work, key):
    return Path(tempfile.gettempdir()) / f"study-session-{sha256_bytes(f'{Path(work).resolve()}:{key}'.encode())[:16]}"


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
    existing = sessions.get(key, {})
    sessions[key] = {**header, "blocks": existing.get("blocks", []) + [block], **({"refused": existing["refused"]} if "refused" in existing else {})}


def record_refusal(job, rank, reason):
    header = job_header(job)

    def change(sessions):
        check_header(sessions, job["key"], header, [])
        entry = sessions.setdefault(job["key"], {**header, "blocks": []})
        entry.setdefault("refused", []).append({"rank": rank, "reason": reason, "date": job["today"]})

    update_sessions(job["work"], change)


@contextlib.contextmanager
def working_folder(work=None, key=None):
    if key is None:
        cwd = Path(tempfile.mkdtemp(prefix="screening-session-"))
        try:
            yield cwd
        finally:
            shutil.rmtree(cwd)
        return
    folder = session_folder(work, key)
    with open(Path(work) / f"{key}.session.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TopicError(f"another session holds {folder}; one session key runs one call at a time") from None
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
        try:
            yield folder
        finally:
            shutil.rmtree(folder)


def call_isolated(fetch, cmd, work=None, key=None):
    with working_folder(work, key) as cwd:
        out, status, _ = fetch.run(cmd, timeout=1800, cwd=str(cwd))
        left = sorted(p.name for p in cwd.iterdir())
    return out, status, left


def aperture_call(fetch, option, prompt, call_id, work=None, key=None):
    folder = Path(tempfile.mkdtemp(prefix="study-aperture-"))
    try:
        body = folder / f"aperture-{call_id}.json"
        body.write_text(json.dumps({"model": option["model"], "messages": [{"role": "user", "content": prompt}]}, ensure_ascii=False))
        return call_isolated(fetch, ["curl", "-sS", "-m", "900", "-H", "Content-Type: application/json", "--data-binary", f"@{body}",
                                     f"{option['endpoint']}/v1/chat/completions"], work, key)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def aperture_reply(option, out, status):
    where = f"aperture {option['model']}"
    if status != "ok":
        raise TopicError(f"{where}: {status}")
    try:
        body = json.loads(out)
        message = body["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise TopicError(f"{where}: the reply is not a chat completion: {str(out)[:200]}") from error
    if message.get("tool_calls"):
        raise TopicError(f"{where}: the reply holds a tool call; a check session has no tools")
    if body.get("model") != option["model"]:
        raise TopicError(f"{where}: served {body.get('model')}, not the requested {option['model']}")
    return message.get("content") or "", [body["model"]]


def aperture_listed(fetch, option):
    url = f"{option['endpoint']}/v1/models"
    out, status, _ = fetch.run(["curl", "-sS", "-m", "60", url], timeout=90)
    try:
        listed = [m.get("id") for m in json.loads(out)["data"]] if status == "ok" else []
    except (ValueError, KeyError, TypeError, AttributeError):
        listed = []
    if option["model"] not in listed:
        raise TopicError(f"{option['model']} is not listed at {url}" + ("" if status == "ok" else f" ({status})"))
    return f"aperture: {option['model']} listed at {url}"


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


def block_parts(job, rows):
    work, stratum, kind = Path(job["work"]), job["stratum"], job.get("kind", "screening")
    packet = (work / (job.get("packet") or f"screening-packet-{stratum}.md")).read_text()
    if kind == "screening":
        mech_file = work / f"{job['name']}-mechanisms.md"
        known = mech_file.read_text() if mech_file.is_file() else ""
        return screening_prompt_parts(packet, job["criteria"], (Path(job["repo"]) / job["criteria"]).read_text(), known, rows, job["sweep_date"])
    if kind == "stage1":
        return None, build_stage1_prompt(packet, job["examples"], rows)
    if kind == "reference":
        return reference_prompt_parts(packet, job.get("notes") or [], rows)
    return None, build_qgs_prompt(packet, rows)


def block_prompt(job, rows):
    system, own = block_parts(job, rows)
    return own if system is None else system + "\n\n" + own


def prompt_size(job, rows):
    if split_prompt(job):
        return max(len(part.encode()) for part in block_parts(job, rows))
    return len(block_prompt(job, rows).encode())


def agy_lists(fetch):
    outs = {}
    for name in ("mcp", "plugin"):
        out, status, _ = fetch.run(["agy", name, "list"], timeout=60)
        if status != "ok":
            raise TopicError(f"agy {name} list: {status}")
        outs[name] = out
    return {"mcp_sha256": sha256_bytes(outs["mcp"].encode()), "plugins_sha256": sha256_bytes(outs["plugin"].encode()),
            "context_mode_enabled": any(line.split()[:1] == ["context-mode"] and "enabled" in line.split() for line in outs["mcp"].splitlines()),
            "ponytail_enabled": re.search(r"^- ponytail \(enabled\b", outs["plugin"], re.M) is not None}


def spend_line(job, out, prompt, refused=None):
    body = reply_body(job["option"]["cli"], out)
    served = sorted(body["modelUsage"]) if isinstance(body.get("modelUsage"), dict) else None
    return json.dumps({"date": job["today"], "key": job["key"], "ranks": job["ranks"], "model": job["option"]["model"], "effort": job["option"].get("effort"),
                       "total_cost_usd": body.get("total_cost_usd"), "usage": body.get("usage"), "duration_ms": body.get("duration_ms"), "num_turns": body.get("num_turns"),
                       "served_models": served, "prompt_bytes": len(prompt.encode()), **({"refused": refused} if refused else {})}, ensure_ascii=False) + "\n"


def run_blocks(job, ranks, fetch, most=STAGE1_BATCH_MAX):
    if not ranks:
        return 0, 0
    work, stratum, kind = Path(job["work"]), job["stratum"], job.get("kind", "screening")
    rows = {r: shaped(kind, row) for r, row in expected_rows({**job, "ranks": ranks}, work, stratum).items()}
    left, written, blocks = list(rows), 0, 0
    while left:
        fits = bisect.bisect_right(range(1, min(most, len(left)) + 1), MAX_PROMPT, key=lambda n: prompt_size(job, [rows[r] for r in left[:n]]))
        size = max(fits, 1)
        written += run_block({**job, "ranks": left[:size]}, fetch)
        left, blocks = left[size:], blocks + 1
    return written, blocks


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
    template = {"screening": template_sha256(job.get("criteria")), "qgs": QGS_TEMPLATE_SHA256, "stage1": STAGE1_TEMPLATE_SHA256, "reference": REFERENCE_TEMPLATE_SHA256}[kind]
    hashes = {"packet_sha256": sha256_bytes(packet.read_bytes()), **({"criteria_sha256": sha256_bytes(criteria.read_bytes())} if screening else {}),
              **({"examples_sha256": sha256_bytes(job["examples"].encode())} if kind == "stage1" else {})}
    frozen = job.get("frozen")
    if frozen and any(frozen.get(k) != v for k, v in {**hashes, "template_sha256": template}.items() if k in frozen):
        changed = f"{packet.name}, the worked examples or the prompt template" if kind == "stage1" else f"the criteria, {packet.name} or the prompt template"
        raise TopicError(f"{stratum}: {changed} differ from the freeze; no session runs on a changed protocol")
    aperture = option["cli"] == "aperture"
    if aperture:
        cli_version = aperture_listed(fetch, option)
    else:
        version, status, _ = fetch.run([option["cli"], "--version"], timeout=60)
        if status != "ok":
            raise TopicError(f"{option['cli']} --version: {status}")
        cli_version = version.strip().splitlines()[0] if version.strip() else "unknown"
    reference = kind == "reference"
    header = job_header(job)
    update_sessions(work, lambda sessions: check_header(sessions, job["key"], header, list(expected)))
    if job.get("pilot"):
        snapshot = work / f"screening-packet-{stratum}-pilot-{hashes['packet_sha256'][:12]}.md"
        if not snapshot.exists():
            shutil.copyfile(packet, snapshot)
    mech_file = work / f"{name}-mechanisms.md"
    known = mech_file.read_text() if mech_file.is_file() else ""
    parts = block_parts(job, list(expected.values()))
    prompt = parts[1] if parts[0] is None else parts[0] + "\n\n" + parts[1]
    size = prompt_size(job, list(expected.values()))
    if size > MAX_PROMPT:
        raise TopicError(f"the prompt for ranks {first}-{last} needs an argument of {size} bytes, over {MAX_PROMPT}; run a smaller block")
    prompts = work / "prompts"
    prompts.mkdir(exist_ok=True)
    stem = f"{name}-{first}-{last}"
    (prompts / f"{stem}.md").write_text(prompt)
    lists = reference and option["cli"] == "agy"
    before = agy_lists(fetch) if lists else None
    system, own = parts if option["cli"] == "claude" and parts[0] is not None else (None, prompt)
    if system is not None and system.startswith("-"):
        raise TopicError(f"the system prompt for ranks {first}-{last} starts with a dash, which claude could read as a flag; start the packet with a heading")
    keyed = (work, job["key"]) if reference else ()
    out, status, left = aperture_call(fetch, option, own, stem, *keyed) if aperture else call_isolated(fetch, session_command(option, own, job["bare"], system), *keyed)

    def spend(reason=None):
        if reference or option["cli"] == "claude":
            append_lines({work / LEDGER: spend_line({**job, "ranks": list(expected)}, out, prompt, reason)})

    def refusal(reason, kind_of=ReplyRefused):
        spend(reason)
        return kind_of(reason)

    if left:
        raise refusal(f"the session wrote {left} into its empty working folder; a screening session has no tools", TopicError)
    try:
        after = agy_lists(fetch) if lists else None
    except TopicError as error:
        raise refusal(str(error), TopicError) from error

    try:
        text, served = aperture_reply(option, out, status) if aperture else reply_text(option, out, status)
    except TopicError as error:
        raise refusal(str(error)) from error
    if screening:
        rows, mechanisms, problems = parse_reply(text, expected, (job.get("problems") or []) if criteria_version(job.get("criteria")) >= 4 else None)
        rows = [with_computed_date(r, expected[r["order_rank"]], job["sweep_date"]) for r in rows]
    elif kind == "reference":
        (rows, problems), mechanisms = parse_reference_reply(text, expected, job["problems"]), []
    else:
        (rows, problems), mechanisms = parse_qgs_reply(text, expected, job["problems"], ("yes", "unsure", "no"), kind == "qgs"), []
    if problems:
        (prompts / f"{stem}.response.txt").write_text(text)
        raise refusal(f"{name} ranks {first}-{last}: {'; '.join(problems)}; reply kept in prompts/{stem}.response.txt, no row written")
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
             **({"held_out_labels_sha256": job["held_out_labels_sha256"]} if job.get("held_out_labels_sha256") else {}),
             **({"reference_freeze_sha256": job["reference_freeze_sha256"]} if job.get("reference_freeze_sha256") else {}),
             **({"notes_sha256": job["notes_sha256"]} if job.get("notes_sha256") else {}),**({"agy_lists": {"before": before, "after": after}} if lists else {})}
    undo = []

    def commit(sessions):
        add_block(sessions, job["key"], header, block)
        files = {work / f"{name}.jsonl": "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), **({mech_file: "".join(fresh)} if screening else {})}
        undo.append(append_lines(files))

    try:
        update_sessions(work, commit, lambda: undo and undo[0]())
    except BaseException as error:
        spend(f"the block was not recorded: {error!r}")
        raise
    spend()
    return len(rows)
