import hashlib
import json
from collections import Counter
from pathlib import Path

from study_topic import TopicError, record_label, sweep_folder

STOP_MARK = "stop at the scale checkpoint"
QUALITY = ("Authority", "Methodology", "Objectivity", "Position")
NEED = 2
PASSES = ((1, lambda s: s["stars"] >= 100 and s["quality"] >= 3), (2, lambda s: s["authority"] == 1 and s["quality"] >= 3.5))
RULE = ("purposive picks from the reference-eligible rows: pass 1 takes sources with 100 or more stars and reference quality (Authority + Methodology + Objectivity + "
        "Position) of 3 or more, pass 2 takes sources with Authority 1 and quality of 3.5 or more; in each pass a pick adds the registry problems still held by fewer than "
        f"{NEED} picks, ties going to quality, then stars, then name; a supplement names sources outside the drawn rows, each with its reason")


def problem_key(problem):
    head = problem.rstrip("0123456789")
    return head, int(problem[len(head):] or 0)


def read(folder, name):
    path = Path(folder) / name
    if not path.is_file():
        raise TopicError(f"no {name} in {folder}; write the stopped sweep with stop-sweep.py")
    return json.loads(path.read_text())


def sources(eligible):
    out = {}
    for row in eligible:
        entry = out.setdefault(row["repo"].lower(), {"repo": row["repo"], "problems": set(), "quality": 0, "authority": 0, "stars": 0})
        entry["problems"] |= set(row["problems"])
        entry["quality"] = max(entry["quality"], sum(row[c] for c in QUALITY))
        entry["authority"] = max(entry["authority"], row["Authority"])
        entry["stars"] = max(entry["stars"], row["stars"])
    return list(out.values())


def deep_picks(eligible):
    held, picks = Counter(), []
    for number, gate in PASSES:
        pool = [s for s in sources(eligible) if gate(s)]
        while True:
            chosen = {p["repo"] for p in picks}
            gain = lambda s: sorted((p for p in s["problems"] if held[p] < NEED), key=problem_key)
            left = [s for s in pool if s["repo"] not in chosen and gain(s)]
            if not left:
                break
            best = max(left, key=lambda s: (len(gain(s)), s["quality"], s["stars"], s["repo"]))
            picks.append({"repo": best["repo"], "pass": number, "adds": gain(best)})
            held.update(best["problems"])
    return picks


def number(value):
    return f"{value:g}"


def frozen_batches(folder):
    batches = []
    for path in sorted(Path(folder).glob("reference-freeze-*.json")):
        batch = path.name[len("reference-freeze-"):-len(".json")]
        freeze = json.loads(path.read_text())
        for kind in ("set", "labels"):
            name = f"{batch}-{kind}.json"
            if hashlib.sha256((Path(folder) / name).read_bytes()).hexdigest() != freeze[f"{kind}_sha256"]:
                raise TopicError(f"{name} is not the file {path.name} froze")
        batches.append((batch, freeze))
    if not batches:
        raise TopicError(f"no reference-freeze-<batch>.json in {folder}; a stopped sweep reads frozen reference labels only")
    return batches


