import hashlib
import html
import json
from pathlib import Path

from study_agreement import clopper_pearson, upper_bound
from study_calibration_set import STYLE, anchors, labels_file, pre, set_file
from study_reference_labels import cites_file, packet_rows
from study_reference_packet import problem_lines
from study_screening_input import read_file
from study_topic import TopicError

BATCH, CHECK_FILE, PAGE_FILE, CORRECTION_DIR = "calibration", "citation-check.json", "citation-check.html", "calibration-correction-1"
GROUPS = (("relevance-1", 1, 10), ("relevance-0", 0, 5))
UNSUPPORTED = {"relevance-1": "no", "relevance-0": "yes"}
STOP_AT, HEAD_LINES, HEAD_BYTES = 2, 40, 6000
CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">"


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def drawn(sweep, rows, salt="verify"):
    def key(row):
        return hashlib.sha256(f"{sweep}:{salt}:{row['id']}".encode()).hexdigest()
    picked = []
    for stratum in sorted({r["stratum"] for r in rows}):
        for kind, value, count in GROUPS:
            pool = sorted((r for r in rows if r["stratum"] == stratum and (r.get("user") or {}).get("Relevance") == value), key=key)
            picked += [{"id": r["id"], "stratum": stratum, "order_rank": r["order_rank"], "kind": kind} for r in pool[:count]]
    return picked


def check_rows(topic, work):
    work = Path(work)
    freeze = json.loads((work / f"reference-freeze-{BATCH}.json").read_text())
    salt = "verify-2" if freeze.get("correction") == 1 else "verify"
    return drawn(topic["sweep"], json.loads((work / labels_file(BATCH)).read_text())["rows"], salt)


def open_correction(work):
    work = Path(work)
    path, archive = work / CHECK_FILE, work / CORRECTION_DIR
    if archive.exists():
        raise TopicError(f"{CORRECTION_DIR} exists; a batch gets one correction round, and a second stop ends the method")
    if not path.is_file():
        raise TopicError(f"no {CHECK_FILE} in {work}; a correction round follows a citation check that stopped the method")
    check = json.loads(path.read_text())
    rows = check.get("rows") if isinstance(check.get("rows"), list) else []
    if check.get("stopped") is not True or sum(bool(r.get("unsupported")) for r in rows) < STOP_AT:
        raise TopicError(f"{CHECK_FILE} did not stop the method; a correction round follows a stopped check only")
    moved = [work / f"reference-freeze-{BATCH}.json", path, *sorted(work.glob("citation-check-votes-*.json"))]
    archive.mkdir()
    for source in moved:
        source.rename(archive / source.name)
    return [p.name for p in moved]


def head(text):
    return "".join(text.splitlines(keepends=True)[:HEAD_LINES])


def file_head(fetch, packet, path):
    for part in ("assets", "tests", "manifests"):
        for shown in packet.get(part) or []:
            if shown.get("path") == path:
                return head(shown.get("text") or "")
    entry = read_file(fetch, packet["repo"], packet["sha"], path, HEAD_BYTES)
    if entry.get("error"):
        return f"(không đọc được ở commit đã ghim: {entry['error']})"
    if entry.get("binary"):
        return "(tệp nhị phân, không hiển thị)"
    return head(entry["text"])


def statements(repo, topic):
    return dict(line[2:].split(": ", 1) for line in problem_lines(repo, topic))


def radios(key):
    return "".join(f'<label><input type="radio" name="{html.escape(key)}|answer" value="{v}"> {t}</label>' for v, t in (("yes", "Có"), ("no", "Không")))


def row_section(index, total, row, packet, mechanisms, anchor, problems, fetch):
    key = row["id"]
    parts = [f'<section class="row" id="{html.escape(key)}" data-id="{html.escape(key)}" data-kind="{row["kind"]}">',
             f"<h2>{index}/{total} · {html.escape(row['stratum'])} · {html.escape(packet['repo'])}</h2>", f"<p>commit {html.escape(str(packet.get('sha', '-')))}</p>"]
    if row["kind"] == "relevance-1":
        parts.append(f'<p class="anchor">Nhãn đang kiểm: Relevance = 1. Mốc trong tiêu chí: {html.escape(anchor["1"])}</p>')
        parts += [f"<details open><summary>{html.escape(m['path'])} · {html.escape(m['problem'])}: {html.escape(problems.get(m['problem'], ''))}</summary>"
                  + pre(file_head(fetch, packet, m["path"])) + "</details>" for m in mechanisms]
        question = "Tệp được dẫn (40 dòng đầu ở commit đã ghim) có mang cơ chế cho vấn đề ghi bên cạnh không?"
    else:
        parts.append(f'<p class="anchor">Nhãn đang kiểm: Relevance = 0. Mốc trong tiêu chí: {html.escape(anchor["0"])}</p>')
        parts.append("<details open><summary>Các vấn đề của chủ đề</summary>" + pre("\n".join(f"{p}: {s}" for p, s in problems.items())) + "</details>")
        assets = [a["path"] for a in packet.get("assets") or []]
        parts += [f"<details open><summary>{html.escape(path)}</summary>" + pre(file_head(fetch, packet, path)) + "</details>" for path in assets]
        if not assets:
            parts.append("<p class=\"warn\">Dữ liệu đầu vào không có tệp agent-asset nào.</p>")
        question = "Có tệp nào trong số này mang cơ chế cho một vấn đề được liệt kê không?"
    parts.append(f'<fieldset><legend>{question}</legend><div class="criterion">{radios(key)}</div></fieldset></section>')
    return "\n".join(parts)


