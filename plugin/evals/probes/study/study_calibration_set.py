import hashlib
import html
import json
import random
import re
from pathlib import Path

from study_agreement import HARD_CAP
from study_calibration import CALIBRATED_STRATA
from study_facets import facet_names
from study_screening_core import read_jsonl
from study_screening_input import fetch_inputs, inputs_file
from study_session import canonical_sha256
from study_session_prompt import date_cell, required_sweep_date
from study_topic import TopicError, screened_strata

SET_FILE, DRAW_FILE, LABELS_FILE, PAGE_FILE = "calibration-set.json", "calibration-draw.json", "calibration-labels.json", "calibration.html"
SET_SIZE, LIKELY_TOP = 60, 10
LABELLED = ("Authority", "Methodology", "Objectivity", "Position", "Relevance")
FIELDS = (*LABELLED, "decision")
EXCLUDE_CODES = {"irrelevant": "không liên quan", "below-threshold": "dưới ngưỡng", "copy": "bản sao của nguồn khác", "dead": "không đọc được: repository hoặc commit đã mất",
                 "aggregator": "danh sách tổng hợp"}
RATINGS = (1, 0.5, 0)


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


def facet_pool(order, facet):
    rows = [r for r in order if facet in r["facets"] and not r["facets"][facet]["forced"] and r["facets"][facet]["rank"] <= HARD_CAP]
    return sorted(rows, key=lambda r: r["facets"][facet]["rank"])


def take(topic, work, stratum, queue, picked, fetch, want):
    taken = []
    while queue and len(taken) < want:
        row = queue.pop()
        if row["order_rank"] in picked:
            continue
        fetch_inputs(topic, work, stratum, 0, fetch, ranks={row["order_rank"]})
        held = {r["order_rank"]: r for r in read_jsonl(Path(work), inputs_file(work, stratum).name)}[row["order_rank"]]
        if held.get("error_kind") == "transient":
            raise TopicError(f"{stratum} rank {row['order_rank']} ({row['repo']}) has a transient fetch error ({held['error']}); draw again, the seed picks the same rows")
        if held.get("error_kind") == "permanent":
            continue
        taken.append(row)
    return taken


