import json
import sys
from pathlib import Path

from study_screening_input import inputs_file
from study_session import update_sessions
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def free_name(folder, stem):
    n = 1
    while any(folder.glob(f"{stem}-{n}.*")):
        n += 1
    return f"{stem}-{n}"


def rewrite(path, lines):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("".join(lines))
    temporary.replace(path)


def drop_block(work, stratum, key, file_stem, first, last):
    work = Path(work)
    rows_file, mech_file, inputs = work / f"{file_stem}.jsonl", work / f"{file_stem}-mechanisms.md", inputs_file(work, stratum)
    dropped = work / "dropped"

    def change(sessions):
        entry = sessions.get(key)
        blocks = [b for b in (entry or {}).get("blocks", []) if b["ranks"] and b["ranks"][0] == first and b["ranks"][-1] == last]
        if not blocks:
            raise TopicError(f"meta.json sessions.{key} holds no block for ranks {first}-{last}")
        if not rows_file.is_file():
            raise TopicError(f"no {rows_file.name} in {work}; the block's rows cannot be dropped with it")
        block, ranks = blocks[0], set(blocks[0]["ranks"])
        dropped.mkdir(exist_ok=True)
        name = free_name(dropped, f"{file_stem}-{first}-{last}")
        (dropped / f"{name}.block.json").write_text(json.dumps(block, indent=1) + "\n")
        lines = rows_file.read_text().splitlines(keepends=True)
        (dropped / f"{name}.rows.jsonl").write_text("".join(lines))
        rewrite(rows_file, [line for line in lines if line.strip() and json.loads(line)["order_rank"] not in ranks])
        added = set(block.get("mechanisms_added", []))
        if added and mech_file.is_file():
            rewrite(mech_file, [line for line in mech_file.read_text().splitlines(keepends=True) if line.split(":", 1)[0] not in added])
        entry["blocks"] = [b for b in entry["blocks"] if b is not block]
        still = {r for k, e in sessions.items() if k.startswith(f"{stratum}-") for b in e.get("blocks", []) for r in b["ranks"]}
        free = ranks - still
        if free and inputs.is_file():
            held = inputs.read_text().splitlines(keepends=True)
            (dropped / f"{name}.inputs.jsonl").write_text("".join(line for line in held if line.strip() and json.loads(line)["order_rank"] in free))
            rewrite(inputs, [line for line in held if line.strip() and json.loads(line)["order_rank"] not in free])
        return len(lines) - len([line for line in lines if line.strip() and json.loads(line)["order_rank"] not in ranks]), sorted(free), name, sorted(added)

    return update_sessions(work, change)


def main(argv=None):
    args = topic_arguments("Drop one scored block of a screening session; ranks no other session block holds can then be fetched and screened again. Copies go to dropped/.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--stratum"], {"required": True, "help": "stratum of the session"}),
                           (["--session"], {"required": True, "help": "meta.json session key, e.g. config-A or config-pilot-A"}),
                           (["--ranks"], {"required": True, "help": "first-last ranks of the block, as it was run"})).parse_args(argv)
    try:
        require_screened(load_topic(args.repo, args.topic), args.stratum)
        if not args.session.startswith(f"{args.stratum}-"):
            raise TopicError(f"session {args.session} is not in the {args.stratum} stratum")
        first, _, last = args.ranks.partition("-")
        if not (first.isdigit() and last.isdigit()):
            raise TopicError(f"--ranks {args.ranks!r} must read first-last")
        side = args.session.split("-", 1)[1]
        stem = args.session if "-pilot-" in args.session else f"{args.stratum}-screen-{side}"
        rows, free, name, mechanisms = drop_block(args.work, args.stratum, args.session, stem, int(first), int(last))
    except TopicError as error:
        sys.exit(f"drop-screening-block: {error}")
    print(f"{args.session}: dropped the block for ranks {args.ranks}, {rows} rows and mechanism lines {mechanisms}; copies are dropped/{name}.*; "
          f"inputs cleared for ranks {free} so fetch-screening-inputs.py fetches them again; ranks another session block still holds keep their inputs")


if __name__ == "__main__":
    main()