SCRIPT = """(() => {
  const FREEZE = document.body.dataset.freeze, SET = document.body.dataset.set, SWEEP = document.body.dataset.sweep, KEY = "citation-check:" + FREEZE;
  const ids = Array.from(document.querySelectorAll("section.row")).map((s) => s.dataset.id);
  const status = document.getElementById("progress");
  let answers = {};
  try { answers = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (error) { status.textContent = "Không đọc được tiến độ đã lưu: " + error.message; }
  const show = (extra) => { status.textContent = "Đã trả lời " + ids.filter((id) => answers[id]).length + "/" + ids.length + " dòng" + (extra || ""); };
  const apply = () => {
    document.querySelectorAll("input[type=radio]").forEach((input) => { input.checked = answers[input.name.split("|")[0]] === input.value; });
    show();
  };
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(answers)); show(); } catch (error) { show(" (không lưu được vào trình duyệt: " + error.message + "; hãy tải câu trả lời về)"); }
  };
  document.addEventListener("change", (event) => {
    const [id, field] = (event.target.name || "").split("|");
    if (field !== "answer") return;
    answers[id] = event.target.value;
    save();
  });
  document.getElementById("download").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ sweep: SWEEP, set_sha256: SET, freeze_sha256: FREEZE, answers }, null, 1)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "citation-check-" + SWEEP + ".json";
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
        if (saved.freeze_sha256 !== FREEZE) { show(" (file này thuộc một lần khoá nhãn khác, không nạp)"); return; }
        answers = saved.answers || {};
        save();
        apply();
      } catch (error) { show(" (file không phải JSON hợp lệ: " + error.message + ")"); }
    };
    reader.onerror = () => show(" (không đọc được file: " + reader.error + ")");
    reader.readAsText(file);
  });
  apply();
})();"""


def page(topic, repo, work, freeze_sha, fetch):
    work = Path(work)
    freeze = json.loads((work / f"reference-freeze-{BATCH}.json").read_text())
    if sha256_file(work / cites_file(BATCH)) != freeze.get("cites_sha256"):
        raise TopicError(f"{cites_file(BATCH)} differs from the one reference-freeze-{BATCH}.json froze; the check reads the frozen citations")
    sample = json.loads((work / set_file(BATCH)).read_text())
    rows = check_rows(topic, work)
    cited = {r["id"]: r.get("mechanisms") or [] for r in json.loads((work / cites_file(BATCH)).read_text())["rows"]}
    packets = {s: packet_rows(work, s) for s in sample["rows_per_stratum"]}
    lacking = [r["id"] for r in rows if r["order_rank"] not in packets[r["stratum"]]]
    if lacking:
        raise TopicError(f"rows {lacking[:5]} have no reference-inputs row; the check shows the files the reference read")
    anchor, problems = anchors((Path(repo) / sample["criteria"]).read_text())["Relevance"], statements(repo, topic)
    sections = [row_section(i, len(rows), r, packets[r["stratum"]][r["order_rank"]], cited.get(r["id"], []), anchor, problems, fetch) for i, r in enumerate(rows, 1)]
    intro = (f"Kiểm tra trích dẫn: {len(rows)} dòng rút theo seed từ nhãn hiệu chuẩn đã khoá, mỗi tầng 10 dòng Relevance = 1 và 5 dòng Relevance = 0. Mỗi dòng có đúng một câu "
             "hỏi có/không. Dòng Relevance = 1 hiện đường dẫn reference đã dẫn, 40 dòng đầu của tệp và phát biểu vấn đề; trả lời Không nghĩa là trích dẫn không đỡ được nhãn. "
             "Dòng Relevance = 0 là phép dò âm tính giả: hiện các tệp agent-asset và danh sách vấn đề; trả lời Có nghĩa là nhãn không được đỡ. Trang không hiển thị câu trả "
             "lời của bất kỳ giám khảo hay phiên chấm nào, cũng không hiển thị lý do của reference. Từ 2 dòng không được đỡ trở lên thì phương pháp dừng. Tiến độ tự lưu "
             "trong trình duyệt; bấm «Tải câu trả lời về (JSON)» để lưu file, rồi chạy import-citation-check.py với file đó.")
    title = f"Kiểm tra trích dẫn {html.escape(topic['sweep'])}"
    set_sha = sha256_file(work / set_file(BATCH))
    return "\n".join(['<!DOCTYPE html>', '<html lang="vi">', "<head>", '<meta charset="utf-8">', CSP, f"<title>{title}</title>", f"<style>{STYLE}</style>", "</head>",
                      f'<body data-freeze="{freeze_sha}" data-set="{set_sha}" data-sweep="{html.escape(topic["sweep"])}">',
                      f"<header><h1>{title}</h1><p>{html.escape(intro)}</p><p id=\"progress\"></p>",
                      '<button id="download" type="button">Tải câu trả lời về (JSON)</button> <label>Mở file câu trả lời đã lưu <input id="restore" type="file" '
                      'accept="application/json"></label></header>', "<main>", *sections, "</main>", f"<script>{SCRIPT}</script>", "</body>", "</html>", ""]), len(rows)


