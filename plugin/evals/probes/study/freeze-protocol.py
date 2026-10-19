import json
import sys
from pathlib import Path

from study_protocol import FREEZE_FILE, freeze
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None):
    args = topic_arguments("Freeze the screening protocol after the pilot block: pin the criteria and packet sha256 per stratum, session A and the configured session B.",
                           (["--work"], {"required": True, "help": "study working folder holding the pilot session files and the packets"}),
                           (["--criteria"], {"required": True, "help": "criteria file the sessions score under, relative to the repository"}),
                           (["--amendment"], {"help": "what the packet revision after the pilot changed; required when the packet changed"}),
                           (["--today"], {"default": saigon_today(), "help": "freeze date, default today in Asia/Saigon"})).parse_args(argv)
    try:
        out = freeze(load_topic(args.repo, args.topic), args.repo, args.work, args.criteria, args.today, args.amendment)
    except TopicError as error:
        sys.exit(f"freeze-protocol: {error}")
    (Path(args.work) / FREEZE_FILE).write_text(json.dumps(out, indent=1) + "\n")
    after = ", ".join(f"{s} after row {v['frozen_after_rank']}" for s, v in out["strata"].items())
    print(f"frozen {after}; session B {out['session_b']['chosen']['model']} ({out['session_b']['rule']}); "
          f"pilot, information only: {json.dumps({m: p['agreement'] for m, p in out['session_b']['pilot'].items()})}")


if __name__ == "__main__":
    main()
