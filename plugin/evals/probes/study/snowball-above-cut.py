import json
import sys
from pathlib import Path

from study_agreement import EFFORT_BOUND
from study_rank import order_key
from study_topic import SNOWBALL_RANK_BASE, TopicError, load_topic, topic_arguments


def planned_cut(topic):
    written = topic["strata"].get("config", {}).get("stop_row")
    if isinstance(written, int) and not isinstance(written, bool):
        return written, "the written stop row"
    return EFFORT_BOUND, f"the effort bound {EFFORT_BOUND}: no stop row was written yet, so rerun the snowball after compare-screening-sessions.py --write-stop"


def above_cut(before, after, stop_row):
    cut = next((r for r in before["rows"] if r["order_rank"] == stop_row), None)
    if cut is None:
        raise TopicError(f"the ranking before the snowball has no row {stop_row}")
    snow = [r for r in after["rows"] if r["channels"] == ["snowball"]]
    above = sorted((r for r in snow if order_key(r) < order_key(cut)), key=order_key)
    rows = [{"order_rank": SNOWBALL_RANK_BASE + i, "repo": r["repo"], "units": r["units"], "stars": r["stars"], "pushed": r["pushed"], "created": r.get("created", ""),
             "channels": r["channels"], "via": r["via"], "description": r.get("description", ""), "order": r["order"], "forced": False,
             **{k: r[k] for k in ("closed_issues", "merged_prs", "license") if k in r}} for i, r in enumerate(above, 1)]
    return cut, len(snow), rows


def main(argv=None):
    args = topic_arguments("List the snowballed repositories that rank above the config cut (the written stop row, else the effort bound) and record the cut used; "
                           "merge-snowball-order.py adds them to the screening order as rows 1001 and on.",
                           (["--work"], {"required": True, "help": "study working folder"}),
                           (["--before"], {"default": "config-ranked.json", "help": "ranking without the snowball"}),
                           (["--after"], {"default": "config-ranked-snowball.json", "help": "ranking with the snowball state merged"})).parse_args(argv)
    work = Path(args.work)
    try:
        topic = load_topic(args.repo, args.topic)
        files = [work / args.before, work / args.after]
        missing = [str(f) for f in files if not f.exists()]
        if missing:
            raise TopicError(f"missing rankings: {missing}")
        stop_row, source = planned_cut(topic)
        cut, snowballed, rows = above_cut(*(json.loads(f.read_text()) for f in files), stop_row)
    except TopicError as error:
        sys.exit(f"snowball-above-cut: {error}")
    (work / "snowball-screening-order.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    (work / "snowball-cut.json").write_text(json.dumps({"stratum": "config", "cut_row": stop_row, "source": source, "above_cut": len(rows)}, indent=1) + "\n")
    print(f"cut: row {cut['order_rank']} {cut['repo']} order {cut['order']} ({source}); snowball ranked {snowballed}; above cut {len(rows)}; "
          "merge them with merge-snowball-order.py")


if __name__ == "__main__":
    main()
