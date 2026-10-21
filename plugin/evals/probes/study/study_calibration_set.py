import fnmatch
import hashlib
import html
import json
import re
from pathlib import Path

from study_calibration import CALIBRATED_STRATA
from study_qgs import candidates_file
from study_screening_core import read_jsonl
from study_screening_input import fetch_inputs, inputs_file
from study_session import canonical_sha256, qgs_shape
from study_session_prompt import date_cell, required_sweep_date
from study_stage1 import FREEZE_FILE, HELD_OUT, HELD_OUT_POSITIVES, POSITIVES_NEEDED, RUNG_FILE, examples_text, held_out_batches, inputs_name
from study_topic import TopicError, screened_strata

SET_SIZE, LIKELY_TOP, TOP_UP_MIN, TOP_UP_MAX = 60, 10, 30, 40
BATCHES = ("calibration", "top-up", "held-out")
LABELLED = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")
FIELDS = (*LABELLED, "problems", "decision")
EXCLUDE_CODES = {"irrelevant": "không liên quan", "below-threshold": "dưới ngưỡng", "copy": "bản sao của nguồn khác", "dead": "không đọc được: repository hoặc commit đã mất",
                 "aggregator": "danh sách tổng hợp"}
RATINGS = (1, 0.5, 0)
SET_FILE, DRAW_FILE, LABELS_FILE, PAGE_FILE = "calibration-set.json", "calibration-draw.json", "calibration-labels.json", "calibration.html"
HIGHLIGHT_PATTERNS = (".github", "codeowners", ".husky", ".pre-commit-config.yaml", ".claude", ".claude-plugin", "hooks", "hooks.json", "settings.json", "skills", "skill.md",
                      "agents.md", "claude.md", "*.schema.json", "schema", "schemas", ".eslintrc*", "eslint.config.*", "biome.json*", ".markdownlint*", "commitlint*",
                      ".commitlintrc*", "contributing*", "changelog*", "adr", "decisions", "migrations", "evals", "tests", "test", "renovate.json*", ".release*",
                      "release-please*")


def highlight_sha256():
    return hashlib.sha256(("\n".join(HIGHLIGHT_PATTERNS) + "\n").encode()).hexdigest()


def highlighted(name):
    return any(fnmatch.fnmatchcase(name.lower(), p) for p in HIGHLIGHT_PATTERNS)


def set_file(batch):
    return f"{batch}-set.json"


def labels_file(batch):
    return f"{batch}-labels.json"


def anchors(text):
    table = text.split("## GitHub assets", 1)[-1].split("\n## ", 1)[0]
    found = {}
    for criterion in LABELLED:
        row = re.search(r"^\| " + re.escape(criterion) + r" \| (.+?) \| (.+?) \| (.+?) \|$", table, re.M)
        if not row:
            raise TopicError(f"the criteria file has no {criterion} row with its three anchors under ## GitHub assets")
        found[criterion] = dict(zip(("1", "0.5", "0"), row.groups()))
    return found


def calibrated(topic):
    strata = [s for s in CALIBRATED_STRATA if s in screened_strata(topic)]
    if not strata:
        raise TopicError(f"topic {topic['name']} screens neither a config nor a product stratum")
    return strata


def facet_ranks(work, facet, stratum):
    path = Path(work) / "facets" / facet / f"{stratum}-ranked.json"
    if not path.is_file():
        raise TopicError(f"no {path}; rank every facet before the calibration draw, its best ranks enrich the set")
    return {r["repo"].lower(): r["order_rank"] for r in json.loads(path.read_text())["rows"]}


def fetched(topic, work, stratum, fetch, skipped):
    def readable(row):
        fetch_inputs(topic, work, stratum, 0, fetch, ranks={row["order_rank"]})
        held = {r["order_rank"]: r for r in read_jsonl(Path(work), inputs_file(work, stratum).name)}[row["order_rank"]]
        if held.get("error_kind") == "transient":
            raise TopicError(f"{stratum} rank {row['order_rank']} ({row['repo']}) has a transient fetch error ({held['error']}); draw again, the seed picks the same rows")
        if held.get("error_kind") == "permanent":
            skipped.append(row["order_rank"])
            return False
        return True
    return readable


