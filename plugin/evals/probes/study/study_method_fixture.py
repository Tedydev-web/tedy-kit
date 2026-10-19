import hashlib
import json
import shutil
import sys
from pathlib import Path

from study_fixtures import screen_row, topic_repo, write_json, write_jsonl

CRITERIA = "docs/prior-art/quality-criteria-v2.md"
MODELS = {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}, "B": {"cli": "agy", "model": "gemini-3.8-flash-high"}}
SAME_FAMILY_B = {"cli": "claude", "model": "claude-sonnet-4-6", "effort": "high"}


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def method_repo(same_family=False, rated=None):
    repo = topic_repo(strata={"config": {"stop_row": 3, "forced_repos": ["o/forced"]}, "product": {"stop_row": 3, "forced_repos": []}})
    topic_file = repo / "docs/prior-art/topics/demo.json"
    b = SAME_FAMILY_B if same_family else MODELS["B"]
    write_json(topic_file, {**json.loads(topic_file.read_text()), "pilot_rows": 1, "sessions": {"A": MODELS["A"], "B": {"candidates": [MODELS["B"]], "fallback": SAME_FAMILY_B}}})
    D = repo / "docs/prior-art/sweeps/261001-demo"
    write_jsonl(D / "product-screening-order.jsonl", [{"order_rank": r, "repo": f"p/{r}", "forced": False} for r in (1, 2, 3)])
    for side in "AB":
        write_jsonl(D / f"product-screen-{side}.jsonl", [screen_row(1, "p/1", 1, ["hook"]), screen_row(2, "p/2", 0, [], "exclude: irrelevant"),
                                                         screen_row(3, "p/3", 1 if side == "A" else 0.5, ["hook"])])
    write_json(D / "product-adjudication.json", {"rows": {"3": {"decision": "eligible", "why": "the hook source runs the tests"}}, "capture_recapture": {"union": 1}})
    criteria = (repo / CRITERIA).read_text()
    meta, strata, sessions = json.loads((D / "meta.json").read_text()), {}, {}
    for stratum in ("config", "product"):
        packet = f"packet {stratum}\n"
        (D / f"screening-packet-{stratum}.md").write_text(packet)
        strata[stratum] = {"frozen_after_rank": 1, "packet": f"screening-packet-{stratum}.md", "protocol_sha256": sha(criteria + packet)[:16], "date": "2026-10-20"}
        for side, option in (("A", MODELS["A"]), ("B", b)):
            sessions[f"{stratum}-{side}"] = {"cli": option["cli"], "model": option["model"], "effort": option.get("effort") or "set by the model id",
                                             "packet_sha256": sha(packet), "inputs_sha256": "0" * 64, "date": "2026-10-20"}
    write_jsonl(D / "config-pilot-A.jsonl", [screen_row(1, "o/one", 1, ["gate"])])
    sessions["config-pilot-A"] = {**sessions["config-A"], "packet_sha256": sha("packet config, before the pilot revision\n")}
    write_json(D / "meta.json", {**meta, "criteria": CRITERIA, "sessions": sessions})
    write_json(D / "protocol-freeze.json", {"pilot_rows": 1, "criteria": CRITERIA, "strata": strata,
                                            "session_b": {"chosen": b, "pilot": {b["model"]: {"rows": 1, "agreement": 1.0, "kappa": {}, "eligibility_kappa": 1.0}}}})
    write_json(D / "config-qgs-adjudicated.json", {"final": ["o/one", "O/Three"]})
    write_json(D / "product-qgs-adjudicated.json", {"final": ["p/1", "p/9"]})
    if rated:
        rows = [{"stratum": "config", "order_rank": r, "repo": n, "commit": "c", "user": {"Authority": 1, "Methodology": 1, "Objectivity": 1, "Position": 1, "decision": "eligible"}}
                for r, n in ((3, "o/three"), (5, "o/forced"))]
        if rated == "partial":
            rows[0]["user"]["decision"] = None
        write_json(D / "calibration-sample.json", {"instructions": "i", "rows": rows})
    return repo


if __name__ == "__main__":
    from study_sweep_record import write_record
    from study_topic import load_topic
    built = method_repo(same_family="--same-family" in sys.argv, rated="full" if "--rated" in sys.argv else None)
    write_record(built, load_topic(built, "demo"))
    shutil.copytree(built, Path(sys.argv[1]), dirs_exist_ok=True)
    shutil.rmtree(built)
