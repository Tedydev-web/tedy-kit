import hashlib
import json
import re
from pathlib import Path

from study_agreement import clopper_pearson, cohen_kappa, rounded
from study_calibration_set import LABELS_FILE, SET_FILE
from study_protocol import EMPTY_TABLE
from study_qgs import cross_family
from study_screening_core import MechanismTable, derive, read_jsonl
from study_session import model_family
from study_topic import TopicError, session_option

SENSITIVITY_FLOOR, KAPPA_FLOOR, RUNS = 0.90, 0.60, (1, 2)
SCREENING_JUDGES, QGS_JUDGES = ("screening-A", "screening-B"), ("qgs-A", "qgs-B", "reader")
AUDIT_FILE, AUDIT_ROWS = "audit-sample.json", 20


def criteria_version(path):
    found = re.search(r"quality-criteria-v(\d+)\.md$", str(path or ""))
    return int(found.group(1)) if found else 0


def roster(topic, freeze=None):
    qgs, reader = topic.get("qgs_judges"), topic.get("reader")
    if not isinstance(qgs, dict) or not {"A", "B"} <= set(qgs) or reader is None:
        raise TopicError(f"{topic['path']}: quality criteria v4 needs qgs_judges A and B and a reader in the topic config")
    out = {f"qgs-{side}": {**session_option(topic, f"qgs_judges.{side}", qgs[side]), "kind": "qgs"} for side in "AB"}
    out["reader"] = {**session_option(topic, "reader", reader), "kind": "qgs"}
    if freeze:
        out["screening-A"] = {**freeze["session_a"], "kind": "screening"}
        out["screening-B"] = {**freeze["session_b"]["chosen"], "kind": "screening"}
    return out


def run_name(stratum, judge, option, run):
    return f"judge-{stratum}-{judge}-{option['model']}-run{run}"


def labelled_set(folder):
    folder = Path(folder)
    for name in (SET_FILE, LABELS_FILE):
        if not (folder / name).is_file():
            raise TopicError(f"no {name} in {folder}; draw the calibration set and import the user's labels first")
    labels = json.loads((folder / LABELS_FILE).read_text())
    if labels.get("set_sha256") != hashlib.sha256((folder / SET_FILE).read_bytes()).hexdigest():
        raise TopicError(f"{LABELS_FILE} was imported for another calibration set; import the labels again")
    return labels


def decided(kind, stratum, row):
    if kind == "qgs":
        return row["verdict"] == "yes"
    return derive(MechanismTable(EMPTY_TABLE), stratum, {"A": {}, "B": {}}, "A", row)["decision"] == "eligible"


def truth(kind, user):
    return user["Relevance"] == 1 if kind == "qgs" else user["decision"] == "eligible"


def metrics(pairs):
    tp = sum(t and d for t, d in pairs)
    fn = sum(t and not d for t, d in pairs)
    fp = sum(d and not t for t, d in pairs)
    tn = len(pairs) - tp - fn - fp
    sensitivity = tp / (tp + fn) if tp + fn else None
    kappa = rounded(cohen_kappa(pairs)[1])
    passed = sensitivity is not None and sensitivity >= SENSITIVITY_FLOOR and kappa is not None and kappa >= KAPPA_FLOOR
    return {"tp": tp, "fn": fn, "fp": fp, "tn": tn, "sensitivity": rounded(sensitivity), "interval": clopper_pearson(tp, tp + fn) if tp + fn else None, "kappa": kappa, "passed": passed}


def judge_run(folder, sessions, stratum, rows, name, kind, frozen):
    path = Path(folder) / f"{name}.jsonl"
    if not path.is_file():
        return None
    answers = {r["order_rank"]: r for r in read_jsonl(path.parent, path.name)}
    if set(answers) != {r["order_rank"] for r in rows}:
        raise TopicError(f"{name}.jsonl covers ranks {sorted(set(answers) ^ {r['order_rank'] for r in rows})[:10]} that the {stratum} calibration set does not, or the reverse")
    blocks = (sessions.get(name) or {}).get("blocks") or []
    hashes = {r: h for b in blocks for r, h in (b.get("row_sha256") or {}).items()}
    wrong = sorted(r["order_rank"] for r in rows if hashes.get(str(r["order_rank"])) != r["inputs_sha256"])
    if wrong:
        raise TopicError(f"{name}: ranks {wrong[:10]} were judged on other inputs than the calibration set holds")
    if frozen and any((b.get("packet_sha256"), b.get("criteria_sha256")) != (frozen["packet_sha256"], frozen["criteria_sha256"]) for b in blocks):
        raise TopicError(f"{name}: a block ran under a packet or criteria other than the frozen ones")
    pairs = [(truth(kind, r["user"]), decided(kind, stratum, answers[r["order_rank"]])) for r in rows]
    packets = sorted({b.get("packet_sha256") for b in blocks})
    return {"name": name, "decisions": [d for _, d in pairs], "packets": packets, **metrics(pairs)}


def validate(topic, folder, freeze=None, strata=("config", "product")):
    folder = Path(folder)
    labels = labelled_set(folder)
    if labels["complete"] != len(labels["rows"]):
        raise TopicError(f"the user labelled {labels['complete']} of {len(labels['rows'])} calibration rows; every row needs its label before a judge is validated")
    meta = folder / "meta.json"
    sessions = (json.loads(meta.read_text()).get("sessions") or {}) if meta.is_file() else {}
    out = {}
    for judge, option in roster(topic, freeze).items():
        entry = {"cli": option["cli"], "model": option["model"], "kind": option["kind"], "strata": {}}
        for stratum in strata:
            rows = [r for r in labels["rows"] if r["stratum"] == stratum]
            if not rows:
                continue
            frozen = freeze["strata"][stratum] if option["kind"] == "screening" and freeze else None
            runs = [judge_run(folder, sessions, stratum, rows, run_name(stratum, judge, option, n), option["kind"], frozen) for n in RUNS]
            both = None not in runs
            differ = sum(a != b for a, b in zip(runs[0]["decisions"], runs[1]["decisions"])) if both else None
            run_kappa = rounded(cohen_kappa(list(zip(runs[0]["decisions"], runs[1]["decisions"])))[1]) if both else None
            entry["strata"][stratum] = {"rows": len(rows), "positives": sum(truth(option["kind"], r["user"]) for r in rows), "runs": runs, "differ": differ,
                                        "run_kappa": run_kappa, "qualified": both and all(r["passed"] for r in runs)}
        entry["qualified"] = bool(entry["strata"]) and all(s["qualified"] for s in entry["strata"].values())
        out[judge] = entry
    return out


def require_qualified(topic, folder, freeze, judges, stratum):
    found = validate(topic, folder, freeze, (stratum,))
    failed = [f"{j} ({found[j]['model']})" for j in judges if not found[j]["strata"].get(stratum, {}).get("qualified")]
    if failed:
        raise TopicError(f"{', '.join(failed)} did not qualify as judges on the {stratum} calibration set (sensitivity >= {SENSITIVITY_FLOOR:.2f} and kappa >= {KAPPA_FLOOR:.2f} in both runs); "
                         "run validate-judges.py, and replace a judge that fails before it screens")
    return found


def reader_shares_family(topic):
    judges = roster(topic)
    return all(model_family(judges["reader"]["model"]) == model_family(judges[j]["model"]) for j in ("qgs-A", "qgs-B"))


def audit_option(topic):
    option = cross_family(topic)
    if option is None:
        raise TopicError(f"{topic['path']}: no cross_family model to screen the audit sample")
    return option
