import json
import sys
from pathlib import Path

from study_judges import criteria_version, validate
from study_protocol import FREEZE_FILE
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None):
    args = topic_arguments("Validate every judge against the user's calibration labels: per stratum and run, the confusion matrix, sensitivity with its interval and kappa, "
                           "and the run-to-run disagreement; a judge qualifies with sensitivity >= 0.90 and kappa >= 0.60 in both runs.",
                           (["--work"], {"required": True, "help": "the topic's working folder"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        freeze_file = Path(args.work) / FREEZE_FILE
        freeze = json.loads(freeze_file.read_text()) if freeze_file.is_file() else None
        if freeze and criteria_version(freeze.get("criteria")) < 4:
            raise TopicError(f"{freeze_file} pins {freeze.get('criteria')}; judges are validated under quality criteria v4 or later")
        out = validate(topic, args.work, freeze)
    except TopicError as error:
        sys.exit(f"validate-judges: {error}")
    for judge, entry in out.items():
        for stratum, s in entry["strata"].items():
            runs = "; ".join(f"run {i}: missing" if r is None else f"run {i}: sensitivity {r['sensitivity']} kappa {r['kappa']} (tp {r['tp']} fn {r['fn']} fp {r['fp']} tn {r['tn']})"
                             for i, r in enumerate(s["runs"], 1))
            print(f"{judge} {entry['model']} {stratum}: {'qualified' if s['qualified'] else 'NOT qualified'}; {runs}; runs differ on {s['differ']} rows")
    if not freeze:
        print("no protocol freeze yet: the screening judges are validated after the pilot block and the freeze")


if __name__ == "__main__":
    main()
