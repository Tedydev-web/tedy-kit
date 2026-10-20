import hashlib
import json

from study_agreement import RECALL_TARGET, cohen_kappa, interval_text, kappa_text
from study_calibration_set import all_batches, labelled, labels_file, set_file
from study_judges import AUDIT_FILE, SHAPES, criteria_version, decided, judged_batches, reader_shares_family, roster, validate
from study_qgs import ADJUDICATED, JUDGE_FILES, PACKET, UPPER_ESTIMATE, candidate_rows, cross_family, member_facets, qgs_standard, stratum_members
from study_screening_core import read_json, read_jsonl
from study_session import model_family
from study_stage1 import FREEZE_FILE, RUNG_FILE, held_out_batches, held_out_check, ladder_rung, pool_name, stage1_inputs
from study_stage1_audit import elusion
from study_stage2 import plan_file, stage1_results, stage2_plan
from study_topic import SNOWBALL_RANK_BASE, TopicError

STAGE2_THREAT = "- stage 2 stopped before every stage-1 pass: "
STAGE2_UNREACHABLE = "- pooled recall target unreachable at stage 2: "


def is_v4(meta):
    return criteria_version(meta.get("criteria")) >= 4


def facet_names(topic):
    return list(topic.get("facets") or {})


def problem_facets(topic, problems):
    homes = {p: name for name, rule in (topic.get("facets") or {}).items() for p in rule["problems"]}
    return sorted({homes[p] for p in problems if p in homes})


def v4_stop(topic, folder, stratum, common):
    written = read_json(folder, plan_file(stratum))
    plan = json.loads(json.dumps(stage2_plan(topic, folder, written.get("limit"))))[stratum]
    if plan != written:
        raise TopicError(f"{plan_file(stratum)} is not the plan the stage-1 files give; run plan-stage2.py again")
    open_rows = sorted(set(plan["order"]) - set(common))
    if open_rows:
        raise TopicError(f"{stratum}: stage-2 ranks {open_rows[:10]} are not screened by both sessions")
    stop = plan["stop"]
    if stop and not stop["reachable"]:
        text = (f"stop: stage 2 screened every one of the {len(plan['passes'])} stage-1 passes of the {plan['pool']}-row pool (rung {plan['rung']}) and ignored the "
                f"limit of {plan['limit']} rows: only {stop['passed']} of the {stop['members']} deduplicated standard members passed stage 1 in any stratum, "
                f"and the {RECALL_TARGET:.2f} pooled recall target needs {stop['need']}")
    elif stop:
        text = (f"stop: stage 2 ranked the stage-1 passes of every stratum together by facet and stopped at pooled depth {stop['depth']} (limit {plan['limit']}); "
                f"this stratum screens {len(plan['order'])} of its {len(plan['passes'])} passes; pooled recall at the stop "
                f"{interval_text(stop['found'], stop['members'])} of the {stop['members']} deduplicated standard members; "
                + ("target reached" if stop["reached"] else "target not reached"))
    else:
        text = f"stop: stage 2 screened every one of the {len(plan['passes'])} stage-1 passes of the {plan['pool']}-row pool (rung {plan['rung']})"
    results = stage1_results(folder, stratum)[1]
    return text, {"plan": plan, "results": results, "common": set(common)}


def stage2_threats(strata, faceted):
    stops = [f"{STAGE2_THREAT}{s} screened {len(faceted[s]['plan']['order'])} of {len(faceted[s]['plan']['passes'])} passes" for s in strata
             if len(faceted[s]["plan"]["order"]) < len(faceted[s]["plan"]["passes"])]
    pooled = next((faceted[s]["plan"]["stop"] for s in strata if faceted[s]["plan"]["stop"]), None)
    if pooled and not pooled["reachable"]:
        stops.append(f"{STAGE2_UNREACHABLE}{pooled['passed']} of the {pooled['members']} deduplicated standard members passed stage 1 and {pooled['need']} are needed; "
                     f"stage 2 screened every pass")
    return stops


def row_facets(topic, faceted, stratum):
    results = faceted[stratum]["results"]
    return {r: ", ".join(problem_facets(topic, v["problems"])) or "-" for r, v in results.items()}


