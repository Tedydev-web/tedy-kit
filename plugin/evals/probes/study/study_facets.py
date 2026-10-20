import json
from pathlib import Path

from study_agreement import BLOCK, EFFORT_BOUND, HARD_CAP, RECALL_TARGET, clopper_pearson
from study_qgs import member_facets, whole_topic
from study_screening_core import read_jsonl
from study_topic import SNOWBALL_RANK_BASE, TopicError, screened_strata

FACET_ORDERS = "facet-orders.json"
FACETS_DIR = "facets"
UNION_FIELDS = ("units", "contract_files", "channels", "via")


def facet_names(topic):
    whole_topic(topic, "a faceted step")
    facets = topic.get("facets")
    if not isinstance(facets, dict) or not facets:
        raise TopicError(f"{topic['path']}: quality criteria v4 screens a topic by facets; declare at least one facet, one holding every problem when the topic is not split")
    return list(facets)


def first_rank(row):
    regular = [e["rank"] for e in row["facets"].values() if e["rank"] <= SNOWBALL_RANK_BASE]
    return min(regular) if regular else min(e["rank"] for e in row["facets"].values())


def merge_key(names):
    return lambda row: (first_rank(row), min(names.index(f) for f, e in row["facets"].items() if e["rank"] == first_rank(row)), row["repo"].lower())


def facet_inputs(work, names, stratum):
    found = {}
    for name in names:
        folder = Path(work) / FACETS_DIR / name
        order = read_jsonl(folder, f"{stratum}-screening-order.jsonl")
        if not order:
            raise TopicError(f"no {stratum}-screening-order.jsonl in {folder}; rank the facet and export its screening order first")
        ranked = folder / f"{stratum}-ranked.json"
        counted = json.loads(ranked.read_text()).get("code_queries_counted") if ranked.is_file() else None
        if not isinstance(counted, list):
            raise TopicError(f"{ranked} does not list the facet's counted code-search queries; rank the facet again with this toolchain")
        cut = folder / "snowball-cut.json"
        found[name] = {"order": order, "code_queries_counted": counted, **({"snowball_cut": json.loads(cut.read_text())} if stratum == "config" and cut.is_file() else {})}
    return found


def merge_orders(topic, work, stratum):
    names = facet_names(topic)
    inputs = facet_inputs(work, names, stratum)
    target = Path(work) / f"{stratum}-screening-order.jsonl"
    existing = {r["repo"].lower(): r for r in read_jsonl(target.parent, target.name)}
    merged = {}
    for name in names:
        for row in inputs[name]["order"]:
            key = row["repo"].lower()
            entry = merged.setdefault(key, {**{k: v for k, v in row.items() if k not in ("order_rank", "forced", "order")}, "facets": {}})
            for field in UNION_FIELDS:
                if field in row:
                    entry[field] = list(dict.fromkeys((entry.get(field) or []) + list(row[field])))
            entry["facets"][name] = {"rank": row["order_rank"], "forced": bool(row.get("forced")), "order": row.get("order")}
    lost = sorted(r["repo"] for k, r in existing.items() if k not in merged)
    if lost:
        raise TopicError(f"{target} holds {lost}, which no facet order lists any more; a screened row is never dropped, so restore the facet orders or start a new working folder")
    rows, number = [], max([0] + [r["order_rank"] for r in existing.values()])
    for key, entry in sorted(merged.items(), key=lambda item: merge_key(names)(item[1])):
        entry["forced"] = any(e["forced"] for e in entry["facets"].values())
        if key in existing:
            entry["order_rank"] = existing[key]["order_rank"]
        else:
            number += 1
            entry["order_rank"] = number
        rows.append(entry)
    rows.sort(key=lambda r: r["order_rank"])
    summary = {name: {k: v for k, v in data.items() if k != "order"} | {"rows": len(data["order"])} for name, data in inputs.items()}
    return rows, summary


