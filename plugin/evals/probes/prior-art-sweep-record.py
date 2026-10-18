import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(sys.argv[1])
NAME = sys.argv[2]
D = REPO / "docs" / "prior-art" / "sweeps" / NAME
J = lambda name: json.loads((D / name).read_text())
L = lambda name: [json.loads(l) for l in (D / name).read_text().splitlines() if l.strip()] if (D / name).exists() else []
meta, table, study, surface = J("meta.json"), J("mechanism-table.json"), J("study.json"), J("surface-map.json")
JUDGED = ("Authority", "Methodology", "Objectivity", "Date", "Position")
SHORT = dict(zip(JUDGED, "AMODP"))
COPYLIKE = ("copy", "dead", "aggregator")
STOP_AT = {"config": 101, "product": 70}
FORCED = {"config": {300, 317, 358, 370, 410, 426, 533, 558, 952}, "product": set()}


def canon(stratum, mapping, side, name):
    key = f"{stratum}:{mapping[side].get(name, name)}"
    return table["aliases"].get(key, key)


def kind(mech):
    return table["class"].get(mech, table["default"])


def normal(decision):
    code = decision.split(":", 1)[1].strip().split(" ")[0].split("(")[0] if ":" in decision else ""
    return "eligible" if decision.startswith("eligible") else f"excluded: {code}"


def derive(stratum, mapping, side, row):
    scores = {k.capitalize(): v["v"] for k, v in row["scores"].items()}
    mechs = {canon(stratum, mapping, side, m) for m in row["mechanisms"]} - {m for m in table["class"] if table["class"][m] == "evidence"}
    first = normal(row["decision"])
    copy = first.split(": ")[-1] in COPYLIKE
    novelty = 0 if copy or not mechs else (1 if any(kind(m) == "new" for m in mechs) else 0.5)
    relevance = 1 if mechs else (0.5 if scores.get("Relevance") == 0.5 else 0)
    total = sum(scores[k] for k in JUDGED) + novelty
    if copy:
        decision = first
    elif relevance == 1 and novelty >= 0.5 and total >= 4.5:
        decision = "eligible"
    else:
        decision = "excluded: irrelevant" if relevance == 0 else "excluded: below-threshold"
    return {"scores": scores, "mechs": mechs, "novelty": novelty, "relevance": relevance, "total": total, "decision": decision}


