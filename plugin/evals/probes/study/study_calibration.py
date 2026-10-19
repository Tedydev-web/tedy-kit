import json
import random
from pathlib import Path

from study_agreement import KAPPA_CRITERIA
from study_protocol import EMPTY_TABLE, FREEZE_FILE
from study_screening_core import MechanismTable, derive, read_jsonl
from study_topic import TopicError

SAMPLE_FILE = "calibration-sample.json"
SAMPLE_SIZE = 10
CALIBRATED_STRATA = ("config", "product")
INSTRUCTIONS = ("Rate each row blind, before reading the sweep record or the session files: open the commit, read the asset files, then fill Authority, Methodology, "
                "Objectivity and Position with 1, 0.5 or 0 by the criteria file's anchors, and decision with eligible or excluded: <code>. Leave nothing null.")


def derived_sides(folder, stratum):
    folder = Path(folder)
    map_file, table_file = folder / f"{stratum}-mechanism-map.json", folder / "mechanism-table.json"
    mapping = json.loads(map_file.read_text()) if map_file.is_file() else {"A": {}, "B": {}}
    table = MechanismTable(json.loads(table_file.read_text()) if table_file.is_file() else EMPTY_TABLE)
    raw = {s: {r["order_rank"]: r for r in read_jsonl(folder, f"{stratum}-screen-{s}.jsonl")} for s in "AB"}
    common = sorted(set(raw["A"]) & set(raw["B"]))
    return raw, {r: {s: derive(table, stratum, mapping, s, raw[s][r]) for s in "AB"} for r in common}


def commit_link(row):
    return row.get("commit") or (f"https://github.com/{row['repo']}/commit/{row['sha']}" if row.get("sha") else "-")


def draw(topic, work):
    work = Path(work)
    if (work / SAMPLE_FILE).exists():
        raise TopicError(f"{work / SAMPLE_FILE} already exists; it may hold the user's ratings, so it is never redrawn")
    freeze_file = work / FREEZE_FILE
    frozen = json.loads(freeze_file.read_text())["strata"] if freeze_file.is_file() else {}
    strata = [s for s in CALIBRATED_STRATA if s in topic["strata"]]
    if not strata:
        raise TopicError(f"topic {topic['name']} has neither a config nor a product stratum to calibrate")
    rng, rows = random.Random(topic["sweep"]), []
    for index, stratum in enumerate(strata):
        raw, derived = derived_sides(work, stratum)
        after = frozen.get(stratum, {}).get("frozen_after_rank", 0)
        ranks = [r for r in derived if r > after]
        groups = [[r for r in ranks if derived[r]["A"]["decision"] == derived[r]["B"]["decision"] == "eligible"],
                  [r for r in ranks if derived[r]["A"]["decision"] != "eligible" and derived[r]["B"]["decision"] != "eligible"],
                  [r for r in ranks if (derived[r]["A"]["decision"] == "eligible") != (derived[r]["B"]["decision"] == "eligible")]]
        for group in groups:
            rng.shuffle(group)
        share = SAMPLE_SIZE // len(strata) + (1 if index < SAMPLE_SIZE % len(strata) else 0)
        picked = []
        while len(picked) < share and any(groups):
            for group in groups:
                if group and len(picked) < share:
                    picked.append(group.pop())
        if len(picked) < share:
            raise TopicError(f"{stratum}: only {len(picked)} post-freeze rows screened by both sessions, the sample needs {share}")
        rows += [{"stratum": stratum, "order_rank": r, "repo": raw["A"][r]["repo"], "commit": commit_link(raw["A"][r]),
                  "user": {**{c: None for c in KAPPA_CRITERIA}, "decision": None}} for r in sorted(picked)]
    return {"instructions": INSTRUCTIONS, "rows": rows}


def calibration_agreement(sample, folder):
    rows = sample["rows"]
    scored = [r for r in rows if all(v is not None for v in r["user"].values())]
    if len(scored) < len(rows):
        return {"rows": len(scored), "scored_of": len(rows)}
    derived = {s: derived_sides(folder, s)[1] for s in {r["stratum"] for r in rows}}
    out = {"rows": len(rows)}
    for side in "AB":
        sessions = [derived[r["stratum"]][r["order_rank"]][side] for r in rows]
        out[side] = {"decisions": sum((r["user"]["decision"] == "eligible") == (s["decision"] == "eligible") for r, s in zip(rows, sessions)),
                     "cells": sum(r["user"][c] == s["scores"][c] for r, s in zip(rows, sessions) for c in KAPPA_CRITERIA)}
    return out