def write_merged(topic, work):
    work = Path(work)
    out = {}
    for stratum in screened_strata(topic):
        rows, summary = merge_orders(topic, work, stratum)
        temporary = work / f"{stratum}-screening-order.jsonl.tmp"
        temporary.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        temporary.replace(work / f"{stratum}-screening-order.jsonl")
        out[stratum] = {"facets": summary, "rows": len(rows), "shared": sum(len(r["facets"]) > 1 for r in rows)}
    (work / FACET_ORDERS).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def last_unforced(order, facet):
    ranks = [r["facets"][facet]["rank"] for r in order if facet in r["facets"] and not r["facets"][facet]["forced"] and r["facets"][facet]["rank"] <= HARD_CAP]
    return max(ranks, default=0)


def depth_facets(row, depths):
    return sorted(f for f, e in row["facets"].items() if f in depths and (e["forced"] or e["rank"] > SNOWBALL_RANK_BASE or e["rank"] <= depths[f]))


def found_members(members, order, depths, screened=None, facet=None):
    rows = {r["repo"].lower(): r for r in order}
    hits = []
    for member in members:
        row = rows.get(member.lower())
        if row is None or (screened is not None and row["order_rank"] not in screened):
            continue
        held = depth_facets(row, depths)
        if held and (facet is None or facet in held):
            hits.append(member)
    return hits


def standard_labels(adjudicated):
    resolved = adjudicated.get("resolved") or {}
    if resolved.get("of") != adjudicated.get("final"):
        raise TopicError("the adjudicated standard holds no resolved list for its current final list; run qgs-recall.py --write")
    labels = adjudicated.get("labels")
    if not isinstance(labels, dict) or sorted(labels) != sorted(adjudicated["final"]):
        raise TopicError("the adjudicated standard does not label every member with its problems; build it with qgs-standard.py --write")
    canonical = {}
    for member in adjudicated["final"]:
        name = resolved.get("renamed", {}).get(member, member)
        canonical.setdefault(name.lower(), (name, set()))[1].update(labels[member])
    return {name: sorted(problems) for name, problems in canonical.values()}


def depth_plan(topic, order, labels, screened=None):
    names = facet_names(topic)
    if not labels:
        raise TopicError("the quasi-gold standard is empty")
    homes = member_facets(topic, labels)
    last = {f: last_unforced(order, f) for f in names}
    rounds, chosen = [], None
    for depth in range(EFFORT_BOUND, HARD_CAP + 1, BLOCK):
        depths = {f: min(depth, last[f]) for f in names}
        hits = found_members(list(labels), order, depths)
        rounds.append({"depth": depth, "found": len(hits)})
        if len(hits) / len(labels) >= RECALL_TARGET:
            chosen = depth
            break
    depth = chosen or HARD_CAP
    depths = {f: min(depth, last[f]) for f in names}
    stops = {f: {"row": depths[f], "rule": ("pool exhausted" if last[f] < depth else "recall target" if chosen else "hard cap")} for f in names}
    planned = found_members(list(labels), order, depths)
    hits = found_members(list(labels), order, depths, screened)
    low, high = clopper_pearson(len(hits), len(labels))
    facets = {}
    for f in names:
        own = [m for m, held in homes.items() if f in held]
        found = found_members(own, order, depths, screened, f)
        facets[f] = {"size": len(own), "found": len(found), "interval": clopper_pearson(len(found), len(own)) if own else None,
                     "missed": sorted(set(own) - set(found), key=str.lower)}
    return {"depth": depth, "reached": chosen is not None, "stops": stops, "rounds": rounds, "size": len(labels), "planned": len(planned), "found": len(hits), "interval": (low, high),
            "missed": sorted(set(labels) - set(hits), key=str.lower), "facets": facets}


def depth_ranks(order, stops):
    return {r["order_rank"] for r in order if depth_facets(r, stops)}


def overlap_counts(order, stops, screened):
    names = list(stops)
    rows = [r for r in order if r["order_rank"] in screened]
    held = {r["order_rank"]: depth_facets(r, stops) for r in rows}
    per_facet = {f: sum(f in h for h in held.values()) for f in names}
    pairs = {f"{a}+{b}": sum(a in h and b in h for h in held.values()) for i, a in enumerate(names) for b in names[i + 1:]}
    return {"unique": sum(bool(h) for h in held.values()), "per_facet": per_facet, "pairs": {k: v for k, v in pairs.items() if v}}
