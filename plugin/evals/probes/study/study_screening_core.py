import json

from study_topic import TopicError

JUDGED = ("Authority", "Methodology", "Objectivity", "Date", "Position")
SHORT = dict(zip(JUDGED, "AMODP"))
COPYLIKE = ("copy", "dead", "aggregator")
ELIGIBLE_TOTAL = 4.5


def read_json(folder, name):
    path = folder / name
    if not path.is_file():
        raise TopicError(f"missing {path}")
    return json.loads(path.read_text())


def read_jsonl(folder, name):
    path = folder / name
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


class MechanismTable:
    def __init__(self, table):
        self.table = table

    def canon(self, stratum, mapping, side, name):
        key = f"{stratum}:{mapping[side].get(name, name)}"
        return self.table["aliases"].get(key, key)

    def kind(self, mech):
        return self.table["class"].get(mech, self.table["default"])

    def evidence(self):
        return {m for m, kind in self.table["class"].items() if kind == "evidence"}


def normal(decision):
    code = decision.split(":", 1)[1].strip().split(" ")[0].split("(")[0] if ":" in decision else ""
    return "eligible" if decision.startswith("eligible") else f"excluded: {code}"


def derive(table, stratum, mapping, side, row):
    scores = {k.capitalize(): v["v"] for k, v in row["scores"].items()}
    lacking = [k for k in JUDGED if not isinstance(scores.get(k), (int, float)) or isinstance(scores.get(k), bool)]
    if lacking:
        raise TopicError(f"{stratum} rank {row.get('order_rank')} (session {side}) lacks the judged score {lacking[0]}")
    mechs = {table.canon(stratum, mapping, side, m) for m in row["mechanisms"]} - table.evidence()
    first = normal(row["decision"])
    copy = first.split(": ")[-1] in COPYLIKE
    novelty = 0 if copy or not mechs else (1 if any(table.kind(m) == "new" for m in mechs) else 0.5)
    relevance = 1 if mechs else (0.5 if scores.get("Relevance") == 0.5 else 0)
    total = sum(scores[k] for k in JUDGED) + novelty
    if copy:
        decision = first
    elif relevance == 1 and novelty >= 0.5 and total >= ELIGIBLE_TOTAL:
        decision = "eligible"
    else:
        decision = "excluded: irrelevant" if relevance == 0 else "excluded: below-threshold"
    return {"scores": scores, "mechs": mechs, "novelty": novelty, "relevance": relevance, "total": total, "decision": decision}