def standard(topic, folder):
    out = qgs_standard(topic, folder)
    written = read_json(folder, ADJUDICATED)
    if (out["final"], out["labels"], out["strata"]) != (written.get("final"), written.get("labels"), written.get("strata")):
        raise TopicError(f"{ADJUDICATED} is not the standard its judge files give; rebuild it with qgs-standard.py --write")
    return out


def recall_counts(members, pools, faceted, strata):
    in_pool = [m for m in members if any(m in pools[s] for s in strata)]
    passed = [m for m in in_pool if any(faceted[s]["results"][pools[s][m]]["pass"] for s in strata if m in pools[s])]
    screened = [m for m in passed if any(pools[s].get(m) in faceted[s]["common"] and pools[s][m] in faceted[s]["plan"]["order"] for s in strata)]
    return in_pool, passed, screened


def rate(k, n):
    return interval_text(k, n) if n else "0/0 (no member)"


def recall_lines(topic, folder, strata, faceted):
    out = standard(topic, folder)
    members = [m.lower() for m in out["final"]]
    pools = {s: {r["repo"].lower(): r["order_rank"] for r in faceted[s]["inputs"]} for s in strata}
    in_pool, passed, screened = recall_counts(members, pools, faceted, strata)
    lines, threats = [], []
    met = len(screened) / len(members) >= RECALL_TARGET if members else False
    lines.append(f"- pooled topic recall {rate(len(screened), len(members))} of the {len(members)} deduplicated standard members, screened by both stage-2 sessions; "
                 f"in-pool rate {rate(len(in_pool), len(members))}; stage-1 pass rate of in-pool members {rate(len(passed), len(in_pool))}; "
                 + (f"meets the {RECALL_TARGET:.2f} target" if met else f"below the {RECALL_TARGET:.2f} target; missed: " + ", ".join(sorted(set(members) - set(screened)))))
    if not met:
        threats.append(f"- recall target not reached: pooled topic recall {len(screened)}/{len(members)}; outside every pool {len(members) - len(in_pool)}, excluded by stage 1 "
                       f"{len(in_pool) - len(passed)}, not screened in stage 2 {len(passed) - len(screened)}")
    homes = member_facets(topic, {m.lower(): p for m, p in out["labels"].items()})
    for facet in facet_names(topic):
        mine = [m for m in members if facet in homes.get(m, [])]
        f_pool, f_pass, f_screened = recall_counts(mine, pools, faceted, strata)
        lines.append(f"- facet {facet}: recall {rate(len(f_screened), len(mine))} of the {len(mine)} members labelled for it; in-pool rate {rate(len(f_pool), len(mine))}; "
                     f"stage-1 pass rate {rate(len(f_pass), len(f_pool))}; reported, no pass or fail")
    if (topic["strata"].get("product", {}).get("channels") or {}).get("config_pool") is True and "product" in strata:
        channel = read_json(folder, "config-pool-channel.json")
        joined = {r.lower() for r in channel["joined"]}
        product = [m.lower() for m in stratum_members(out, "product")]
        outside = [m for m in product if not any(m in pools[s] for s in strata)]
        lines.append(f"- product channel from the config pool: {len(joined)} repositories joined the product pool before stage 1; they recover {len(set(product) & joined)} of "
                     f"the {len(product)} standard members the QGS judges labelled product; {len(outside)} of those members remain outside every pool")
        if outside:
            threats.append(f"- discovery gap: {len(outside)} standard members labelled product are in no pool: {', '.join(outside)}")
    lines.append(f"- {UPPER_ESTIMATE}")
    return lines, threats, out


