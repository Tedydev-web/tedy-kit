import hashlib
import json

from study_agreement import HARD_CAP, RECALL_TARGET, clopper_pearson, cohen_kappa, kappa_text, rounded
from study_calibration_set import DRAW_FILE, LABELS_FILE, SET_FILE
from study_facets import FACET_ORDERS, depth_plan, depth_ranks, facet_names, overlap_counts, standard_labels
from study_judges import AUDIT_FILE, criteria_version, decided, reader_shares_family, roster, validate
from study_qgs import cross_family, qgs_standard
from study_screening_core import read_json, read_jsonl
from study_session import model_family
from study_topic import SNOWBALL_RANK_BASE, TopicError

UPPER_ESTIMATE = ("- recall is an upper estimate: the facet depth was derived from the standard, and the standard's candidates come from curated lists filtered by the topic's "
                  "terms, so recall at the stop reaches the target by construction")


def is_v4(meta):
    return criteria_version(meta.get("criteria")) >= 4


def is_faceted(order):
    return bool(order) and "facets" in order[0]


def written_stops(topic, stratum):
    return {f: ((topic["facets"][f].get("strata") or {}).get(stratum) or {}).get("stop_row") for f in facet_names(topic)}


def interval(k, n):
    low, high = clopper_pearson(k, n)
    return f"{k}/{n} ({k / n:.3f}, 95% CI {low:.2f}-{high:.2f})"


def snowball_cuts(folder, stratum, stops, order):
    summary = read_json(folder, FACET_ORDERS).get(stratum, {}).get("facets", {})
    for facet, stop in stops.items():
        cut = summary.get(facet, {}).get("snowball_cut")
        snowballed = [r for r in order if facet in r["facets"] and r["facets"][facet]["rank"] > SNOWBALL_RANK_BASE and not r["facets"][facet]["forced"]]
        if cut is None:
            if snowballed:
                raise TopicError(f"{stratum} facet {facet}: the merged order holds snowballed rows but {FACET_ORDERS} states no snowball cut")
        elif cut["cut_row"] != stop:
            raise TopicError(f"{stratum} facet {facet}: the snowball ranked above row {cut['cut_row']}, but the facet's stop is row {stop}; rerun snowball-above-cut.py and "
                             "merge-snowball-order.py in the facet folder, merge the facet orders again, then fetch and screen the new rows")


def v4_stop(topic, folder, stratum, common):
    order = read_jsonl(folder, f"{stratum}-screening-order.jsonl")
    if not is_faceted(order):
        raise TopicError(f"{stratum}-screening-order.jsonl is not a merged facet order; quality criteria v4 screens a topic by facets")
    labels = standard_labels(read_json(folder, f"{stratum}-qgs-adjudicated.json"))
    plan = depth_plan(topic, order, labels, set(common))
    derived = {f: s["row"] for f, s in plan["stops"].items()}
    written = written_stops(topic, stratum)
    if written != derived:
        raise TopicError(f"{topic['path']}: the facets' {stratum} stop rows are {written}, the facet orders and the standard give {derived}; "
                         f"a hand-typed stop row is refused: run facet-depth.py --stratum {stratum} --write-stop")
    gaps = sorted(depth_ranks(order, derived) - set(common))
    if gaps:
        raise TopicError(f"{stratum}: ranks {gaps[:10]} lie within a facet's depth but were not screened by both sessions")
    snowball_cuts(folder, stratum, derived, order)
    rules = ", ".join(f"{f} {s['row']} ({s['rule']})" for f, s in plan["stops"].items())
    head = (f"stop: pooled recall reached the {RECALL_TARGET:.2f} target at depth {plan['depth']}" if plan["reached"] else
            f"stop: pooled recall did not reach the {RECALL_TARGET:.2f} target within the {HARD_CAP}-row cap or the facets' pools")
    return f"{head}; facet stop rows {rules}", {"plan": plan, "order": order, "stops": derived, "labels": labels}


def recall_lines(topic, folder, strata, faceted):
    lines, threats = [], []
    for stratum in [s for s in ("config", "product") if s in strata]:
        plan = faceted[stratum]["plan"]
        verdict = (f"meets the {RECALL_TARGET:.2f} target" if plan["found"] / plan["size"] >= RECALL_TARGET else
                   f"below the {RECALL_TARGET:.2f} target; missed: " + ", ".join(plan["missed"]))
        lines.append(f"- {stratum}: pooled recall at the stop {interval(plan['found'], plan['size'])} of the deduplicated {stratum} standard, counting rows both sessions "
                     f"screened within a facet's depth; {verdict}")
        if plan["found"] / plan["size"] < RECALL_TARGET:
            stops = ", ".join(f"{f} {s['row']} ({s['rule']})" for f, s in plan["stops"].items())
            threats.append(f"- recall target not reached: {stratum} pooled recall {plan['found']}/{plan['size']} at the facet stops {stops}; screening stopped at the "
                           f"{HARD_CAP}-row cap or where the facets' pools ran out")
        for facet, result in plan["facets"].items():
            body = (f"{interval(result['found'], result['size'])} of the members labelled for it, within its own depth; reported, no pass or fail" if result["size"] else
                    "no member of the standard is labelled for it")
            lines.append(f"- {stratum} facet {facet}: {body}")
    if (topic["strata"].get("product", {}).get("channels") or {}).get("config_pool") is True and "product" in strata:
        channel = read_json(folder, "config-pool-channel.json")
        members = {m.lower() for m in faceted["product"]["labels"]}
        joined = {r.lower() for r in channel["joined"]}
        only = {r.lower() for r in channel["only"]}
        lines.append(f"- product channel from the config pool: {len(joined)} repositories joined the product pool; they hold {len(members & joined)} of the {len(members)} product "
                     f"standard members, {len(members & only)} of them found by no other product channel")
    return lines, threats


