from study_sweep_record import JUDGED

EFFORT_BOUND, BLOCK, HARD_CAP = 60, 10, 200
KAPPA_CRITERIA =tuple(c for c in JUDGED if c != "Date")
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
    row = stop_row(block_yields(common, firsts, forced))
    if row is not None:
        return row, "effort bound"
    screened = {r for r in common if r <= HARD_CAP and r not in forced}
    left = [r for r in order_ranks if r <= HARD_CAP and r not in forced and r not in screened]
    return (max(screened), "pool exhausted") if screened and not left else (None, "not reached")


def cohen_kappa(pairs):
    pairs = list(pairs)
    observed = sum(a == b for a, b in pairs) / len(pairs)
    labels = {value for pair in pairs for value in pair}
    expected = sum((sum(a == label for a, _ in pairs) / len(pairs)) * (sum(b == label for _, b in pairs) / len(pairs)) for label in labels)
    return observed, (observed - expected) / (1 - expected) if expected < 1 else 1.0


def session_kappas(rows):
    judged = {c: round(cohen_kappa((r["A"]["scores"][c], r["B"]["scores"][c]) for r in rows)[1], 3) for c in KAPPA_CRITERIA}
    eligible = [(r["A"]["decision"] == "eligible", r["B"]["decision"] == "eligible") for r in rows]
    return judged, round(cohen_kappa(eligible)[1], 3), sum(a != b for a, b in eligible)