def prisma_rows(topic, folder, strata, faceted, decided_rows):
    rows = []
    for stratum in strata:
        order = read_jsonl(folder, f"{stratum}-screening-order.jsonl")
        channels = {}
        for row in order:
            for channel in row.get("channels") or ["unknown"]:
                channels[channel] = channels.get(channel, 0) + 1
        rows += [(stratum, f"identified: {c}", n) for c, n in sorted(channels.items())]
        rows.append((stratum, "duplicates across channels", sum(channels.values()) - len(order)))
        results, plan = faceted[stratum]["results"], faceted[stratum]["plan"]
        rows.append((stratum, "stage-1 screened", len(results)))
        rows.append((stratum, "stage-1 passed unread (no text)", sum(v["auto"] for v in results.values())))
        rung_models = sorted({m for v in results.values() for m in v["verdicts"]})
        rows += [(stratum, f"stage-1 no from {m}", sum(v["verdicts"].get(m) == "no" for v in results.values())) for m in rung_models]
        rows.append((stratum, "excluded by automation (union rule)", sum(not v["pass"] for v in results.values())))
        rows.append((stratum, "stage-2 assessed", len(set(plan["order"]) & faceted[stratum]["common"])))
        rows.append((stratum, "stage-1 passes not assessed (stage-2 stop)", len(plan["passes"]) - len(plan["order"])))
        reasons = {}
        for row in decided_rows.get(stratum, []):
            reasons[row["decision"]] = reasons.get(row["decision"], 0) + 1
        rows += [(stratum, f"stage 2: {d}", n) for d, n in sorted(reasons.items())]
    return rows


def facet_lines(topic, strata, faceted, decided_rows):
    lines = []
    for stratum in strata:
        included = [r for r in decided_rows.get(stratum, []) if r["decision"] in ("eligible", "study")]
        labels = row_facets(topic, faceted, stratum)
        per = {f: sum(f in labels[r["rank"]].split(", ") for r in included) for f in facet_names(topic)}
        pairs = {}
        for r in included:
            held = [f for f in facet_names(topic) if f in labels[r["rank"]].split(", ")]
            for i, a in enumerate(held):
                for b in held[i + 1:]:
                    pairs[f"{a}+{b}"] = pairs.get(f"{a}+{b}", 0) + 1
        lines.append(f"- {stratum}: {len(included)} repositories included once each; counted per facet " + ", ".join(f"{f} {n}" for f, n in per.items())
                     + f"; overlap {', '.join(f'{k} {v}' for k, v in pairs.items()) or 'none'}; facets come from the stage-1 problem labels")
    for facet in facet_names(topic):
        rule = topic["facets"][facet]
        lines.append(f"- {facet}: problems {', '.join(rule['problems'])}; terms {', '.join(rule['terms'])}; its ranking orders stage 2 only when stage 2 must stop")
    return lines


def snowball_lines(folder, strata, faceted):
    snow = read_jsonl(folder, "snowball-screening-order.jsonl")
    cut_row = read_json(folder, "snowball-cut.json").get("cut_row") if (folder / "snowball-cut.json").is_file() else None
    if cut_row is not None:
        raise TopicError(f"snowball-cut.json cuts the snowball at row {cut_row}; quality criteria v4 refuses a snowball cut: every snowballed repository joins the pool, "
                         "so run snowball-above-cut.py --all and merge-snowball-order.py again")
    if not snow:
        return []
    pool = {r["repo"].lower() for r in faceted["config"]["inputs"]} if "config" in faceted else set()
    outside = sorted(r["repo"] for r in snow if r["repo"].lower() not in pool)
    if outside:
        raise TopicError(f"snowballed repositories {outside[:10]} are not in the config stage-1 pool; merge them with merge-snowball-order.py and build the stage-1 inputs again")
    cut = read_json(folder, "snowball-cut.json")
    return [f"- snowball: {len(snow)} repositories from the aggregators joined the config pool from rank {SNOWBALL_RANK_BASE + 1} on (cut: {cut['source']}); stage 1 read every one"]


def batch_lines(topic, folder, strata):
    lines, pooled = [], 0
    for batch in all_batches(folder):
        if not (folder / labels_file(batch)).is_file():
            continue
        sample = read_json(folder, set_file(batch))
        labels = read_json(folder, labels_file(batch))
        if labels.get("set_sha256") != hashlib.sha256((folder / set_file(batch)).read_bytes()).hexdigest():
            raise TopicError(f"{labels_file(batch)} was imported for another {batch} set")
        if labels.get("stage1_freeze_sha256") != hashlib.sha256((folder / FREEZE_FILE).read_bytes()).hexdigest():
            raise TopicError(f"{labels_file(batch)} was not imported under {FREEZE_FILE}")
        drawn = {d["id"]: d for d in read_json(folder, f"{batch}-draw.json")["rows"]}
        for stratum in strata:
            rows = [r for r in labels["rows"] if r["stratum"] == stratum]
            eligible = sum(r["user"]["decision"] == "eligible" for r in rows)
            pooled += eligible if not batch.startswith("held-out") else 0
            facets = {f: sum(drawn[r["id"]]["facet"] == f for r in rows) for f in facet_names(topic)}
            lines.append(f"- {batch} {stratum}: {len(rows)} rows ({sample['purpose']}), drawn per facet " + ", ".join(f"{f} {n}" for f, n in facets.items())
                         + f"; likely positives {sum(drawn[r['id']]['class'] != 'random' for r in rows)}; the user labelled {eligible} eligible")
    lines.append(f"- positives pooled over the batches the rung was chosen on: {pooled}")
    return lines


