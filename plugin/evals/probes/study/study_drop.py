import json
import re
from pathlib import Path

from study_screening_input import holds_inputs, inputs_file
from study_session import update_meta
from study_topic import TopicError

SCREEN_KEY = re.compile(r"^([a-z0-9]+)-([AB])$")
PILOT_KEY = re.compile(r"^([a-z0-9]+)-pilot-")
DROP_SUFFIX = re.compile(r"\.(?:block\.json|rows\.jsonl|inputs\.jsonl)$")
RETIRABLE = re.compile(r"^(?:[a-z0-9]+-audit-.+|qgs-cross-.+)$")


def free_name(folder, stem):
    n = 1
    while any(folder.glob(f"{stem}-{n}.*")):
        n += 1
    return f"{stem}-{n}"


def rewrite(path, lines):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("".join(lines))
    temporary.replace(path)


def drop_checks(folder):
    folder = Path(folder)
    drops = json.loads((folder / "meta.json").read_text()).get("drops") or []
    for drop in drops:
        where = f"the drop of {drop.get('key')} ranks {drop.get('ranks')}"
        if not str(drop.get("reason") or "").strip():
            raise TopicError(f"{where} records no reason")
        if not re.fullmatch(r"dropped/[\w.-]+", str(drop.get("copy") or "")) or not (folder / f"{drop['copy']}.block.json").is_file():
            raise TopicError(f"{where} has no copy of its block in the sweep folder")
    copies = {drop["copy"] for drop in drops}
    loose = sorted({f"dropped/{re.sub(DROP_SUFFIX, '', p.name)}" for p in (folder / "dropped").glob("*")} - copies) if (folder / "dropped").is_dir() else []
    if loose:
        raise TopicError(f"{', '.join(loose)}: a dropped copy without its meta.json drops entry; a run is dropped only by drop-run.py, which records both")


def retire_run(work, key, reason, today):
    work = Path(work)
    if not isinstance(reason, str) or not reason.strip():
        raise TopicError("a retired run needs a reason, recorded in meta.json")
    if not RETIRABLE.match(key):
        raise TopicError(f"{key} is a roster session: production judges are run again after a drop, never retired; only a cross-family audit or QGS run is retired")
    rows_file = work / f"{file_stem(key)}.jsonl"

    def change(meta):
        entry = (meta.get("sessions") or {}).get(key)
        if entry is None:
            raise TopicError(f"meta.json records no session {key}")
        if any(r.get("key") == key for r in meta.get("retired") or []):
            raise TopicError(f"{key} is already retired")
        if entry.get("blocks"):
            raise TopicError(f"{key} still records blocks; drop each with drop-run.py before it is retired")
        if not any(d.get("key") == key for d in meta.get("drops") or []):
            raise TopicError(f"meta.json records no drop of {key}; a run is retired only after drop-run.py dropped its blocks")
        if rows_file.is_file() and rows_file.read_text().strip():
            raise TopicError(f"{rows_file.name} still holds rows; drop them with drop-run.py first")
        meta.setdefault("retired", []).append({"key": key, "reason": reason.strip(), "date": today})

    update_meta(work, change)
    rows_file.unlink(missing_ok=True)


def file_stem(key):
    screen = SCREEN_KEY.match(key)
    return f"{screen.group(1)}-screen-{screen.group(2)}" if screen else key


def inputs_stratum(key):
    found = SCREEN_KEY.match(key) or PILOT_KEY.match(key)
    return found.group(1) if found else None


def drop_block(work, key, first, last, reason, today):
    work = Path(work)
    if not isinstance(reason, str) or not reason.strip():
        raise TopicError("a dropped block needs a reason, recorded in meta.json")
    stem = file_stem(key)
    rows_file, mech_file = work / f"{stem}.jsonl", work / f"{stem}-mechanisms.md"
    stratum = inputs_stratum(key)
    inputs = inputs_file(work, stratum) if stratum else None
    dropped = work / "dropped"

    def change(meta):
        sessions = meta.setdefault("sessions", {})
        entry = sessions.get(key)
        blocks = [b for b in (entry or {}).get("blocks", []) if b["ranks"] and b["ranks"][0] == first and b["ranks"][-1] == last]
        if not blocks:
            raise TopicError(f"meta.json sessions.{key} holds no block for ranks {first}-{last}")
        if not rows_file.is_file():
            raise TopicError(f"no {rows_file.name} in {work}; the block's rows cannot be dropped with it")
        block, ranks = blocks[0], set(blocks[0]["ranks"])
        dropped.mkdir(exist_ok=True)
        name = free_name(dropped, f"{stem}-{first}-{last}")
        (dropped / f"{name}.block.json").write_text(json.dumps(block, indent=1) + "\n")
        lines = rows_file.read_text().splitlines(keepends=True)
        (dropped / f"{name}.rows.jsonl").write_text("".join(lines))
        kept = [line for line in lines if line.strip() and json.loads(line)["order_rank"] not in ranks]
        rewrite(rows_file, kept)
        added = set(block.get("mechanisms_added", []))
        if added and mech_file.is_file():
            rewrite(mech_file, [line for line in mech_file.read_text().splitlines(keepends=True) if line.split(":", 1)[0] not in added])
        entry["blocks"] = [b for b in entry["blocks"] if b is not block]
        free = set()
        if inputs is not None:
            still = {r for k, e in sessions.items() if holds_inputs(k, stratum) for b in e.get("blocks", []) for r in b["ranks"]}
            free = ranks - still
            if free and inputs.is_file():
                held = inputs.read_text().splitlines(keepends=True)
                (dropped / f"{name}.inputs.jsonl").write_text("".join(line for line in held if line.strip() and json.loads(line)["order_rank"] in free))
                rewrite(inputs, [line for line in held if line.strip() and json.loads(line)["order_rank"] not in free])
        meta.setdefault("drops", []).append({"key": key, "ranks": [first, last], "rows": len(lines) - len(kept), "reason": reason.strip(), "date": today, "copy": f"dropped/{name}"})
        return len(lines) - len(kept), sorted(free), name, sorted(added)

    return update_meta(work, change)
