from study_screening_core import read_jsonl
from study_topic import TopicError

HEADER_FIELDS = ("model", "effort", "cli_version")
BLOCK_FIELDS = ("packet_sha256", "criteria_sha256", "inputs_sha256", "date")


def session_keys(folder, strata):
    for stratum in strata:
        for side in "AB":
            if not (folder / f"{stratum}-screen-{side}.jsonl").is_file():
                raise TopicError(f"{stratum}: no {stratum}-screen-{side}.jsonl in {folder}; every screened stratum needs both sessions")
    screen = [(p.stem.replace("-screen-", "-"), p) for p in sorted(folder.glob("*-screen-[AB].jsonl"))]
    return screen + [(p.stem, p) for p in sorted(folder.glob("*-pilot-*.jsonl"))]


def checked_entry(sessions, key, path, frozen):
    entry = sessions.get(key)
    if not isinstance(entry, dict) or not entry.get("blocks"):
        raise TopicError(f"meta.json sessions.{key} is missing or has no blocks; run-screening-session.py records every block")
    for field in HEADER_FIELDS:
        if not entry.get(field):
            raise TopicError(f"meta.json sessions.{key} lacks {field}")
    for block in entry["blocks"]:
        for field in BLOCK_FIELDS:
            if not block.get(field):
                raise TopicError(f"meta.json sessions.{key} has a block without {field}")
        if frozen and (block["packet_sha256"], block["criteria_sha256"]) != (frozen["packet_sha256"], frozen["criteria_sha256"]):
            raise TopicError(f"meta.json sessions.{key}: a block ran under a packet or criteria other than the frozen ones")
    covered = {r for block in entry["blocks"] for r in block["ranks"]}
    rows = {r["order_rank"] for r in read_jsonl(path.parent, path.name)}
    if rows != covered:
        raise TopicError(f"meta.json sessions.{key}: its blocks cover ranks {sorted(covered ^ rows)} that {path.name} does not, or the reverse")
    return entry


def row_hashes(entry):
    return {r: h for block in entry["blocks"] for r, h in block["row_sha256"].items()}


def session_lines(folder, meta, strata, freeze):
    sessions, lines = meta.get("sessions") or {}, []
    for key, path in session_keys(folder, strata):
        stratum = key.split("-", 1)[0]
        frozen = None if "-pilot-" in key else freeze["strata"][stratum]
        entry = checked_entry(sessions, key, path, frozen)
        blocks = "; ".join(f"ranks {b['ranks'][0]}-{b['ranks'][-1]} packet `{b['packet_sha256'][:16]}` inputs `{b['inputs_sha256'][:16]}` {b['date']}" for b in entry["blocks"])
        lines.append(f"- {key}: {entry.get('cli', '-')} {entry['model']} ({entry['cli_version']}), effort {entry['effort']}; {blocks}")
    for stratum in strata:
        a, b = row_hashes(sessions[f"{stratum}-A"]), row_hashes(sessions[f"{stratum}-B"])
        differ = sorted(int(r) for r in set(a) & set(b) if a[r] != b[r])
        if differ:
            raise TopicError(f"{stratum}: sessions A and B scored different inputs for ranks {differ}")
    return lines, sessions
