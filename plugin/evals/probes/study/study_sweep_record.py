import hashlib
from pathlib import Path

from study_method_record import is_method_sweep, method_parts, method_stops
from study_screening_core import JUDGED, SHORT, MechanismTable, derive, normal, read_json, read_jsonl
from study_topic import SNOWBALL_RANK_BASE, screened_strata, stratum_rule, sweep_folder


def screened_ranks(topic, folder, stratum, sides):
    stop = stratum_rule(topic, stratum, "stop_row", int)
    forced = {r["order_rank"] for r in read_jsonl(folder, f"{stratum}-screening-order.jsonl") if r.get("forced")}
    return sorted(r for r in set(sides["A"]) & set(sides["B"]) if r <= stop or r in forced or r > SNOWBALL_RANK_BASE)


def screen(repo, topic):
    D = sweep_folder(repo, topic)
    study = read_json(D, "study.json")
    table = MechanismTable(read_json(D, "mechanism-table.json"))
    strata = list(topic["strata"])
    studied = {k.lower(): v for k, v in study["study"].items()}
    out_rows, differing, agreement, coded, beyond, capture, decided, pairs = {}, [], {}, set(), {}, {}, {}, {}
    for stratum in strata:
        mapping = read_json(D, f"{stratum}-mechanism-map.json")
        adjudication = read_json(D, f"{stratum}-adjudication.json")
        adj = adjudication["rows"]
        capture[stratum] = adjudication["capture_recapture"]
        sides = {s: {r["order_rank"]: r for r in read_jsonl(D, f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
        for s in "AB":
            for r in sides[s].values():
                coded |= {table.canon(stratum, mapping, s, m) for m in r["mechanisms"]}
        extras = {}
        for extra in sorted(p.name for p in D.glob(f"{stratum}-reader-C-extra*.jsonl")):
            for e in read_jsonl(D, extra):
                key = table.table["aliases"].get(f"{stratum}:{e['name']}", f"{stratum}:{e['name']}")
                coded.add(key)
                for rank in e["rows"]:
                    extras.setdefault(rank, set()).add(key)
        ranks = screened_ranks(topic, D, stratum, sides)
        beyond[stratum] = sorted(set(sides["A"]) | set(sides["B"]) - set(ranks))
        same = cells = 0
        rows = []
        for rank in ranks:
            a, b = derive(table, stratum, mapping, "A", sides["A"][rank]), derive(table, stratum, mapping, "B", sides["B"][rank])
            pairs.setdefault(stratum, {})[rank] = (a, b)
            for c in JUDGED:
                cells += 1
                same += a["scores"][c] == b["scores"][c]
                if a["scores"][c] != b["scores"][c]:
                    differing.append(f"{stratum} #{rank} {sides['A'][rank]['repo']} {c}: A {a['scores'][c]}, B {b['scores'][c]}")
            repo_name = sides["A"][rank]["repo"]
            mechs = a["mechs"] | b["mechs"] | extras.get(rank, set())
            if a["decision"] == b["decision"] and str(rank) not in adj:
                decision = a["decision"]
                reason = f"both sessions {decision}; sums A {a['total']:g}, B {b['total']:g}"
            elif str(rank) not in adj and "eligible" not in (a["decision"], b["decision"]):
                decision = a["decision"]
                reason = f"both sessions exclude; codes differ (A {a['decision']}, B {b['decision']}); sums A {a['total']:g}, B {b['total']:g}"
            else:
                decision = normal(adj[str(rank)]["decision"])
                reason = "adjudicated: " + adj[str(rank)]["why"]
            if repo_name.lower() in studied:
                decision = "study" if decision == "eligible" else f"study (below-threshold: {a['total']:g})"
                reason = studied[repo_name.lower()]
            score = " ".join(f"{SHORT[c]}{a['scores'][c]:g}" + ("" if a["scores"][c] == b["scores"][c] else f"/{b['scores'][c]:g}") for c in JUDGED)
            score += f" N{a['novelty']:g}" + ("" if a["novelty"] == b["novelty"] else f"/{b['novelty']:g}")
            commit = sides["A"][rank].get("commit") or sides["B"][rank].get("commit") or "-"
            names = ", ".join(sorted(m.split(":", 1)[1] for m in mechs)) or "-"
            rows.append(f"| {rank} | {repo_name} | {commit} | {score} | {decision} | {names} | {reason.replace('|', '/')} |")
            issues = set(sides["A"][rank].get("issues") or []) | set(sides["B"][rank].get("issues") or [])
            decided.setdefault(stratum, []).append({"rank": rank, "repo": repo_name, "decision": decision, "mechs": mechs, "session_mechs": a["mechs"] | b["mechs"], "issues": issues})
        out_rows[stratum] = rows
        agreement[stratum] = (same, cells)
    return {"folder": D, "study": study, "table": table, "strata": strata, "rows": out_rows, "differing": differing, "agreement": agreement,
            "coded": coded, "beyond": beyond, "capture": capture, "decided": decided, "pairs": pairs}


def render(repo, topic):
    repo = Path(repo)
    method_sweep = is_method_sweep(sweep_folder(repo, topic))
    screened = {**topic, "strata": {k: topic["strata"][k] for k in screened_strata(topic)}} if method_sweep else topic
    stops = method_stops(screened, sweep_folder(repo, topic)) if method_sweep else None
    s = screen(repo, screened)
    D, study, table, strata, coded, differing = s["folder"], s["study"], s["table"], s["strata"], s["coded"], s["differing"]
    out_rows, agreement, beyond, capture = s["rows"], s["agreement"], s["beyond"], s["capture"]
    name = topic["sweep"]
    meta, surface = read_json(D, "meta.json"), read_json(D, "surface-map.json")
    surfaced = list(surface["considered"].values()) + list(surface["outside the inventory"].values())
    missing_surface = sorted(m for m in coded if table.kind(m) != "evidence" and not any(m in v for v in surfaced))
    criteria_hash = hashlib.sha256((repo / meta["criteria"]).read_bytes()).hexdigest()[:16]
    lines = [f"# {meta['title']}", "", f"- Role: {meta['role']}", f"- Date: {meta['date']}",
             f"- Criteria: {meta['criteria']} sha256[:16] `{criteria_hash}`",
             f"- Inventory: llms.txt sha256[:16] `{meta['inventory_digest']}` (docs/prior-art/claude-code-surfaces.md)",
             f"- Problems: {', '.join(meta['problems'])}; terms matched: {', '.join(meta['terms_matched'])}",
             f"- Data: `{name}/` (screening sessions A and B, reader C, maps, mechanism table, adjudications, recall standard); regenerate with `python3 plugin/evals/probes/prior-art-sweep-record.py . {name}`",
             "", "Scores read A1 M1 O1 D1 P1 N1 for Authority, Methodology, Objectivity, Date, Position and the derived Novelty; a/b shows session A's and B's values where they differ.", ""]
    lines += ["## Query log", ""] + [f"- {stratum}: {q}" for stratum, qs in meta["query_log"].items() for q in qs] + [""]
    lines += ["## PRISMA", "", "| stratum | stage | count |", "|---|---|---|"] + [f"| {s} | {k} | {v} |" for s, p in meta["prisma"].items() for k, v in p.items()] + [""]
    method = method_parts(repo, topic, s, meta) if stops else None
    lines += ["## Recall", "", meta["recall"], ""] + (method["recall"] if method else [])
    lines += ["## Agreement and capture-recapture", ""]
    if method:
        lines += method["agreement"] + method["sections"]
    else:
        for s, (same, cells) in agreement.items():
            lines.append(f"- {s}: {same}/{cells} judged cells identical ({same / cells:.3f}); target 0.90")
        lines += [f"- {s}: {capture[s]}" for s in strata] + [""]
    for stratum in strata:
        lines += [f"## Stratum: {stratum}", "", stops[stratum] if stops else meta["stop"][stratum], "", f"Screened beyond the stop or outside both sessions: {len(beyond[stratum])} rows, kept in the data files.", "",
                  "### Screened rows", "", "| rank | repo | commit | scores | decision | mechanisms | reason |", "|---|---|---|---|---|---|---|"] + out_rows[stratum] + [""]
    lines += ["## Deep study", "", study["budget"] + ". " + study["method"], "", study["coverage"], ""] + [f"- {k}: {v}" for k, v in study["flags"].items()] + [""]
    lines += ["## Mechanisms", "", "| mechanism | class |", "|---|---|"] + [f"| {m} | {table.kind(m)} |" for m in sorted(coded)] + [""]
    lines += ["## Surfaces", ""]
    for surface_name, mechs in surface["considered"].items():
        lines.append(f"- considered: {surface_name}: {', '.join(m.split(':', 1)[-1] for m in mechs)}")
    for surface_name, reason in surface["not relevant"].items():
        lines.append(f"- not relevant: {surface_name}: {reason}")
    for surface_name, mechs in surface["outside the inventory"].items():
        lines.append(f"- outside the inventory: {surface_name}: {', '.join(m.split(':', 1)[-1] for m in mechs)}")
    lines += ["", "## Gaps", ""] + [f"- {g}" for g in meta["gaps"]] + [""]
    lines += ["## Differing cells", ""] + [f"- {d}" for d in differing] + [""]
    counts = ", ".join(f"{s} {len(out_rows[s])}" for s in strata)
    summary = f"rows {counts}; differing cells {len(differing)}; mechanisms {len(coded)}; mechanisms with no surface: {missing_surface}"
    return "\n".join(lines), summary


def write_record(repo, topic):
    text, summary = render(repo, topic)
    (sweep_folder(repo, topic).parent / f"{topic['sweep']}.md").write_text(text)
    return summary
