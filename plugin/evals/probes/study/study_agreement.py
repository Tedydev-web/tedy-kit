from study_screening_core import JUDGED
from study_topic import SNOWBALL_RANK_BASE, TopicError

EFFORT_BOUND, BLOCK, HARD_CAP = 60, 10, 200
RECALL_TARGET = 0.8
RECALL_FIX = "change the screening-order formula or the cut, not the terms"
KAPPA_CRITERIA = tuple(c for c in JUDGED if c != "Date")
CHAPMAN_NOTE = ("a lower bound, not an estimate: the two sessions are not independent captures (same packet, same rows, often the same model), "
                "and positive dependence biases the Chapman figure low")


def block_yields(ranks, firsts, forced):
    seen, yields = set(), []
    unforced = [r for r in ranks if r <= HARD_CAP and r not in forced]
    for start in range(0, len(unforced), BLOCK):
        block = unforced[start:start + BLOCK]
        new = set().union(*(firsts.get(r, set()) for r in block)) - seen
        seen |= new
        yields.append((block[0], block[-1], len(new)))
    return yields


def stop_row(yields):
    for first, last, new in yields:
        if last >= EFFORT_BOUND and (new == 0 or last >= HARD_CAP):
            return last
    return None


def effort_stop(common, firsts, forced, order_ranks):
    screened = {r for r in common if r <= HARD_CAP and r not in forced}
    unforced = sorted(r for r in order_ranks if r <= HARD_CAP and r not in forced)
    row = stop_row(block_yields(common, firsts, forced))
    rule = "effort bound"
    if row is None:
        if not screened or any(r not in screened for r in unforced):
            return None, "not reached"
        row, rule = max(screened), "pool exhausted"
    gaps = [r for r in unforced if r <= row and r not in screened]
    return (None, f"ranks {gaps} up to row {row} were not screened by both sessions") if gaps else (row, rule)


def chapman(mech_a, mech_b):
    shared = len(mech_a & mech_b)
    value = (len(mech_a) + 1) * (len(mech_b) + 1) / (shared + 1) - 1
    return {"A": len(mech_a), "B": len(mech_b), "shared": shared, "union": len(mech_a | mech_b), "chapman_lower_bound": round(value, 1)}


def rounded(value):
    return None if value is None else round(value, 3)


def kappa_text(value):
    return "undefined (one category)" if value is None else f"{value:.3f}"


def recall_at_cut(stratum, qgs, order_rows, cut, screened_by_both=None):
    if not qgs:
        raise TopicError(f"the {stratum} quasi-gold standard is empty")
    if not order_rows:
        raise TopicError(f"no {stratum} screening order to measure recall at the cut against")
    ranks = {r["repo"].lower(): r for r in order_rows}
    screened = {k for k, r in ranks.items() if (r["order_rank"] <= cut or r.get("forced") or r["order_rank"] > SNOWBALL_RANK_BASE)
                and (screened_by_both is None or r["order_rank"] in screened_by_both)}
    at = [q for q in qgs if q.lower() in screened]
    recall = len(at) / len(qgs)
    out = {"stratum": stratum, "cut": cut, "size": len(qgs), "at_cut": len(at), "recall": round(recall, 3), "target": RECALL_TARGET, "below_target": recall < RECALL_TARGET,
           "missed": [{"repo": q.lower(), "rank": ranks.get(q.lower(), {}).get("order_rank")} for q in qgs if q.lower() not in screened]}
    return {**out, "fix": f"below the target: {RECALL_FIX}"} if out["below_target"] else out


def cohen_kappa(pairs):
    pairs = list(pairs)
    if not pairs:
        raise TopicError("kappa needs at least one rated pair")
    observed = sum(a == b for a, b in pairs) / len(pairs)
    labels = {value for pair in pairs for value in pair}
    expected = sum((sum(a == label for a, _ in pairs) / len(pairs)) * (sum(b == label for _, b in pairs) / len(pairs)) for label in labels)
    return observed, (observed - expected) / (1 - expected) if expected < 1 else None


def session_kappas(rows):
    judged = {c: rounded(cohen_kappa((r["A"]["scores"][c], r["B"]["scores"][c]) for r in rows)[1]) for c in KAPPA_CRITERIA}
    eligible = [(r["A"]["decision"] == "eligible", r["B"]["decision"] == "eligible") for r in rows]
    return judged, rounded(cohen_kappa(eligible)[1]), sum(a != b for a, b in eligible)
