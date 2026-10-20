import json
import sys
from pathlib import Path

from study_protocol import FREEZE_FILE
from study_stage1_audit import import_checks
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Keep the user's checks of the stage-1 audit rows the stage-2 screener flagged: a JSON object mapping each flagged rank to eligible or excluded.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--stratum"], {"required": True, "help": "audited stratum"}),
                           (["--checks"], {"required": True, "help": "JSON file of the user's checks"})).parse_args(argv)
    try:
        load_topic(args.repo, args.topic)
        freeze = Path(args.work) / FREEZE_FILE
        if not freeze.is_file():
            raise TopicError(f"no {FREEZE_FILE} in {args.work}; the screener reads the audit rows under the frozen protocol")
        try:
            saved = json.loads(Path(args.checks).read_text())
        except (OSError, ValueError) as error:
            raise TopicError(f"cannot read {args.checks}: {error}") from error
        checked, flagged = import_checks(args.work, args.stratum, json.loads(freeze.read_text())["session_a"], saved)
    except TopicError as error:
        sys.exit(f"import-audit-checks: {error}")
    print(f"{args.stratum}: the user checked {checked} of {flagged} flagged rows")


if __name__ == "__main__":
    main()