def facet_lines(topic, folder, strata, faceted, common):
    lines = []
    summary = read_json(folder, FACET_ORDERS)
    for stratum in strata:
        counts = overlap_counts(faceted[stratum]["order"], faceted[stratum]["stops"], common[stratum])
        per = ", ".join(f"{f} {n}" for f, n in counts["per_facet"].items())
        pairs = ", ".join(f"{k} {v}" for k, v in counts["pairs"].items()) or "none"
        lines.append(f"- {stratum}: {counts['unique']} repositories screened once, counted per facet {per}; overlap {pairs}; each repository counts once in pooled recall and PRISMA")
    for facet in facet_names(topic):
        queries = "; ".join(f"{s} {json.dumps(summary[s]['facets'][facet]['code_queries_counted'])}" for s in strata)
        lines.append(f"- {facet} ranking: problems {', '.join(topic['facets'][facet]['problems'])}; terms {', '.join(topic['facets'][facet]['terms'])}; counted code-search queries {queries}")
    return lines


def calibration_lines(topic, folder, strata, freeze):
    sample = read_json(folder, SET_FILE)
    labels = read_json(folder, LABELS_FILE)
    if labels.get("set_sha256") != hashlib.sha256((folder / SET_FILE).read_bytes()).hexdigest():
        raise TopicError(f"{LABELS_FILE} was imported for another calibration set")
    if sample["criteria_sha256"] != freeze["strata"][strata[0]]["criteria_sha256"]:
        raise TopicError(f"the calibration set shows the anchors of criteria sha256 {sample['criteria_sha256'][:16]}, but the freeze pins another criteria file")
    drawn = {d["id"]: d for d in read_json(folder, DRAW_FILE)["rows"]}
    lines = []
    for stratum in strata:
        rows = [r for r in labels["rows"] if r["stratum"] == stratum]
        facets = {f: sum(drawn[r["id"]]["facet"] == f for r in rows) for f in facet_names(topic)}
        likely = sum(drawn[r["id"]]["class"] != "random" for r in rows)
        eligible = sum(r["user"]["decision"] == "eligible" for r in rows)
        relevant = sum(r["user"]["Relevance"] == 1 for r in rows)
        lines.append(f"- {stratum}: calibration set of {len(rows)} rows, drawn per facet " + ", ".join(f"{f} {n}" for f, n in facets.items()) +
                     f"; likely positives {likely} of {len(rows)}; the user labelled {eligible} eligible and {relevant} relevant; anchors of the frozen criteria, sha256 "
                     f"`{sample['criteria_sha256'][:16]}`")
    return lines


def run_text(run):
    sensitivity = "undefined (no positive row)" if run["sensitivity"] is None else f"{run['sensitivity']:.3f} (95% CI {run['interval'][0]:.2f}-{run['interval'][1]:.2f})"
    return f"sensitivity {sensitivity}, kappa {kappa_text(run['kappa'])}, tp {run['tp']} fn {run['fn']} fp {run['fp']} tn {run['tn']}"