def stage1_lines(folder, strata):
    chosen = read_json(folder, RUNG_FILE)
    freeze = read_json(folder, FREEZE_FILE)
    lines = [f"- ladder frozen {freeze['date']} before any label was read (stage1-freeze.json sha256 `{hashlib.sha256((folder / FREEZE_FILE).read_bytes()).hexdigest()[:16]}`): "
             + "; ".join(f"rung {r['rung']} {' + '.join(r['models'])} on {r['shape']}" for r in freeze["ladder"])]
    for tried in chosen["tried"]:
        runs = "; ".join(f"run {i} {r['passed']}/{r['positives']} positives passed, one-sided 95% lower bound {r['lower']:.4f}" for i, r in enumerate(tried["runs"], 1))
        lines.append(f"- rung {tried['rung']}: {runs}; the runs differ on {tried['differ']} of {tried['rows']} rows; " + ("meets the rule" if tried["meets"] else "fails the rule"))
        if tried["meets"]:
            for stratum, s in tried["runs"][0]["strata"].items():
                low, high = s["interval"] or (0, 0)
                lines.append(f"- rung {tried['rung']} {stratum}: sensitivity {s['passed']}/{s['positives']} (95% CI {low:.2f}-{high:.2f}), pass rate {s['pass_rate']:.3f}")
    lines.append(f"- chosen: rung {chosen['rung']} after {len(chosen['tried'])} rungs tried; rule: pooled one-sided 95% Clopper-Pearson lower bound >= 0.95 in both runs")
    if chosen["rung"] > 1:
        held = held_out_check(folder, chosen["rung"], labelled(folder, held_out_batches(folder)))
        lines.append(f"- held-out confirmation: rung {chosen['rung']} passed {held['passed']}/{held['positives']} held-out positives, missed none; the batch's own one-sided "
                     f"lower bound {held['lower']:.4f}; the pooled bound above was measured on the set the rung was chosen on")
    return lines, chosen


def stage1_workflow(folder, sessions, strata, chosen):
    freeze = read_json(folder, FREEZE_FILE)
    rung = ladder_rung(chosen["rung"])
    for stratum in strata:
        for model in rung["models"]:
            key = pool_name(stratum, rung["shape"], model)
            entry = sessions.get(key) or {}
            bad = [b for b in entry.get("blocks", []) if (b.get("shape"), b.get("packet_sha256"), b.get("examples_sha256")) !=
                   (rung["shape"], freeze["packets"][stratum], freeze["examples_sha256"]) or len(b["ranks"]) > freeze["batch_max"]]
            if entry.get("model") != model or bad:
                raise TopicError(f"{key}: the stage-1 pool run is not {model} on the {rung['shape']} shape under the frozen packet and examples in batches of at most "
                                 f"{freeze['batch_max']}")


def run_text(run):
    sensitivity = "undefined" if run["sensitivity"] is None else f"{run['sensitivity']:.3f} (95% CI {run['interval'][0]:.2f}-{run['interval'][1]:.2f})"
    specificity = "undefined" if run["specificity"] is None else f"{run['specificity']:.3f}"
    labels = ", ".join(f"{k} {v['agree']}/{v['rows']}" + (f" (95% CI {v['interval'][0]:.2f}-{v['interval'][1]:.2f})" if v["interval"] else "") for k, v in run["labels"].items())
    return f"sensitivity {sensitivity}, specificity {specificity}, kappa {kappa_text(run['kappa'])}; label agreement {labels}"