def draw_stratum(topic, work, stratum, names, fetch):
    order = read_jsonl(Path(work), f"{stratum}-screening-order.jsonl")
    if not order or "facets" not in order[0]:
        raise TopicError(f"no merged {stratum}-screening-order.jsonl in {work}; run merge-facet-orders.py first")
    listed = Path(work) / f"{stratum}-qgs-candidates.jsonl"
    if not listed.is_file():
        raise TopicError(f"no {listed.name} in {work}; the likely positives are drawn from the QGS candidates, so extract them first")
    candidates = {r["repo"].lower() for r in read_jsonl(listed.parent, listed.name)}
    rng = random.Random(f"{topic['sweep']}:{stratum}")
    picked, drawn = {}, []
    for index, facet in enumerate(names):
        share = SET_SIZE // len(names) + (1 if index < SET_SIZE % len(names) else 0)
        pool = [r for r in facet_pool(order, facet) if r["order_rank"] not in picked]
        likely = [r for r in pool if r["repo"].lower() in candidates or r["facets"][facet]["rank"] <= LIKELY_TOP]
        others = [r for r in pool if r not in likely]
        random_ranks = {r["order_rank"] for r in others}
        rng.shuffle(likely)
        rng.shuffle(others)
        rows = take(topic, work, stratum, likely, picked, fetch, (share + 1) // 2)
        rows += take(topic, work, stratum, others, picked, fetch, share - len(rows))
        rows += take(topic, work, stratum, likely, picked, fetch, share - len(rows))
        if len(rows) < share:
            raise TopicError(f"{stratum} facet {facet}: only {len(rows)} readable rows in its top {HARD_CAP}, the set needs {share}")
        for row in rows:
            picked[row["order_rank"]] = row
            kind = "random" if row["order_rank"] in random_ranks else ("qgs candidate" if row["repo"].lower() in candidates else "top-ranked")
            drawn.append({"order_rank": row["order_rank"], "facet": facet, "class": kind, "facet_rank": row["facets"][facet]["rank"]})
    rng.shuffle(drawn)
    return [picked[d["order_rank"]] for d in drawn], drawn


def draw_set(topic, repo, work, criteria, fetch):
    names = facet_names(topic)
    work = Path(work)
    if (work / SET_FILE).exists():
        raise TopicError(f"{work / SET_FILE} already exists; the user's labels are tied to it, so it is never redrawn")
    criteria_path = Path(repo) / criteria
    if not criteria_path.is_file():
        raise TopicError(f"no criteria file at {criteria_path}")
    anchor = anchors(criteria_path.read_text())
    rows, provenance, shown = [], [], []
    for stratum in calibrated(topic):
        picked, drawn = draw_stratum(topic, work, stratum, names, fetch)
        inputs = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
        for number, (row, how) in enumerate(zip(picked, drawn), 1):
            key = f"{stratum}-{number}"
            held = inputs[row["order_rank"]]
            rows.append({"id": key, "stratum": stratum, "order_rank": row["order_rank"], "repo": row["repo"], "commit": f"https://github.com/{row['repo']}/commit/{held.get('sha')}",
                         "inputs_sha256": canonical_sha256(held), "facets": sorted(f for f in row["facets"] if f in names)})
            provenance.append({"id": key, **{k: how[k] for k in ("facet", "class", "facet_rank")}})
            shown.append((key, stratum, held))
    sample = {"sweep": topic["sweep"], "criteria": criteria, "criteria_sha256": hashlib.sha256(criteria_path.read_bytes()).hexdigest(), "size_per_stratum": SET_SIZE, "rows": rows}
    text = json.dumps(sample, indent=1, ensure_ascii=False) + "\n"
    return text, {"seed": f"{topic['sweep']}:<stratum>", "rows": provenance}, page(topic, hashlib.sha256(text.encode()).hexdigest(), shown, anchor)


def pre(value):
    return f"<pre>{html.escape(value if isinstance(value, str) else json.dumps(value, indent=1, ensure_ascii=False))}</pre>"


def row_section(index, total, key, stratum, held, anchor, when):
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
    parts.append("<details><summary>Danh sách thư mục gốc</summary>" + pre(", ".join(held.get("listing", []))) + "</details>")
    parts.append("<details open><summary>README</summary>" + pre(held.get("readme", "")) + "</details>")
    parts += [f"<details open><summary>{html.escape(f['path'])}</summary>" + pre("(tệp nhị phân, không hiển thị)" if f.get("binary") else f.get("text", "")) + "</details>"
              for f in held.get("files", [])]
    parts.append("<details open><summary>Bằng chứng các mốc chấm đọc</summary>" + pre(held.get("evidence", {})) + "</details>")
    parts.append("<fieldset><legend>Nhãn của dòng này</legend>")
    for criterion in LABELLED:
        options = "".join(f'<label><input type="radio" name="{html.escape(key)}|{criterion}" value="{v}"> <b>{v}</b> {html.escape(anchor[criterion][v])}</label>' for v in ("1", "0.5", "0"))
        parts.append(f'<div class="criterion"><h3>{criterion}</h3>{options}</div>')
    choices = [("eligible", "Đủ điều kiện")] + [(f"excluded: {code}", f"Loại: {code} ({text})") for code, text in EXCLUDE_CODES.items()]
    options = "".join(f'<label><input type="radio" name="{html.escape(key)}|decision" value="{html.escape(v)}"> {html.escape(t)}</label>' for v, t in choices)
    parts.append(f'<div class="criterion"><h3>Quyết định</h3>{options}</div></fieldset></section>')
    return "\n".join(parts)


STYLE = ("body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:0 16px 64px;color:#1c1c1c;background:#fafafa}"
         "header{position:sticky;top:0;background:#fafafa;border-bottom:1px solid #ccc;padding:8px 0;z-index:1}"
         "section.row{background:#fff;border:1px solid #ddd;border-radius:6px;margin:20px 0;padding:12px 16px}"
         "pre{white-space:pre-wrap;word-break:break-word;background:#f3f3f3;padding:8px;max-height:420px;overflow:auto;font-size:13px}"
         ".criterion{border-top:1px solid #eee;padding:6px 0}.criterion h3{margin:4px 0;font-size:15px}"
         ".criterion label{display:block;margin:3px 0 3px 8px}.warn{color:#8a4b00}.date{color:#444}button{font-size:15px;padding:4px 12px}")

SCRIPT = """(() => {
  const SET = document.body.dataset.set, SWEEP = document.body.dataset.sweep, KEY = "calibration:" + SET;
  const FIELDS = %s;
  const ids = Array.from(document.querySelectorAll("section.row")).map((s) => s.dataset.id);
  const status = document.getElementById("progress");
  let labels = {};
  try { labels = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (error) { status.textContent = "Không đọc được tiến độ đã lưu: " + error.message; }
  const done = () => ids.filter((id) => labels[id] && FIELDS.every((f) => labels[id][f] !== undefined)).length;
  const show = (extra) => { status.textContent = "Đã gán đủ nhãn " + done() + "/" + ids.length + " dòng" + (extra || ""); };
  const apply = () => {
    document.querySelectorAll("input[type=radio]").forEach((input) => {
      const [id, field] = input.name.split("|");
      input.checked = Boolean(labels[id]) && String(labels[id][field]) === input.value;
    });
    show();
  };
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(labels)); show(); } catch (error) { show(" (không lưu được vào trình duyệt: " + error.message + "; hãy tải nhãn về)"); }
  };
  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.type !== "radio") return;
    const [id, field] = input.name.split("|");
    labels[id] = labels[id] || {};
    labels[id][field] = field === "decision" ? input.value : Number(input.value);
    save();
  });
  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ sweep: SWEEP, set_sha256: SET, labels }, null, 1)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "calibration-labels-" + SWEEP + ".json";
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


def page(topic, set_sha, shown, anchor):
    when = required_sweep_date(topic)
    intro = (f"Bộ hiệu chuẩn có {len(shown)} dòng. Mỗi dòng là một repository kèm đúng dữ liệu đầu vào mà mọi giám khảo chấm. Trang không hiển thị câu trả lời của bất kỳ giám khảo "
             "hay phiên chấm nào, cũng không cho biết dòng được rút theo cách nào. Với mỗi dòng: đọc dữ liệu, chấm năm tiêu chí theo mô tả bên cạnh từng lựa chọn (1, 0.5 hoặc 0), rồi "
             "chọn Đủ điều kiện hoặc Loại kèm lý do. Date do công cụ tính sẵn nên chỉ hiển thị. Đủ điều kiện khi Relevance = 1 và Authority + Methodology + Objectivity + Date + "
             "Position + Novelty ≥ 4.5, với Novelty = 1 khi có cơ chế mới đối với bộ kit. Tiến độ tự lưu trong trình duyệt; bấm «Tải nhãn về (JSON)» để lưu file, rồi chạy "
             "import-calibration-labels.py với file đó.")
    sections = [row_section(i, len(shown), key, stratum, held, anchor, when) for i, (key, stratum, held) in enumerate(shown, 1)]
    return "\n".join(['<!DOCTYPE html>', '<html lang="vi">', "<head>", '<meta charset="utf-8">',
                      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">",
                      f"<title>Bộ hiệu chuẩn {html.escape(topic['sweep'])}</title>", f"<style>{STYLE}</style>", "</head>",
                      f'<body data-set="{set_sha}" data-sweep="{html.escape(topic["sweep"])}">',
                      f"<header><h1>Bộ hiệu chuẩn · {html.escape(topic['sweep'])}</h1><p>{html.escape(intro)}</p><p id=\"progress\"></p>",
                      '<button id="download" type="button">Tải nhãn về (JSON)</button> <label>Mở file nhãn đã lưu <input id="restore" type="file" accept="application/json"></label></header>',
                      "<main>", *sections, "</main>", f"<script>{SCRIPT % json.dumps(list(FIELDS))}</script>", "</body>", "</html>", ""])


def checked_label(key, label):
    if not isinstance(label, dict):
        raise TopicError(f"label {key}: must be an object of the five criteria and the decision")
    unknown = sorted(set(label) - set(FIELDS))
    if unknown:
        raise TopicError(f"label {key}: unknown fields {unknown}")
    bad = {c: label[c] for c in LABELLED if c in label and (isinstance(label[c], bool) or label[c] not in RATINGS)}
    if bad:
        raise TopicError(f"label {key}: {bad}; ratings are 1, 0.5 or 0")
    decision = label.get("decision")
    if "decision" in label and not (decision == "eligible" or (isinstance(decision, str) and decision.startswith("excluded: ") and decision[10:] in EXCLUDE_CODES)):
        raise TopicError(f"label {key}: decision {decision!r}; it is eligible or excluded: <code>, the code one of {', '.join(EXCLUDE_CODES)}")
    return {f: label[f] for f in FIELDS if f in label}


def import_labels(work, saved):
    work = Path(work)
    set_file = work / SET_FILE
    if not set_file.is_file():
        raise TopicError(f"no {SET_FILE} in {work}; draw it with draw-calibration-set.py")
    set_sha = hashlib.sha256(set_file.read_bytes()).hexdigest()
    sample = json.loads(set_file.read_text())
    if not isinstance(saved, dict) or saved.get("set_sha256") != set_sha or saved.get("sweep") != sample["sweep"]:
        raise TopicError(f"the labels file was saved for another calibration set (set sha256 {str((saved or {}).get('set_sha256'))[:16]}, this set {set_sha[:16]})")
    labels = saved.get("labels")
    if not isinstance(labels, dict):
        raise TopicError("the labels file holds no labels object")
    ids = {r["id"] for r in sample["rows"]}
    unknown = sorted(set(labels) - ids)
    if unknown:
        raise TopicError(f"the labels file names rows the set does not hold: {unknown[:10]}")
    kept = {key: checked_label(key, value) for key, value in labels.items()}
    rows = [{**{k: r[k] for k in ("id", "stratum", "order_rank", "repo", "inputs_sha256")}, "user": kept.get(r["id"])} for r in sample["rows"]]
    complete = sum(1 for r in rows if r["user"] and all(f in r["user"] for f in FIELDS))
    out = {"set_sha256": set_sha, "complete": complete, "rows": rows}
    (work / LABELS_FILE).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return complete, len(rows)
