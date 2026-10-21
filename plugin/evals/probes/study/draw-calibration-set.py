import json
import sys
from pathlib import Path

from study_calibration_set import draw_batch, rebuild_page, set_file
from study_fetch import Fetch, NetworkRefused
from study_topic import TopicError, load_topic, saigon_today, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Draw the calibration set (60 rows per stratum, about half likely positives, split evenly over the facets) or, with --top-up, the 30-40 row "
                           "enriched batch a fired trigger asks for; fetch their inputs and write the self-contained labelling page. The page shows the inputs and the "
                           "anchors only, never an answer or how a row was drawn.",
                           (["--work"], {"required": True, "help": "the topic's working folder, holding the pool orders, the stage-1 inputs and the QGS candidates"}),
                           (["--criteria"], {"required": True, "help": "criteria file whose anchors the page shows, relative to the repository"}),
                           (["--top-up"], {"type": int, "help": "draw the top-up batch of this many enriched rows (30-40); refused unless a trigger fired"}),
                           (["--rebuild-page"], {"nargs": "?", "const": "calibration", "metavar": "BATCH",
                                                 "help": "rewrite only the labelling page of an already drawn batch (default calibration) from its set file and the inputs "
                                                         "the set pinned; the set and draw files are read, never written"}),
                           (["--today"], {"default": saigon_today(), "help": "draw date, default today in Asia/Saigon; the calibration set is drawn on the date the sweep is named for"})).parse_args(argv)
    if args.rebuild_page is not None and args.top_up is not None:
        sys.exit("draw-calibration-set: --rebuild-page rewrites the page of a drawn batch; it takes no --top-up")
    work = Path(args.work)
    try:
        topic = load_topic(args.repo, args.topic)
        if args.rebuild_page is not None:
            page = rebuild_page(topic, args.repo, work, args.rebuild_page, args.criteria)
            (work / f"{args.rebuild_page}.html").write_text(page)
            print(f"rewrote {work / f'{args.rebuild_page}.html'} from {work / set_file(args.rebuild_page)}; the set and draw files are unchanged")
            return
        batch, text, provenance, page = draw_batch(topic, args.repo, work, args.criteria, fetch or Fetch(), args.top_up, args.today)
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"draw-calibration-set: {error}")
    (work / set_file(batch)).write_text(text)
    (work / f"{batch}-draw.json").write_text(json.dumps(provenance, indent=1) + "\n")
    (work / f"{batch}.html").write_text(page)
    sample = json.loads(text)
    print(f"{len(sample['rows'])} rows in {work / set_file(batch)} ({sample['purpose']}); open {work / f'{batch}.html'} in a browser to label them, "
          f"then run import-calibration-labels.py --batch {batch}")


if __name__ == "__main__":
    main()
