import argparse
import json
import statistics
import sys
from pathlib import Path

from study_calibration_set import FIELDS, RATED, labels_file
from study_topic import TopicError


def timed_rows(path):
    if not path.is_file():
        raise TopicError(f"no {path.name} in {path.parent}; import the labels the page saved first")
    rows = [r["user"] for r in json.loads(path.read_text())["rows"]
            if isinstance(r.get("user"), dict) and isinstance(r["user"].get("timing"), dict) and r["user"]["timing"] and all(f in r["user"] for f in FIELDS)]
    if not rows:
        raise TopicError(f"{path.name} holds no complete row with timings; label rows on a page that records them")
    return sorted(rows, key=lambda user: max(user["timing"].values()))


def spent(rows):
    seconds, rated, total = [], 0, 0
    clock = min(rows[0]["timing"].values())
    for user in rows:
        start = clock
        for field, at in sorted(user["timing"].items(), key=lambda item: item[1]):
            gap = max(0, at - clock)
            clock = max(clock, at)
            total += gap
            rated += gap if field in RATED else 0
        seconds.append((clock - start) / 1000)
    return statistics.median(seconds), rated / total if total else 0.0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Report how long the first calibration rows took to label, from the time the page recorded when each field was first "
                                                 "set. Rows are the complete rows with timings, ordered by completion (their last first-set time). A row's time runs from "
                                                 "the previous row's completion (the first row from its own first field) to its own completion, and each field gets the gap "
                                                 "before it was first set; the report gives the median seconds per row and the share of that time spent on Authority, "
                                                 "Methodology, Objectivity and Position against the other fields.")
    parser.add_argument("--work", required=True, help="the topic's working folder holding <batch>-labels.json")
    parser.add_argument("--batch", default="calibration", help="which batch's labels to read, default calibration")
    parser.add_argument("--rows", type=int, required=True, help="how many rows to report, the first by completion time")
    args = parser.parse_args(argv)
    try:
        if args.rows < 1:
            raise TopicError("--rows must be at least 1")
        rows = timed_rows(Path(args.work) / labels_file(args.batch))
        median, share = spent(rows[:args.rows])
    except (TopicError, OSError, ValueError, KeyError) as error:
        sys.exit(f"calibration-timing: {error}")
    print(f"{args.batch}: first {min(args.rows, len(rows))} of {len(rows)} timed complete rows by completion time: median {median:.1f} s per row; "
          f"Authority, Methodology, Objectivity and Position took {share:.1%} of the time, the other fields {1 - share:.1%}")


if __name__ == "__main__":
    main()
