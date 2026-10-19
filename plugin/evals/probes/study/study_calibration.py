import json
import random
from pathlib import Path

from study_agreement import KAPPA_CRITERIA
from study_protocol import EMPTY_TABLE, FREEZE_FILE
from study_screening_core import MechanismTable, derive, read_jsonl
from study_screening_input import inputs_file
from study_session import canonical_sha256
from study_topic import TopicError

SAMPLE_FILE = "calibration-sample.json"
SAMPLE_SIZE = 10
CALIBRATED_STRATA = ("config", "product")
INSTRUCTIONS = ("Rate each row blind, before reading the sweep record or the session files: read its inputs in calibration-inputs.md, the same inputs the sessions scored, then fill Authority, Methodology, "
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
    rng, rows, shown = random.Random(topic["sweep"]), [], []
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
        inputs = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
        missing = [r for r in picked if r not in inputs]
        if missing:
            raise TopicError(f"{stratum}: ranks {sorted(missing)} have no fetched inputs; the sample shows the user what the sessions scored")
        for r in sorted(picked):
            rows.append({"stratum": stratum, "order_rank": r, "repo": raw["A"][r]["repo"], "commit": commit_link(raw["A"][r]), "inputs_sha256": canonical_sha256(inputs[r]),
                         "user": {**{c: None for c in KAPPA_CRITERIA}, "decision": None}})
            shown.append(inputs[r])
    return {"instructions": INSTRUCTIONS, "rows": rows}, inputs_page(shown)


def inputs_page(inputs):
    parts = ["# Calibration inputs\n\nThe same inputs both sessions scored, row by row. This file stays in the working folder.\n"]
    for row in inputs:
        parts.append(f"## {row['repo']} (rank {row['order_rank']})\n\n- commit: {row.get('sha', '-')}\n- facts: {json.dumps(row.get('facts', {}), ensure_ascii=False)}\n"
                     f"- listing: {', '.join(row.get('listing', []))}\n" + (f"- could not be read: {row['error']}\n" if row.get("error") else "")
                     + f"\n### README\n\n{row.get('readme', '')}\n" + "".join(f"\n### {f['path']}\n\n{f['text']}\n" for f in row.get("files", [])))
    return "\n".join(parts)


def calibration_agreement(sample, folder):
    rows = sample["rows"]
    for r in rows:
        bad = {c: r["user"].get(c) for c in KAPPA_CRITERIA if r["user"].get(c) not in (None, 0, 0.5, 1)}
        decision = r["user"].get("decision")
        if decision is not None and not (isinstance(decision, str) and decision.startswith(("eligible", "excluded"))):
            bad["decision"] = decision
        if bad:
            raise TopicError(f"calibration row {r['stratum']} #{r['order_rank']}: {bad}; ratings are 1, 0.5 or 0 and the decision is eligible or excluded: <code>")
    scored = [r for r in rows if all(r["user"].get(k) is not None for k in (*KAPPA_CRITERIA, "decision"))]
    if len(scored) < len(rows):
        return {"rows": len(scored), "scored_of": len(rows)}
    derived = {s: derived_sides(folder, s)[1] for s in {r["stratum"] for r in rows}}
    out = {"rows": len(rows)}
    for side in "AB":
        sessions = [derived[r["stratum"]][r["order_rank"]][side] for r in rows]
        out[side] = {"decisions": sum((r["user"]["decision"] == "eligible") == (s["decision"] == "eligible") for r, s in zip(rows, sessions)),
                     "cells": sum(r["user"][c] == s["scores"][c] for r, s in zip(rows, sessions) for c in KAPPA_CRITERIA)}
    return out