def qgs_workflow(topic, folder, sessions, found):
    judges, lines = roster(topic), []
    listed = {r["id"] for r in candidate_rows(folder)}
    for judge, name in JUDGE_FILES.items():
        ids = {r["id"] for r in read_jsonl(folder, f"{name}.jsonl")}
        entry = sessions.get(name) or {}
        if judge == "reader" and not ids and not entry:
            lines.append("- QGS reader: no candidate was queued for the reader")
            continue
        blocks = entry.get("blocks") or []
        covered = {r for b in blocks for r in b["ranks"]}
        validated = {p for s in found[judge]["strata"].values() for r in s["runs"] for p in r["packets"]}
        packets = {b.get("packet_sha256") for b in blocks}
        if entry.get("model") != judges[judge]["model"] or ids != covered or {b.get("shape") for b in blocks} != {"thin"} or not packets <= validated or not ids <= listed:
            raise TopicError(f"{name}.jsonl: its {len(ids)} judgments are not all {judges[judge]['model']} runs on the thin QGS inputs under the validated {PACKET}; "
                             "only a validated judge in the validated workflow counts")
        lines.append(f"- QGS {judge}: {judges[judge]['model']} judged {len(ids)} candidates on the thin inputs it was validated on, under the validated packet")
    return lines


def judge_lines(topic, folder, strata, freeze, sessions):
    found = validate(topic, folder, freeze, tuple(strata))
    lines, threats = [], []
    batches = ", ".join(judged_batches(folder))
    for judge, entry in found.items():
        for stratum in strata:
            s = entry["strata"][stratum]
            if not s["qualified"]:
                raise TopicError(f"{judge} {entry['model']} did not qualify on the {stratum} calibration rows; replace it, validate the new judge and judge again before the record")
            lines.append(f"- {judge} {entry['cli']} {entry['model']}, {stratum}, {entry['shape']} inputs, batches {batches}: run 1 {run_text(s['runs'][0])}; run 2 "
                         f"{run_text(s['runs'][1])}; runs differ on {s['differ']} of {s['rows']} rows (kappa {kappa_text(s['run_kappa'])}); qualified")
    for stratum in strata:
        for side, judge in (("A", "screening-A"), ("B", "screening-B")):
            if (sessions.get(f"{stratum}-{side}") or {}).get("model") != found[judge]["model"]:
                raise TopicError(f"{stratum}-{side} did not run the validated {judge} {found[judge]['model']}")
            shapes = {b.get("shape", "full") for b in sessions[f"{stratum}-{side}"]["blocks"]}
            if shapes != {SHAPES["screening"]}:
                raise TopicError(f"{stratum}-{side} ran on the input shape {sorted(shapes)}, not the full shape its judge was validated on")
    lines += qgs_workflow(topic, folder, sessions, found)
    judges = roster(topic)
    if reader_shares_family(topic):
        threats.append(f"- reader shares the QGS judges' model family: the reader {judges['reader']['model']} and the QGS judges {judges['qgs-A']['model']} and "
                       f"{judges['qgs-B']['model']} are all {model_family(judges['reader']['model'])} models, so an error they share passes the adjudication; the cross-family "
                       "judge's yes is the counter-check")
    return lines, threats


def standard_lines(out):
    lines = [f"- standard: {len(out['final'])} members from {out['candidates']} candidates; {out['judged_by_both']} judged by both Claude judges; reader queue "
             f"{len(out['queue']['disputed'])} disputed or unsure, {len(out['queue']['cross_family_only'])} cross-family only; dropped {len(out['dropped'])}"
             + "".join(f"; dropped {i} {d['repo']} ({d['reason']}, {d['date']})" for i, d in out["dropped"].items())]
    cross = out.get("cross_family")
    if cross:
        kept = (f"{cross['judged']} candidates judged, joined by repository name, {cross['overlap']} also judged by both Claude judges; agreement with qgs-A "
                f"{cross['agreement']['A']}/{cross['overlap']} (kappa {kappa_text(cross['kappa']['A'])}), with qgs-B {cross['agreement']['B']}/{cross['overlap']} "
                f"(kappa {kappa_text(cross['kappa']['B'])}); {len(cross['accepted_against_both'])} candidates both Claude judges rejected and it accepted went to the reader, "
                f"which accepted {len(cross['reader_yes'])}" if cross["judged"] else "no judgment kept")
        lines.append(f"- cross-family QGS judge {cross['model']}: {kept}")
    return lines