def take(queue, picked, readable, want):
    taken = []
    while queue and len(taken) < want:
        row = queue.pop(0)
        if row["order_rank"] in picked or not readable(row):
            continue
        taken.append(row)
    return taken


def hash_key(seed, tag):
    return lambda row: hashlib.sha256(f"{seed}:{tag}:{row['order_rank']}".encode()).hexdigest()


def all_batches(work):
    return [b for b in BATCHES[:2] if (Path(work) / set_file(b)).is_file()] + held_out_batches(work)


def drawn_before(work, batch=None):
    batches = all_batches(work)
    earlier = batches[:batches.index(batch)] if batch in batches else batches
    return {(r["stratum"], r["order_rank"]) for b in earlier for r in json.loads((Path(work) / set_file(b)).read_text())["rows"]}


def example_repos(topic):
    return {str(e.get("repo", "")).lower() for e in topic.get("stage1_examples") or [] if isinstance(e, dict)}


def draw_stratum(topic, work, batch, stratum, size, enriched_only, readable):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order:
        raise TopicError(f"no {stratum}-screening-order.jsonl in {work}; export the whole pool first")
    seed = f"{topic['sweep']}:{batch}:{stratum}"
    candidates = {r["repo"].lower() for r in read_jsonl(Path(work), candidates_file(work).name)}
    taken_before = {rank for s, rank in drawn_before(work, batch) if s == stratum}
    examples = example_repos(topic)
    order = [r for r in order if r["repo"].lower() not in examples]
    names = list(topic["facets"])
    picked, drawn = {}, []
    for index, facet in enumerate(names):
        share = size // len(names) + (1 if index < size % len(names) else 0)
        ranks = facet_ranks(work, facet, stratum)
        pool = sorted((r for r in order if r["repo"].lower() in ranks and r["order_rank"] not in taken_before), key=lambda r: ranks[r["repo"].lower()])
        likely = sorted((r for r in pool if r["repo"].lower() in candidates or ranks[r["repo"].lower()] <= LIKELY_TOP), key=hash_key(seed, f"{facet}:likely"))
        others = [r for r in pool if r not in likely]
        random_ranks = set() if enriched_only else {r["order_rank"] for r in others}
        if not enriched_only:
            others.sort(key=hash_key(seed, f"{facet}:random"))
        rows = take(likely, picked, readable, share if enriched_only else (share + 1) // 2)
        rows += take(others, picked, readable, share - len(rows))
        rows += take(likely, picked, readable, share - len(rows))
        if len(rows) < share:
            raise TopicError(f"{stratum} facet {facet}: only {len(rows)} readable rows left to draw, the batch needs {share}")
        for row in rows:
            picked[row["order_rank"]] = row
            kind = "random" if row["order_rank"] in random_ranks else ("qgs candidate" if row["repo"].lower() in candidates else "top-ranked")
            drawn.append({"order_rank": row["order_rank"], "facet": facet, "class": kind, "facet_rank": ranks[row["repo"].lower()]})
    drawn.sort(key=hash_key(seed, "order"))
    return [picked[d["order_rank"]] for d in drawn], drawn


def redraw(topic, folder, batch):
    sample = json.loads((Path(folder) / set_file(batch)).read_text())
    skipped = json.loads((Path(folder) / f"{batch}-draw.json").read_text()).get("skipped") or {}
    rows, provenance = [], []
    for stratum, count in sample["rows_per_stratum"].items():
        unreadable = set(skipped.get(stratum) or [])
        picked, drawn = draw_stratum(topic, folder, batch, stratum, count, batch != "calibration", lambda row, gone=unreadable: row["order_rank"] not in gone)
        for number, (row, how) in enumerate(zip(picked, drawn), 1):
            key = f"{batch}-{stratum}-{number}"
            rows.append({"id": key, "stratum": stratum, "order_rank": row["order_rank"], "repo": row["repo"]})
            provenance.append({"id": key, **{k: how[k] for k in ("facet", "class", "facet_rank")}})
    return rows, provenance


def batch_sizes(topic, batch, sizes):
    strata = calibrated(topic)
    if batch == "calibration":
        return sizes == {s: SET_SIZE for s in strata}, f"the calibration set holds {SET_SIZE} per stratum"
    total = sum(sizes.values()) if isinstance(sizes, dict) else 0
    split = {s: total // len(strata) + (1 if i < total % len(strata) else 0) for i, s in enumerate(strata)}
    return TOP_UP_MIN <= total <= TOP_UP_MAX and sizes == split, f"a {batch} batch holds {TOP_UP_MIN} to {TOP_UP_MAX} rows split evenly over the strata"


def calibration_checks(topic, folder):
    folder = Path(folder)
    for batch in all_batches(folder):
        sample = json.loads((folder / set_file(batch)).read_text())
        set_sha = hashlib.sha256((folder / set_file(batch)).read_bytes()).hexdigest()
        if json.loads((folder / f"{batch}-draw.json").read_text()).get("set_sha256") != set_sha:
            raise TopicError(f"{batch}-draw.json was written for another {batch} set; the draw records the hash of the set it wrote")
        labelled(folder, (batch,))
        fits, rule = batch_sizes(topic, batch, sample["rows_per_stratum"])
        if not fits:
            raise TopicError(f"{set_file(batch)} holds {sample['rows_per_stratum']} rows per stratum; {rule}")
        leaked = sorted({r["repo"] for r in sample["rows"]} & example_repos(topic))
        if leaked:
            raise TopicError(f"{set_file(batch)} holds stage-1 worked-example repositories {leaked}")
        if HELD_OUT.match(batch) and sample.get("rung_sha256") != hashlib.sha256((folder / RUNG_FILE).read_bytes()).hexdigest():
            raise TopicError(f"{set_file(batch)} was not drawn after the current {RUNG_FILE}; a held-out batch is drawn once the rung is chosen")
        rows, provenance = redraw(topic, folder, batch)
        if [{k: r[k] for k in ("id", "stratum", "order_rank", "repo")} for r in sample["rows"]] != rows or \
                json.loads((folder / f"{batch}-draw.json").read_text())["rows"] != provenance:
            raise TopicError(f"{set_file(batch)} is not the set its seed, the pools and the recorded unreadable rows give; a batch is drawn once, by draw-calibration-set.py")
    if json.loads((folder / FREEZE_FILE).read_text()).get("examples_sha256") != hashlib.sha256(examples_text(topic).encode()).hexdigest():
        raise TopicError(f"{FREEZE_FILE} froze other worked examples than the topic config's stage1_examples hold now")
    trigger_checks(folder)


def labelled(folder, batches=("calibration",)):
    rows = []
    for batch in batches:
        path = Path(folder) / labels_file(batch)
        if not path.is_file():
            raise TopicError(f"no {path.name} in {folder}; the user labels the {batch} batch and import-calibration-labels.py keeps the labels")
        labels = json.loads(path.read_text())
        if labels.get("set_sha256") != hashlib.sha256((Path(folder) / set_file(batch)).read_bytes()).hexdigest():
            raise TopicError(f"{path.name} was imported for another {batch} set; import the labels again")
        freeze = Path(folder) / FREEZE_FILE
        if not freeze.is_file() or labels.get("stage1_freeze_sha256") != hashlib.sha256(freeze.read_bytes()).hexdigest():
            raise TopicError(f"{path.name} was not imported under the current {FREEZE_FILE}; the ladder is frozen before any label is read")
        bound = ("id", "stratum", "order_rank", "repo", "inputs_sha256", "qgs_sha256")
        drawn = json.loads((Path(folder) / set_file(batch)).read_text())["rows"]
        if [[r.get(k) for k in bound] for r in labels["rows"]] != [[r.get(k) for k in bound] for r in drawn]:
            raise TopicError(f"{path.name} does not hold exactly the rows of {set_file(batch)}; import the labels again for the drawn set")
        if labels["complete"] != len(labels["rows"]):
            raise TopicError(f"the user labelled {labels['complete']} of {len(labels['rows'])} {batch} rows; every row needs its label")
        for row in labels["rows"]:
            decision = (row.get("user") or {}).get("decision")
            if decision != "eligible" and not (isinstance(decision, str) and decision.startswith("excluded: ") and decision[len("excluded: "):] in EXCLUDE_CODES):
                raise TopicError(f"{path.name} row {row.get('id')} holds the decision {json.dumps(decision)}, not eligible or excluded: <code>")
        rows += [{**r, "batch": batch} for r in labels["rows"]]
    return rows


def batch_purpose(folder, batch):
    path = Path(folder) / set_file(batch)
    return json.loads(path.read_text()).get("purpose") if path.is_file() else None


def trigger_for(folder, earlier):
    folder = Path(folder)
    pooled = ("calibration",) + (("top-up",) if "top-up" in earlier and (folder / labels_file("top-up")).is_file() else ())
    positives = sum(r["user"]["decision"] == "eligible" for r in labelled(folder, pooled))
    trigger = {"positives": positives, "labels_sha256": {b: hashlib.sha256((folder / labels_file(b)).read_bytes()).hexdigest() for b in pooled}}
    if positives < POSITIVES_NEEDED:
        if "top-up" in earlier:
            raise TopicError(f"the set and its top-up batch hold {positives} positives pooled, still fewer than {POSITIVES_NEEDED}; stage 1 cannot be certified on them")
        return "top-up", f"fewer than {POSITIVES_NEEDED} positives pooled ({positives}): the rows join the pooled bound", trigger
    rung = json.loads((folder / RUNG_FILE).read_text())["rung"] if (folder / RUNG_FILE).is_file() else None
    if rung and rung > 1:
        held = [b for b in earlier if HELD_OUT.match(b)]
        trigger["rung"] = rung
        if not held:
            return "held-out", f"stage-1 rung {rung} was chosen above the first: the rows are held out to confirm it", trigger
        found = sum(r["user"]["decision"] == "eligible" for r in labelled(folder, held))
        if found >= HELD_OUT_POSITIVES:
            raise TopicError(f"the held-out batches hold {found} positives, at least {HELD_OUT_POSITIVES}; no further held-out batch is drawn")
        trigger["held_out_positives"] = found
        trigger["labels_sha256"].update({b: hashlib.sha256((folder / labels_file(b)).read_bytes()).hexdigest() for b in held})
        return f"held-out-{len(held) + 1}", (f"the held-out batches hold {found} positives, fewer than {HELD_OUT_POSITIVES}: more enriched rows are held out to confirm "
                                             f"stage-1 rung {rung}"), trigger
    raise TopicError(f"no top-up trigger fired: the labels hold {positives} positives pooled (at least {POSITIVES_NEEDED}) and "
                     + ("rung 1 was chosen" if rung == 1 else "no stage-1 rung is chosen yet"))


def top_up_trigger(folder):
    return trigger_for(folder, all_batches(folder))[:2]


def trigger_checks(folder):
    batches = all_batches(folder)
    for position, batch in enumerate(batches[1:], 1):
        sample = json.loads((Path(folder) / set_file(batch)).read_text())
        try:
            expected = trigger_for(folder, batches[:position])
        except TopicError as error:
            raise TopicError(f"{set_file(batch)} was drawn when no trigger held: {error}") from error
        if (batch, sample.get("purpose"), sample.get("trigger")) != expected:
            raise TopicError(f"{set_file(batch)} records another trigger than the labelled batches before it give ({expected[0]}: {expected[1]}); a later batch is drawn only "
                             f"while fewer than {POSITIVES_NEEDED} positives are pooled or a rung above the first is chosen, and its labels stay as they were at the draw")


def draw_batch(topic, repo, work, criteria, fetch, top_up=None, today=None):
    work = Path(work)
    if top_up is None:
        if today is None or required_sweep_date(topic).isoformat() != today:
            raise TopicError(f"the sweep {topic['sweep']} is not named for the draw date {today}; name the v4 sweep <yymmdd>-<topic> at the calibration draw, "
                             "so no earlier work folder is mistaken for it")
        batch, purpose, size, trigger = "calibration", "the calibration set", {s: SET_SIZE for s in calibrated(topic)}, None
    else:
        if not TOP_UP_MIN <= top_up <= TOP_UP_MAX:
            raise TopicError(f"a top-up batch holds {TOP_UP_MIN} to {TOP_UP_MAX} rows, not {top_up}")
        batch, purpose, trigger = trigger_for(work, all_batches(work))
        strata = calibrated(topic)
        size = {s: top_up // len(strata) + (1 if i < top_up % len(strata) else 0) for i, s in enumerate(strata)}
    if (work / set_file(batch)).exists():
        raise TopicError(f"{work / set_file(batch)} already exists; the user's labels are tied to it, so it is never redrawn")
    criteria_path = Path(repo) / criteria
    if not criteria_path.is_file():
        raise TopicError(f"no criteria file at {criteria_path}")
    anchor = anchors(criteria_path.read_text())
    rows, provenance, shown, skipped = [], [], [], {}
    for stratum, count in size.items():
        if not (work / inputs_name(stratum, "brief")).is_file():
            raise TopicError(f"no {inputs_name(stratum, 'brief')} in {work}; the calibration set is drawn after the stage-1 inputs exist")
        skipped[stratum] = []
        picked, drawn = draw_stratum(topic, work, batch, stratum, count, top_up is not None, fetched(topic, work, stratum, fetch, skipped[stratum]))
        inputs = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
        for number, (row, how) in enumerate(zip(picked, drawn), 1):
            key = f"{batch}-{stratum}-{number}"
            held = inputs[row["order_rank"]]
            rows.append({"id": key, "stratum": stratum, "order_rank": row["order_rank"], "repo": row["repo"], "commit": f"https://github.com/{row['repo']}/commit/{held.get('sha')}",
                         "inputs_sha256": canonical_sha256(held), "qgs_sha256": canonical_sha256(qgs_shape(held))})
            provenance.append({"id": key, **{k: how[k] for k in ("facet", "class", "facet_rank")}})
            shown.append((key, stratum, held))
    sample = {"sweep": topic["sweep"], "batch": batch, "purpose": purpose, "drawn": today, "criteria": criteria, "criteria_sha256": hashlib.sha256(criteria_path.read_bytes()).hexdigest(),
              "rows_per_stratum": size, "rows": rows}
    if HELD_OUT.match(batch):
        sample["rung_sha256"] = hashlib.sha256((work / RUNG_FILE).read_bytes()).hexdigest()
    if trigger:
        sample["trigger"] = trigger
    text = json.dumps(sample, indent=1, ensure_ascii=False) + "\n"
    set_sha = hashlib.sha256(text.encode()).hexdigest()
    draw = {"seed": f"{topic['sweep']}:{batch}:<stratum>", "set_sha256": set_sha, "skipped": {s: sorted(r) for s, r in skipped.items()}, "rows": provenance}
    return batch, text, draw, page(topic, batch, set_sha, shown, anchor)


def pre(value):
    return f"<pre>{html.escape(value if isinstance(value, str) else json.dumps(value, indent=1, ensure_ascii=False))}</pre>"


def row_section(index, total, key, stratum, held, anchor, when, problems):
    date = date_cell((held.get("facts") or {}).get("pushed"), when)
    parts = [f'<section class="row" id="{html.escape(key)}" data-id="{html.escape(key)}">',
             f"<h2>{index}/{total} · {html.escape(stratum)} · {html.escape(held['repo'])}</h2>",
             f"<p>commit {html.escape(str(held.get('sha', '-')))}</p>",
             f"<p class=\"date\">Date do công cụ tính sẵn, không chấm: {date['v']:g} ({html.escape(date['why'])})</p>",
             "<details open><summary>Dữ kiện từ khâu tìm kiếm</summary>" + pre(held.get("facts", {})) + "</details>"]
    if held.get("error"):
        parts.append(f"<p class=\"warn\">Không đọc được: {html.escape(held['error'])}</p>")
    if held.get("missing"):
        parts.append("<p class=\"warn\">Thiếu ở commit đã ghim (coi như không có): " + html.escape("; ".join(held["missing"])) + "</p>")
    names = held.get("listing", [])
    hits = [highlighted(n) for n in names]
    entries = ", ".join(f'<span class="hit">{html.escape(n)}</span>' if hit else html.escape(n) for n, hit in zip(names, hits))
    parts.append(f"<details{' open' if any(hits) else ''}><summary>Danh sách thư mục gốc</summary><pre>{entries}</pre></details>")
    parts.append("<details open><summary>README</summary>" + pre(held.get("readme", "")) + "</details>")
    parts += [f"<details open><summary>{html.escape(f['path'])}</summary>" + pre("(tệp nhị phân, không hiển thị)" if f.get("binary") else f.get("text", "")) + "</details>"
              for f in held.get("files", [])]
    parts.append("<details open><summary>Bằng chứng các mốc chấm đọc</summary>" + pre(held.get("evidence", {})) + "</details>")
    parts.append("<fieldset><legend>Nhãn của dòng này</legend>")
    for criterion in LABELLED:
        options = "".join(f'<label><input type="radio" name="{html.escape(key)}|{criterion}" value="{v}"> <b>{v}</b> {html.escape(anchor[criterion][v])}</label>' for v in ("1", "0.5", "0"))
        parts.append(f'<div class="criterion"><h3>{criterion}</h3>{options}</div>')
    boxes = "".join(f'<label class="inline"><input type="checkbox" name="{html.escape(key)}|problems" value="{html.escape(p)}"> {html.escape(p)}</label>' for p in problems)
    parts.append(f'<div class="criterion"><h3>Vấn đề (mã trong danh mục)</h3>{boxes}</div>')
    choices = [("eligible", "Đủ điều kiện")] + [(f"excluded: {code}", f"Loại: {code} ({text})") for code, text in EXCLUDE_CODES.items()]
    options = "".join(f'<label><input type="radio" name="{html.escape(key)}|decision" value="{html.escape(v)}"> {html.escape(t)}</label>' for v, t in choices)
    parts.append(f'<div class="criterion"><h3>Quyết định</h3>{options}</div></fieldset></section>')
    return "\n".join(parts)


STYLE = ("body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:0 16px 64px;color:#1c1c1c;background:#fafafa}"
         "header{position:sticky;top:0;background:#fafafa;border-bottom:1px solid #ccc;padding:8px 0;z-index:1}"
         "section.row{background:#fff;border:1px solid #ddd;border-radius:6px;margin:20px 0;padding:12px 16px}"
         "pre{white-space:pre-wrap;word-break:break-word;background:#f3f3f3;padding:8px;max-height:420px;overflow:auto;font-size:13px}"
         ".criterion{border-top:1px solid #eee;padding:6px 0}.criterion h3{margin:4px 0;font-size:15px}"
         ".criterion label{display:block;margin:3px 0 3px 8px}.criterion label.inline{display:inline-block;margin-right:12px}"
         ".warn{color:#8a4b00}.date{color:#444}button{font-size:15px;padding:4px 12px}.hit{background:#ffe08a;font-weight:600}")

SCRIPT = """(() => {
  const SET = document.body.dataset.set, SWEEP = document.body.dataset.sweep, BATCH = document.body.dataset.batch, KEY = "calibration:" + SET;
  const FIELDS = %s;
  const ids = Array.from(document.querySelectorAll("section.row")).map((s) => s.dataset.id);
  const status = document.getElementById("progress");
  let labels = {};
  try { labels = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (error) { status.textContent = "Không đọc được tiến độ đã lưu: " + error.message; }
  const valid = (label) => !(label.decision === "eligible" && label.Relevance !== 1) && !(label.Relevance === 1 && Array.isArray(label.problems) && !label.problems.length);
  const complete = (label) => Boolean(label) && valid(label) && FIELDS.every((f) => f === "problems" ? label.problems !== undefined || label.Relevance === 0 : label[f] !== undefined);
  const show = (extra) => {
    const broken = ids.filter((id) => labels[id] && !valid(labels[id]));
    status.textContent = "Đã gán đủ nhãn " + ids.filter((id) => complete(labels[id])).length + "/" + ids.length + " dòng"
      + (broken.length ? "; " + broken.length + " dòng trái quy tắc (Đủ điều kiện cần Relevance = 1; Relevance = 1 cần ít nhất một mã vấn đề): " + broken.join(", ") : "") + (extra || "");
  };
  const apply = () => {
    document.querySelectorAll("input").forEach((input) => {
      const [id, field] = input.name.split("|");
      if (!field) return;
      const label = labels[id];
      input.checked = input.type === "checkbox" ? Boolean(label && (label.problems || []).includes(input.value)) : Boolean(label) && String(label[field]) === input.value;
    });
    show();
  };
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(labels)); show(); } catch (error) { show(" (không lưu được vào trình duyệt: " + error.message + "; hãy tải nhãn về)"); }
  };
  document.addEventListener("change", (event) => {
    const input = event.target;
    const [id, field] = (input.name || "").split("|");
    if (!field) return;
    labels[id] = labels[id] || {};
    if (input.type === "checkbox") {
      labels[id].problems = Array.from(document.querySelectorAll("input[type=checkbox]")).filter((box) => box.name === input.name && box.checked).map((box) => box.value);
    } else {
      labels[id][field] = field === "decision" ? input.value : Number(input.value);
    }
    save();
  });
  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ sweep: SWEEP, batch: BATCH, set_sha256: SET, labels }, null, 1)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = BATCH + "-labels-" + SWEEP + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  document.getElementById("restore").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const saved = JSON.parse(reader.result);
        if (saved.set_sha256 !== SET) { show(" (file này thuộc một bộ hiệu chuẩn khác, không nạp)"); return; }
        labels = saved.labels || {};
        save();
        apply();
      } catch (error) { show(" (file không phải JSON hợp lệ: " + error.message + ")"); }
    };
    reader.onerror = () => show(" (không đọc được file: " + reader.error + ")");
    reader.readAsText(file);
  });
  apply();
})();"""

TITLES = {"calibration": "Bộ hiệu chuẩn", "top-up": "Lô bổ sung", "held-out": "Lô kiểm chứng giữ riêng"}


def eligibility_block(eligibility):
    def paragraphs(text):
        return "".join(f"<p>{html.escape(line)}</p>" for line in text.splitlines() if line.strip())
    return "\n".join(['<aside id="eligibility" style="background:#fff8e6;border:2px solid #8a4b00;border-radius:6px;margin:20px 0;padding:8px 16px">',
                      "<h2>Định nghĩa đủ điều kiện của giám khảo stage-1: câu hỏi mọi giám khảo stage-1 trả lời cho từng repository</h2>",
                      paragraphs(eligibility["vi"]), f'<div lang="en"><h3>Bản gốc tiếng Anh trong packet stage-1</h3>{paragraphs(eligibility["en"])}</div>', "</aside>"])


def page(topic, batch, set_sha, shown, anchor):
    when = required_sweep_date(topic)
    batch = "held-out" if HELD_OUT.match(batch) else batch
    intro = (f"{TITLES[batch]} có {len(shown)} dòng. Mỗi dòng là một repository kèm đúng dữ liệu đầu vào mà mọi giám khảo chấm. Trang không hiển thị câu trả lời của bất kỳ giám khảo "
             "hay phiên chấm nào, cũng không cho biết dòng được rút theo cách nào. Với mỗi dòng: đọc dữ liệu, chấm năm tiêu chí theo mô tả bên cạnh từng lựa chọn (1, 0.5 hoặc 0), đánh "
             "dấu các mã vấn đề mà repository có cơ chế xử lý, rồi chọn Đủ điều kiện hoặc Loại kèm lý do. Date do công cụ tính sẵn nên chỉ hiển thị. Đủ điều kiện khi Relevance = 1 "
             "và Authority + Methodology + Objectivity + Date + Position + Novelty ≥ 4.5, với Novelty = 1 khi dòng có ít nhất một cơ chế: khi hiệu chuẩn, mọi cơ chế đều được tính "
             "là mới, như cách chấm giám khảo. Tiến độ tự lưu trong trình duyệt; bấm «Tải nhãn về (JSON)» để lưu file, rồi chạy import-calibration-labels.py với file đó.")
    sha = highlight_sha256()
    note = (f"Tô sáng theo một danh sách mẫu đường dẫn cố định (không dùng AI), sha256 {sha}; tô sáng không phải là kết luận, và không có tô sáng không có nghĩa là không có cơ chế. "
            f"Highlighted by a fixed path pattern list (no AI), sha256 {sha}; a highlight is not a verdict, and missing highlights do not mean no mechanism.")
    problems = topic.get("problems") or []
    sections = [row_section(i, len(shown), key, stratum, held, anchor, when, problems) for i, (key, stratum, held) in enumerate(shown, 1)]
    eligibility = [eligibility_block(topic["eligibility"])] if "eligibility" in topic else []
    return "\n".join(['<!DOCTYPE html>', '<html lang="vi">', "<head>", '<meta charset="utf-8">',
                      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">",
                      f"<title>{TITLES[batch]} {html.escape(topic['sweep'])}</title>", f"<style>{STYLE}</style>", "</head>",
                      f'<body data-set="{set_sha}" data-sweep="{html.escape(topic["sweep"])}" data-batch="{batch}">',
                      f"<header><h1>{TITLES[batch]} · {html.escape(topic['sweep'])}</h1><p>{html.escape(note)}</p><p>{html.escape(intro)}</p>"
                      "<p id=\"progress\"></p>",
                      '<button id="download" type="button">Tải nhãn về (JSON)</button> <label>Mở file nhãn đã lưu <input id="restore" type="file" accept="application/json"></label></header>',
                      *eligibility, "<main>", *sections, "</main>", f"<script>{SCRIPT % json.dumps(list(FIELDS))}</script>", "</body>", "</html>", ""])


def checked_label(key, label, problems):
    if not isinstance(label, dict):
        raise TopicError(f"label {key}: must be an object of the five criteria, the problem ids and the decision")
    unknown = sorted(set(label) - set(FIELDS))
    if unknown:
        raise TopicError(f"label {key}: unknown fields {unknown}")
    bad = {c: label[c] for c in LABELLED if c in label and (isinstance(label[c], bool) or label[c] not in RATINGS)}
    if bad:
        raise TopicError(f"label {key}: {bad}; ratings are 1, 0.5 or 0")
    decision = label.get("decision")
    if "decision" in label and not (decision == "eligible" or (isinstance(decision, str) and decision.startswith("excluded: ") and decision[10:] in EXCLUDE_CODES)):
        raise TopicError(f"label {key}: decision {decision!r}; it is eligible or excluded: <code>, the code one of {', '.join(EXCLUDE_CODES)}")
    ids = label.get("problems", [])
    if not isinstance(ids, list) or not set(ids) <= set(problems):
        raise TopicError(f"label {key}: problems {ids!r} are not a list of the topic's problem ids")
    if decision == "eligible" and label.get("Relevance", 1) != 1:
        raise TopicError(f"label {key}: eligible needs Relevance 1, the label gives {label['Relevance']}")
    if label.get("Relevance") == 1 and "problems" in label and not ids:
        raise TopicError(f"label {key}: Relevance 1 names the problem it carries a mechanism for; tick at least one problem id")
    kept = {f: label[f] for f in FIELDS if f in label}
    if "problems" not in kept and label.get("Relevance") == 0:
        kept["problems"] = []
    return kept


def import_labels(topic, work, saved, batch="calibration"):
    work = Path(work)
    if batch not in BATCHES[:2] and not HELD_OUT.match(batch):
        raise TopicError(f"batch {batch!r} is not calibration, top-up or a held-out batch")
    if not (work / FREEZE_FILE).is_file():
        raise TopicError(f"no {FREEZE_FILE} in {work}; freeze the stage-1 ladder with freeze-stage1.py before any calibration label is read")
    path = work / set_file(batch)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; draw it with draw-calibration-set.py")
    set_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    sample = json.loads(path.read_text())
    if not isinstance(saved, dict) or saved.get("set_sha256") != set_sha or saved.get("sweep") != sample["sweep"]:
        raise TopicError(f"the labels file was saved for another calibration set (set sha256 {str((saved or {}).get('set_sha256'))[:16]}, this set {set_sha[:16]})")
    labels = saved.get("labels")
    if not isinstance(labels, dict):
        raise TopicError("the labels file holds no labels object")
    unknown = sorted(set(labels) - {r["id"] for r in sample["rows"]})
    if unknown:
        raise TopicError(f"the labels file names rows the set does not hold: {unknown[:10]}")
    kept = {key: checked_label(key, value, topic.get("problems") or []) for key, value in labels.items()}
    rows = [{**{k: r[k] for k in ("id", "stratum", "order_rank", "repo", "inputs_sha256", "qgs_sha256")}, "user": kept.get(r["id"])} for r in sample["rows"]]
    complete = sum(1 for r in rows if r["user"] and all(f in r["user"] for f in FIELDS))
    out = {"batch": batch, "set_sha256": set_sha, "stage1_freeze_sha256": hashlib.sha256((work / FREEZE_FILE).read_bytes()).hexdigest(), "complete": complete, "rows": rows}
    (work / labels_file(batch)).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return complete, len(rows)
