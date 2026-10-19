import json
import shutil
import sys
from pathlib import Path

from study_session import update_sessions
from study_topic import TopicError, load_topic, require_screened, topic_arguments


def drop_block(work, key, file_stem, first, last):
    work = Path(work)
    rows_file = work / f"{file_stem}.jsonl"
    dropped = work / "dropped"
    dropped.mkdir(exist_ok=True)

    def change(sessions):
        entry = sessions.get(key)
        blocks = [b for b in (entry or {}).get("blocks", []) if b["ranks"] and b["ranks"][0] == first and b["ranks"][-1] == last]
        if not blocks:
            raise TopicError(f"meta.json sessions.{key} holds no block for ranks {first}-{last}")
        (dropped / f"{file_stem}-{first}-{last}.block.json").write_text(json.dumps(blocks[0], indent=1) + "\n")
        entry["blocks"] = [b for b in entry["blocks"] if b is not blocks[0]]
        ranks = set(blocks[0]["ranks"])
        lines = rows_file.read_text().splitlines(keepends=True) if rows_file.is_file() else []
        kept = [line for line in lines if line.strip() and json.loads(line)["order_rank"] not in ranks]
        shutil.copyfile(rows_file, dropped / f"{file_stem}-{first}-{last}.rows.jsonl")
        temporary = rows_file.with_name(rows_file.name + ".tmp")
        temporary.write_text("".join(kept))
        temporary.replace(rows_file)
        return len(lines) - len(kept)

    return update_sessions(work, change)


def main(argv=None):
    args = topic_arguments("Drop one scored block of a screening session so its ranks can be fetched and screened again; the block and its rows are kept under dropped/.",
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
        rows = drop_block(args.work, args.session, stem, int(first), int(last))
    except TopicError as error:
        sys.exit(f"drop-screening-block: {error}")
    print(f"{args.session}: dropped the block for ranks {args.ranks} and {rows} rows; copies are in dropped/")


if __name__ == "__main__":
    main()