def stage1_audit_lines(topic, folder, strata, freeze):
    lines = []
    for stratum in strata:
        out = elusion(topic, folder, stratum, freeze["session_a"])
        parts = "; ".join(f"{part} excludes {out[part]['rows']} of {out[part]['pool']} read, {len(out[part]['misses'])} confirmed eligible, upper elusion bound "
                          + ("n/a" if out[part]["upper"] is None else f"{out[part]['upper']:.4f}, at most {out[part]['at_most']} of the {out[part]['pool']} eligible")
                          for part in ("near", "far"))
        lines.append(f"- {stratum} stage-1 audit: {out['disagreements']} model disagreements (they pass under the union); {parts}; the stage-2 screener flagged "
                     f"{len(out['flagged'])} and the user checked every flagged row")
    return lines


def audit_lines(topic, folder, strata, sides, sessions):
    option = cross_family(topic)
    if option is None:
        return [], ["- no cross-family audit: the topic config names no cross_family model, so no model of another family checks the screening"]
    sample = read_json(folder, AUDIT_FILE) if (folder / AUDIT_FILE).is_file() else {}
    lines, threats = [], []
    for stratum in strata:
        rows = {r["order_rank"]: r for r in read_jsonl(folder, f"{stratum}-audit-{option['model']}.jsonl")}
        ranks = sample.get(stratum) or []
        if not ranks or set(ranks) - set(rows):
            threats.append(f"- cross-family audit pending: {stratum}: {len(set(ranks) & set(rows))} of {len(ranks)} audit rows screened by {option['model']}; the same-family "
                           "screening has no cross-family check until it runs")
            continue
        last = max(b["date"] for side in "AB" for b in sessions[f"{stratum}-{side}"]["blocks"])
        early = [b["date"] for b in (sessions.get(f"{stratum}-audit-{option['model']}") or {}).get("blocks", []) if b["date"] < last]
        if early:
            raise TopicError(f"{stratum}: the audit ran on {early[0]}, before stage 2 ended on {last}; the audit sample is drawn after stage 2 ends")
        audit = [decided("screening", stratum, rows[r]) for r in ranks]
        parts = []
        for side in "AB":
            pairs = list(zip(audit, [decided("screening", stratum, sides[stratum][side][r]) for r in ranks]))
            parts.append(f"with {side} {sum(a == b for a, b in pairs)}/{len(ranks)} (kappa {kappa_text(cohen_kappa(pairs)[1])})")
        lines.append(f"- {stratum} audit: {len(ranks)} rows drawn after stage 2 ended and screened again by {option['model']}: eligibility agreement {', '.join(parts)}")
    return lines, threats


def v4_parts(topic, folder, strata, freeze, sessions, faceted, common, decided_rows):
    sides = {s: {side: {r["order_rank"]: r for r in read_jsonl(folder, f"{s}-screen-{side}.jsonl")} for side in "AB"} for s in strata}
    for stratum in strata:
        faceted[stratum]["inputs"] = list(stage1_inputs(folder, stratum, stage1_results(folder, stratum)[0]["shape"]).values())
    recall, recall_threats, out = recall_lines(topic, folder, strata, faceted)
    stage1, chosen = stage1_lines(folder, strata)
    stage1_workflow(folder, sessions, strata, chosen)
    judges, judge_threats = judge_lines(topic, folder, strata, freeze, sessions)
    audits, audit_threats = audit_lines(topic, folder, strata, sides, sessions)
    stops = stage2_threats(strata, faceted)
    prisma = prisma_rows(topic, folder, strata, faceted, decided_rows)
    return {"recall": recall, "prisma": ["| stratum | stage | count |", "|---|---|---|"] + [f"| {s} | {k} | {v} |" for s, k, v in prisma],
            "facets": facet_lines(topic, strata, faceted, decided_rows) + snowball_lines(folder, strata, faceted),
            "calibration": batch_lines(topic, folder, strata), "stage1": stage1 + stage1_audit_lines(topic, folder, strata, freeze),
            "judges": judges + standard_lines(out) + audits, "threats": recall_threats + judge_threats + audit_threats + stops}