def summary(freeze_sha, rows):
    k, n = sum(r["unsupported"] for r in rows), len(rows)
    return {"freeze_sha256": freeze_sha, "rows": rows, "n": n, "unsupported": k, "upper_one_sided": upper_bound(k, n), "interval_two_sided": list(clopper_pearson(k, n)),
            "stopped": k >= STOP_AT}


def write_check(work, out):
    path = Path(work) / CHECK_FILE
    if path.exists():
        raise TopicError(f"{CHECK_FILE} already exists; the check is made once on its freeze")
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def import_check(topic, work, saved, freeze_sha):
    work = Path(work)
    if (work / CHECK_FILE).exists():
        raise TopicError(f"{CHECK_FILE} already exists; the check is made once on its freeze")
    set_sha = sha256_file(work / set_file(BATCH))
    if not isinstance(saved, dict) or (saved.get("sweep"), saved.get("set_sha256"), saved.get("freeze_sha256")) != (topic["sweep"], set_sha, freeze_sha):
        raise TopicError(f"the answers file was saved for another freeze (freeze sha256 {str((saved or {}).get('freeze_sha256'))[:16]}, set "
                         f"{str((saved or {}).get('set_sha256'))[:16]}); this freeze is {freeze_sha[:16]}, its set {set_sha[:16]}")
    answers = saved.get("answers")
    rows = check_rows(topic, work)
    if not isinstance(answers, dict) or set(answers) != {r["id"] for r in rows}:
        given = set(answers) if isinstance(answers, dict) else set()
        raise TopicError(f"the answers file answers rows other than the {len(rows)} the seed draws: missing {sorted({r['id'] for r in rows} - given)[:5]}, "
                         f"extra {sorted(given - {r['id'] for r in rows})[:5]}")
    bad = [k for k, v in answers.items() if v not in ("yes", "no")]
    if bad:
        raise TopicError(f"{bad[0]}: answer {answers[bad[0]]!r}; every answer is yes or no")
    return write_check(work, summary(freeze_sha, [{"id": r["id"], "kind": r["kind"], "answer": answers[r["id"]], "unsupported": answers[r["id"]] == UNSUPPORTED[r["kind"]]}
                                                  for r in rows]))


def check_holds(topic, work, freeze_sha):
    work, path = Path(work), Path(work) / CHECK_FILE
    if not path.is_file():
        raise TopicError(f"no {CHECK_FILE} in {work}; the user checks 30 reference citations of the frozen {BATCH} labels (draw-citation-check.py, then "
                         "import-citation-check.py) before any calibration run")
    check = json.loads(path.read_text())
    if not isinstance(check, dict) or check.get("freeze_sha256") != freeze_sha:
        raise TopicError(f"{CHECK_FILE} was made on another freeze than reference-freeze-{BATCH}.json")
    rows = check.get("rows") if isinstance(check.get("rows"), list) else []
    expected = [(r["id"], r["kind"]) for r in check_rows(topic, work)]
    if any(not isinstance(r, dict) or r.get("answer") not in ("yes", "no") for r in rows) or [(r.get("id"), r.get("kind")) for r in rows] != expected:
        raise TopicError(f"{CHECK_FILE} does not answer exactly the rows the seed draws from the frozen labels")
    k = sum(r["answer"] == UNSUPPORTED[r["kind"]] for r in rows)
    if k >= STOP_AT:
        raise TopicError(f"{CHECK_FILE} stopped the method: {k} of {len(rows)} rows unsupported; next step is the user's")
    if check.get("checkers") is not None and (check.get("straddle") is not False or check.get("unsupported_any", STOP_AT) >= STOP_AT):
        raise TopicError(f"{CHECK_FILE}: the checkers straddle the stop rule: {k} of {len(rows)} unsupported by majority, {check.get('unsupported_any')} by any checker; "
                         "next step is the user's")