def render_stopped(repo, topic):
    repo, folder = Path(repo), sweep_folder(repo, topic)
    meta, stop, study, surfaces = (read(folder, n) for n in ("meta.json", "stop.json", "deep-study.json", "surface-map.json"))
    criteria = (repo / meta["criteria"]).read_bytes()
    if STOP_MARK not in criteria.decode():
        raise TopicError(f"{meta['criteria']} names no {STOP_MARK}; a sweep stops there only under a dated criteria row")
    for extra in study["supplement"]:
        if not str(extra.get("reason") or "").strip():
            raise TopicError(f"supplement {extra['repo']} needs a reason")
    batches = frozen_batches(folder)
    facts = {(r["batch"], r["stratum"], r["rank"]): r for r in study["rows"]}
    labelled = []
    for batch, _ in batches:
        for row in read(folder, f"{batch}-labels.json")["rows"]:
            fact = facts.get((batch, row["stratum"], row["order_rank"]))
            if fact is None or fact["repo"].lower() != row["repo"].lower():
                raise TopicError(f"deep-study.json holds no row for {batch} {row['stratum']} rank {row['order_rank']} ({row['repo']})")
            labelled.append({**row, "batch": batch, "commit": fact["commit"], "stars": fact["stars"]})
    eligible = [{"repo": r["repo"], "stars": r["stars"], **r["user"]} for r in labelled if r["user"]["decision"] == "eligible"]
    picks = {p["repo"].lower(): p for p in deep_picks(eligible)}
    held = Counter()
    for source in sources(eligible):
        if source["repo"].lower() in picks:
            held.update(source["problems"])
    for extra in study["supplement"]:
        held.update(extra["problems"])
    problems = meta["problems"]
    lines = [f"# {meta['title']}", "", f"- {record_label(repo, topic)}: {meta['role']}", f"- Date: {stop['date']}",
             f"- Criteria: {meta['criteria']} sha256[:16] `{hashlib.sha256(criteria).hexdigest()[:16]}`",
             f"- Inventory: llms.txt sha256[:16] `{meta['inventory_digest']}` (docs/prior-art/claude-code-surfaces.md)",
             f"- Problems: {', '.join(problems)}",
             f"- Status: stopped at the scale checkpoint on {stop['date']}: {stop['decision']}",
             f"- Data: `{topic['sweep']}/` (the drawn batches with their frozen reference labels, the stop and the deep-study rows); regenerate with "
             f"`python3 plugin/evals/probes/prior-art-sweep-record.py . {topic['sweep']}`", "", "## Reference labels", ""]
    lines += [f"- {batch}: set sha256[:16] `{f['set_sha256'][:16]}`, labels sha256[:16] `{f['labels_sha256'][:16]}`, as reference-freeze-{batch}.json froze them" for batch, f in batches]
    lines += ["", "## Deep-study selection", "", f"- rule: {RULE}"]
    lines += [f"- pass {p['pass']}: {p['repo']} adds {', '.join(p['adds'])}" for p in picks.values()]
    lines += [f"- supplement: {e['repo']} ({', '.join(e['problems'])}): {e['reason']}" for e in study["supplement"]]
    by = lambda test: ", ".join(p for p in problems if test(held[p])) or "none"
    lines += [f"- problems held by {NEED} or more studied sources: {by(lambda n: n >= NEED)}; by one: {by(lambda n: n == 1)}; by none: {by(lambda n: n == 0)}", ""]
    for stratum in sorted({r["stratum"] for r in labelled} | {e["stratum"] for e in study["supplement"]}):
        rows = [r for r in labelled if r["stratum"] == stratum]
        studied = sum(r["repo"].lower() in picks for r in rows)
        lines += [f"## Stratum: {stratum}", "",
                  f"stop: stopped at the scale checkpoint on {stop['date']}; {len(rows)} drawn rows labelled by the reference, "
                  f"{sum(r['user']['decision'] == 'eligible' for r in rows)} eligible, {studied} studied", "", "### Screened rows", "",
                  "| rank | repo | commit | scores | decision | mechanisms | reason |", "|---|---|---|---|---|---|---|"]
        for r in sorted(rows, key=lambda r: (r["batch"], r["order_rank"])):
            u = r["user"]
            scores = " ".join(f"{c[0]}{number(u[c])}" for c in (*QUALITY, "Relevance"))
            pick = picks.get(r["repo"].lower())
            if pick:
                decision, reason = "study", f"pass {pick['pass']}: adds {', '.join(pick['adds'])}"
            elif u["decision"] == "eligible":
                decision, reason = "eligible", f"reference-eligible; adds no problem held by fewer than {NEED} picks"
            else:
                decision, reason = u["decision"], f"reference label, frozen in reference-freeze-{r['batch']}.json"
            lines.append(f"| {r['order_rank']} | {r['repo']} | {r['commit']} | {scores} | {decision} | {', '.join(u['problems']) or '-'} | {reason} |")
        for e in (e for e in study["supplement"] if e["stratum"] == stratum):
            lines.append(f"| supplement | {e['repo']} | {e['commit']} | - | study | {', '.join(e['problems'])} | supplement, not reference-labelled: {e['reason']} |")
        lines.append("")
    lines += ["## Surfaces", ""] + [f"- considered: {k}: {', '.join(v)}" for k, v in surfaces["considered"].items()]
    lines += [f"- not relevant: {k}: {v}" for k, v in surfaces["not relevant"].items()] + ["", "## Threats", ""] + [f"- {t}" for t in stop["threats"]]
    text = "\n".join(lines) + "\n"
    return text, f"{topic['sweep']}: stopped at the scale checkpoint; {len(picks)} picks and {len(study['supplement'])} supplement sources studied"
