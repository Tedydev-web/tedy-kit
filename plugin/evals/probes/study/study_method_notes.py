from study_screening_core import read_json, read_jsonl
from study_session_prompt import required_sweep_date
from study_topic import SNOWBALL_RANK_BASE, TopicError

SNOWBALL_CUT_FILE = "snowball-cut.json"


def template_line(freeze, strata):
    digests = {freeze["strata"][s].get("template_sha256") for s in strata}
    if None in digests or len(digests) != 1:
        raise TopicError("protocol-freeze.json must pin one prompt template sha256 for every screened stratum; freeze again with freeze-protocol.py")
    return f"- prompt template sha256 `{digests.pop()}` (row note and reply format), pinned at the freeze for every screened stratum"


def date_line(topic):
    return (f"- Date: computed by the toolchain from facts.pushed and the sweep date {required_sweep_date(topic)} (within 90 days 1, within 365 days 0.5, older 0); "
            "both sessions' Date values are replaced and kept as session_date")


def snowball_lines(topic, folder, strata):
    lines = []
    for stratum in strata:
        snowballed = [r for r in read_jsonl(folder, f"{stratum}-screening-order.jsonl") if r["order_rank"] > SNOWBALL_RANK_BASE and not r.get("forced")]
        cut = read_json(folder, SNOWBALL_CUT_FILE) if (folder / SNOWBALL_CUT_FILE).is_file() else None
        if cut is None or cut.get("stratum") != stratum:
            if snowballed:
                raise TopicError(f"{stratum}: the screening order holds snowballed rows but no {SNOWBALL_CUT_FILE} states the cut the snowball used")
            continue
        merged = {r["repo"].lower() for r in read_jsonl(folder, f"{stratum}-screening-order.jsonl")}
        unmerged = sorted(r["repo"] for r in read_jsonl(folder, "snowball-screening-order.jsonl") if r["repo"].lower() not in merged)
        if unmerged:
            raise TopicError(f"{stratum}: snowball-screening-order.jsonl names {unmerged}, which the {stratum} screening order lacks; run merge-snowball-order.py, "
                             "then fetch and screen the new rows")
        stop = topic["strata"][stratum].get("stop_row")
        if cut["cut_row"] != stop:
            raise TopicError(f"{stratum}: the snowball ranked above row {cut['cut_row']} ({cut['source']}), but the stop is row {stop}; rerun snowball-above-cut.py "
                             "and merge-snowball-order.py, then fetch and screen the new rows")
        lines.append(f"- {stratum} snowball: {len(snowballed)} rows from {SNOWBALL_RANK_BASE + 1} on rank above the cut at row {cut['cut_row']} ({cut['source']})")
    return lines


def method_notes(topic, folder, freeze, strata):
    return [template_line(freeze, strata), date_line(topic)] + snowball_lines(topic, folder, strata)
