from study_sweep_record import JUDGED

KAPPA_CRITERIA = tuple(c for c in JUDGED if c != "Date")
CHAPMAN_NOTE = ("a lower bound, not an estimate: the two sessions are not independent captures (same packet, same rows, often the same model), "
                "and positive dependence biases the Chapman figure low")


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