def judge_lines(topic, folder, strata, freeze, sessions):
    found = validate(topic, folder, freeze, tuple(strata))
    lines, threats = [], []
    for judge, entry in found.items():
        for stratum in strata:
            s = entry["strata"][stratum]
            if not s["qualified"]:
                raise TopicError(f"{judge} {entry['model']} did not qualify on the {stratum} calibration set; replace it, validate the new judge and judge again before the record")
            lines.append(f"- {judge} {entry['cli']} {entry['model']}, {stratum}: run 1 {run_text(s['runs'][0])}; run 2 {run_text(s['runs'][1])}; runs differ on {s['differ']} of "
                         f"{s['rows']} rows (kappa {kappa_text(s['run_kappa'])}); qualified")
    judges = roster(topic)
    for stratum in strata:
        for judge, name in (("qgs-A", f"{stratum}-qgs-judge-A"), ("qgs-B", f"{stratum}-qgs-judge-B"), ("reader", f"{stratum}-qgs-reader")):
            ids = {r["id"] for r in read_jsonl(folder, f"{name}.jsonl")}
            entry = sessions.get(name) or {}
            covered = {r for b in entry.get("blocks", []) for r in b["ranks"]}
            if ids and entry.get("model") == judges[judge]["model"] and ids <= covered:
                lines.append(f"- {stratum} QGS {judge}: {judges[judge]['model']} judged {len(ids)} candidates through the toolchain on their pre-fetched inputs, under the packet it was validated with")
            else:
                threats.append(f"- QGS judging outside the validated workflow: {stratum} {name}.jsonl holds {len(ids)} judgments that meta.json does not record as {judges[judge]['model']} "
                               "runs on the pre-fetched inputs, so its validation may not transfer")
        standard = qgs_standard(topic, folder, stratum)
        adjudicated = read_json(folder, f"{stratum}-qgs-adjudicated.json")
        if standard["final"] != adjudicated.get("final") or standard["labels"] != adjudicated.get("labels"):
            raise TopicError(f"{stratum}-qgs-adjudicated.json is not the standard its judge files give; rebuild it with qgs-standard.py --stratum {stratum} --write, then qgs-recall.py --write")
        cross = standard.get("cross_family")
        if cross:
            kept = (f"{cross['judged']} candidates judged, {cross['overlap']} also judged by both Claude judges; agreement with qgs-A {cross['agreement']['A']}/{cross['overlap']} "
                    f"(kappa {kappa_text(cross['kappa']['A'])}), with qgs-B {cross['agreement']['B']}/{cross['overlap']} (kappa {kappa_text(cross['kappa']['B'])}); "
                    f"{len(cross['accepted_against_both'])} candidates both Claude judges rejected and it accepted went to the reader, which accepted {len(cross['reader_yes'])}"
                    if cross["judged"] else "no judgment kept")
            lines.append(f"- {stratum} cross-family QGS judge {cross['model']}: {kept}")
        lines.append(f"- {stratum} standard: {len(standard['final'])} members from {standard['judged_by_both']} candidates both Claude judges judged; reader queue "
                     f"{len(standard['queue']['disputed'])} disputed or unsure, {len(standard['queue']['cross_family_only'])} cross-family only")
    if reader_shares_family(topic):
        threats.append(f"- reader shares the QGS judges' model family: the reader {judges['reader']['model']} and the QGS judges {judges['qgs-A']['model']} and {judges['qgs-B']['model']} are "
                       f"all {model_family(judges['reader']['model'])} models, so an error they share passes the adjudication; the cross-family judge's yes is the counter-check")
    return lines, threats


def audit_lines(topic, folder, strata, sessions_rows):
    option = cross_family(topic)
    if option is None:
        return [], ["- no cross-family audit: the topic config names no cross_family model, so no model of another family checks the screening"]
    sample = read_json(folder, AUDIT_FILE) if (folder / AUDIT_FILE).is_file() else {}
    lines, threats = [], []
    for stratum in strata:
        rows = {r["order_rank"]: r for r in read_jsonl(folder, f"{stratum}-audit-{option['model']}.jsonl")}
        ranks = sample.get(stratum) or []
        if not ranks or set(ranks) - set(rows):
            threats.append(f"- cross-family audit pending: {stratum}: {len(set(ranks) & set(rows))} of {len(ranks)} audit rows screened by {option['model']}; the same-family screening "
                           "has no cross-family check until it runs")
            continue
        audit = [decided("screening", stratum, rows[r]) for r in ranks]
        parts = []
        for side in "AB":
            other = [decided("screening", stratum, sessions_rows[stratum][side][r]) for r in ranks]
            pairs = list(zip(audit, other))
            parts.append(f"with {side} {sum(a == b for a, b in pairs)}/{len(ranks)} (kappa {kappa_text(rounded(cohen_kappa(pairs)[1]))})")
        lines.append(f"- {stratum} audit: {len(ranks)} rows screened again by {option['model']}: eligibility agreement {', '.join(parts)}; decisions derived with every coded "
                     "mechanism counted as new, as at calibration")
    return lines, threats


def v4_parts(topic, folder, strata, freeze, sessions, faceted, common):
    sides = {s: {side: {r["order_rank"]: r for r in read_jsonl(folder, f"{s}-screen-{side}.jsonl")} for side in "AB"} for s in strata}
    recall, recall_threats = recall_lines(topic, folder, strata, faceted)
    judges, judge_threats = judge_lines(topic, folder, strata, freeze, sessions)
    audits, audit_threats = audit_lines(topic, folder, strata, sides)
    return {"recall": recall, "facets": facet_lines(topic, folder, strata, faceted, common), "calibration": calibration_lines(topic, folder, strata, freeze),
            "judges": judges + audits, "threats": recall_threats + judge_threats + audit_threats + [UPPER_ESTIMATE]}