studied = {k.lower(): v for k, v in study["study"].items()}
out_rows, differing, agreement, coded, beyond = {}, [], {}, set(), {}
for stratum in ("config", "product"):
    mapping = J(f"{stratum}-mechanism-map.json")
    adj = J(f"{stratum}-adjudication.json")["rows"]
    sides = {s: {r["order_rank"]: r for r in L(f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
    for s in "AB":
        for r in sides[s].values():
            coded |= {canon(stratum, mapping, s, m) for m in r["mechanisms"]}
    extras = {}
    for name in sorted(p.name for p in D.glob(f"{stratum}-reader-C-extra*.jsonl")):
        for e in L(name):
            key = table["aliases"].get(f"{stratum}:{e['name']}", f"{stratum}:{e['name']}")
            coded.add(key)
            for rank in e["rows"]:
                extras.setdefault(rank, set()).add(key)
    ranks = sorted(r for r in set(sides["A"]) & set(sides["B"]) if r <= STOP_AT[stratum] or r in FORCED[stratum] or r > 1000)
    beyond[stratum] = sorted(set(sides["A"]) | set(sides["B"]) - set(ranks))
    same = cells = 0
    rows = []
    for rank in ranks:
        a, b = derive(stratum, mapping, "A", sides["A"][rank]), derive(stratum, mapping, "B", sides["B"][rank])
        for c in JUDGED:
            cells += 1
            same += a["scores"][c] == b["scores"][c]
            if a["scores"][c] != b["scores"][c]:
                differing.append(f"{stratum} #{rank} {sides['A'][rank]['repo']} {c}: A {a['scores'][c]}, B {b['scores'][c]}")
        repo = sides["A"][rank]["repo"]
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
        if repo.lower() in studied:
            decision = "study" if decision == "eligible" else f"study (below-threshold: {a['total']:g})"
            reason = studied[repo.lower()]
        score = " ".join(f"{SHORT[c]}{a['scores'][c]:g}" + ("" if a["scores"][c] == b["scores"][c] else f"/{b['scores'][c]:g}") for c in JUDGED)
        score += f" N{a['novelty']:g}" + ("" if a["novelty"] == b["novelty"] else f"/{b['novelty']:g}")
        commit = sides["A"][rank].get("commit") or sides["B"][rank].get("commit") or "-"
        names = ", ".join(sorted(m.split(":", 1)[1] for m in mechs)) or "-"
        rows.append(f"| {rank} | {repo} | {commit} | {score} | {decision} | {names} | {reason.replace('|', '/')} |")
    out_rows[stratum] = rows
    agreement[stratum] = (same, cells)

missing_surface = sorted(m for m in coded if kind(m) != "evidence" and not any(m in v for v in list(surface["considered"].values()) + list(surface["outside the inventory"].values())))
criteria_hash = hashlib.sha256((REPO / meta["criteria"]).read_bytes()).hexdigest()[:16]
lines = [f"# {meta['title']}", "", f"- Role: {meta['role']}", f"- Date: {meta['date']}",
         f"- Criteria: {meta['criteria']} sha256[:16] `{criteria_hash}`",
         f"- Inventory: llms.txt sha256[:16] `{meta['inventory_digest']}` (docs/prior-art/claude-code-surfaces.md)",
         f"- Problems: {', '.join(meta['problems'])}; terms matched: {', '.join(meta['terms_matched'])}",
         f"- Data: `{NAME}/` (screening sessions A and B, reader C, maps, mechanism table, adjudications, recall standard); regenerate with `python3 plugin/evals/probes/prior-art-sweep-record.py . {NAME}`",
         "", "Scores read A1 M1 O1 D1 P1 N1 for Authority, Methodology, Objectivity, Date, Position and the derived Novelty; a/b shows session A's and B's values where they differ.", ""]
lines += ["## Query log", ""] + [f"- {stratum}: {q}" for stratum, qs in meta["query_log"].items() for q in qs] + [""]
lines += ["## PRISMA", "", "| stratum | stage | count |", "|---|---|---|"] + [f"| {s} | {k} | {v} |" for s, p in meta["prisma"].items() for k, v in p.items()] + [""]
lines += ["## Recall", "", meta["recall"], ""]
lines += ["## Agreement and capture-recapture", ""]
for s, (same, cells) in agreement.items():
    lines.append(f"- {s}: {same}/{cells} judged cells identical ({same / cells:.3f}); target 0.90")
lines += [f"- {s}: {J(f'{s}-adjudication.json')['capture_recapture']}" for s in ("config", "product")] + [""]
for stratum in ("config", "product"):
    lines += [f"## Stratum: {stratum}", "", meta["stop"][stratum], "", f"Screened beyond the stop or outside both sessions: {len(beyond[stratum])} rows, kept in the data files.", "",
              "### Screened rows", "", "| rank | repo | commit | scores | decision | mechanisms | reason |", "|---|---|---|---|---|---|---|"] + out_rows[stratum] + [""]
lines += ["## Deep study", "", study["budget"] + ". " + study["method"], "", study["coverage"], ""] + [f"- {k}: {v}" for k, v in study["flags"].items()] + [""]
lines += ["## Mechanisms", "", "| mechanism | class |", "|---|---|"] + [f"| {m} | {kind(m)} |" for m in sorted(coded)] + [""]
lines += ["## Surfaces", ""]
for name, mechs in surface["considered"].items():
    lines.append(f"- considered: {name}: {', '.join(m.split(':', 1)[-1] for m in mechs)}")
for name, reason in surface["not relevant"].items():
    lines.append(f"- not relevant: {name}: {reason}")
for name, mechs in surface["outside the inventory"].items():
    lines.append(f"- outside the inventory: {name}: {', '.join(m.split(':', 1)[-1] for m in mechs)}")
lines += ["", "## Gaps", ""] + [f"- {g}" for g in meta["gaps"]] + [""]
lines += ["## Differing cells", ""] + [f"- {d}" for d in differing] + [""]
(D.parent / f"{NAME}.md").write_text("\n".join(lines))
print(f"rows config {len(out_rows['config'])}, product {len(out_rows['product'])}; differing cells {len(differing)}; mechanisms {len(coded)}; mechanisms with no surface: {missing_surface}")
