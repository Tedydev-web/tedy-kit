import contextlib
import sys

from study_citation_check import BATCH
from study_citation_checkers import checker_option, run_checker, votes_file
from study_fetch import Fetch, NetworkRefused
from study_qgs import whole_topic
from study_reference_flags import agy_window
from study_reference_freeze import frozen_sha
from study_topic import TopicError, load_topic, topic_arguments


def main(argv=None, fetch=None):
    args = topic_arguments("Run one checker model, isolated and blind to the labels and to the other checkers, on the 30 citation-check rows of the frozen calibration "
                           "labels: each row's cited files in full up to 10,000 bytes at the pinned commit, the problem and the Relevance anchor, one yes/no answer with "
                           "a reason. A reply that is not two lines is retried once, then recorded as refused; a second run fills the refused rows. Writes "
                           "citation-check-votes-<model>.json for import-citation-check.py --votes.",
                           (["--work"], {"required": True, "help": "the topic's working folder"}),
                           (["--checker"], {"required": True, "help": "claude:<model>[:<effort>], agy:<model> or aperture:<model>; never the reference model"}),
                           (["--endpoint"], {"help": "aperture only: the Aperture URL, for example http://100.127.1.240; the checker posts one chat completion per row"}),
                           (["--agy-window"], {"action": "store_true", "help": "agy only: disable the context-mode MCP server and the ponytail plugin during the run, "
                                                                              "as the flagger runs did, and enable them again after"})).parse_args(argv)
    try:
        topic = load_topic(args.repo, args.topic)
        whole_topic(topic, "the citation check")
        option = checker_option(args.checker, args.endpoint)
        if args.agy_window and option["cli"] != "agy":
            raise TopicError("--agy-window belongs to an agy checker; it switches agy extensions only")
        fetch = fetch or Fetch()
        with agy_window(fetch) if args.agy_window else contextlib.nullcontext():
            saved = run_checker(topic, args.repo, args.work, option, frozen_sha(args.work, BATCH), fetch)
    except (TopicError, NetworkRefused) as error:
        sys.exit(f"run-citation-checker: {error}")
    print(f"{votes_file(option['model'])}: {len(saved['votes'])} votes" + (f"; refused twice: {sorted(saved['refused'])}" if saved["refused"] else ""))


if __name__ == "__main__":
    main()
