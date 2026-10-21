import bisect
import hashlib
import json
import re
import sys
from pathlib import Path

from study_calibration_set import README_CUES, SET_FILE, anchors, cue_lines, pinned_inputs, set_file
from study_pool import ASSET
from study_screening_core import read_jsonl
from study_screening_evidence import CHANGELOG, TEST_DIR, TEST_FILE, file_gone
from study_screening_input import FIRST, README, fetch_inputs, inputs_file, pinned_tree, read_file, write_rows
from study_topic import TopicError

BUNDLE_FILE = "reference-bundle.md"
PURPOSES = ("exclusion-audit", "stage1-flags", "adjudication")
ROW_CAP, TRIMMED_TREE, TRIMMED_README = 100_000, 100, 8_000
README_BYTES, TREE_PATHS, CHANGELOG_BYTES = 32_000, 1_500, 4_000
ASSET_FILES, ASSET_BYTES = 10, 6_000
TEST_FILES, TEST_LINES, TEST_BYTES = 10, 40, 1_000
MANIFEST_FILES, MANIFEST_BYTES = 2, 2_000
MANIFESTS = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod")
CUE_CHARS = 200
DOCS = re.compile(r"^docs?$", re.I)
UNPRINTABLE = re.compile(r"contains terminal escape sequences")
OBJECTIVITY_CUES = dict(README_CUES)["objectivity"]
EXCLUDE_GLOSSES = {"irrelevant": "not relevant: no mechanism for a listed problem", "below-threshold": "below the eligibility threshold", "copy": "a copy of another source",
                   "dead": "unreadable: the repository or commit is gone", "aggregator": "an aggregator list"}
DECISION_RULE = (
    "- You label Authority, Methodology, Objectivity, Position and Relevance with 1, 0.5 or 0 against the anchors above, name the ids of the problems above the "
    "repository carries a mechanism for, and give a decision. Date is not asked: the toolchain computes it from facts.pushed and the sweep date.\n"
    "- Relevance is 1 only for a mechanism coded from a file in the row's tree other than a README; a mechanism that only the README claims gives 0.5 at most.\n"
    "- Decide excluded: copy, excluded: dead or excluded: aggregator when your cite shows the repository is one; that decision holds whatever the scores.\n"
    "- Otherwise the decision is derived. Novelty is 1 for a row with at least one mechanism and 0 for a row with none. The row is eligible when Relevance = 1, "
    "Novelty ≥ 0.5 and Authority + Methodology + Objectivity + Date + Position + Novelty ≥ 4.5; otherwise it is excluded: irrelevant when Relevance is 0, and "
    "excluded: below-threshold when it is not.")


def inputs_name(stratum):
    return f"reference-inputs-{stratum}.jsonl"


def size(value):
    return len(json.dumps(value, ensure_ascii=False).encode())


def text_size(text):
    return size(text) - 2


def clip(text, limit):
    if text_size(text) <= limit:
        return text
    return text[:bisect.bisect_right(range(len(text) + 1), limit, key=lambda n: text_size(text[:n])) - 1]


def set_criteria(work):
    path = Path(work) / SET_FILE
    if not path.is_file():
        raise TopicError(f"no {SET_FILE} in {work}; the bundle quotes the criteria file the calibration set was drawn under")
    return json.loads(path.read_text())["criteria"]


def criteria_parts(repo, criteria):
    path = Path(repo) / criteria
    if not path.is_file():
        raise TopicError(f"no criteria file at {path}")
    text = path.read_text()
    anchors(text)
    start = text.find("## GitHub assets")
    aggregators = [p for p in text.split("\n\n") if p.startswith("**Aggregators.**")]
    if start < 0 or len(aggregators) != 1:
        raise TopicError(f"{path} needs one ## GitHub assets section and one **Aggregators.** paragraph; the bundle quotes both")
    return text[start:].split("\n## ", 1)[0].strip(), aggregators[0]


def problem_lines(repo, topic):
    problems = topic.get("problems") or []
    path = Path(repo) / str(topic.get("registry") or "")
    if not problems or not topic.get("registry") or not path.is_file():
        raise TopicError(f"{topic['path']}: the bundle lists every topic problem with its registry statement; name the problems and a registry file")
    found = dict(re.findall(r"^\| ([A-Za-z]+\d+) \| ([^|]+?) \|", path.read_text(), re.M))
    lacking = [p for p in problems if p not in found]
    if lacking:
        raise TopicError(f"{path}: no row for {lacking}")
    return [f"- {p}: {found[p]}" for p in problems]


def bundle_text(repo, topic, criteria):
    eligibility = (topic.get("eligibility") or {}).get("en")
    if not eligibility:
        raise TopicError(f"{topic['path']}: the bundle states eligibility.en; add it to the topic config")
    section, aggregators = criteria_parts(repo, criteria)
    facets = topic.get("facets") or {"all": {"problems": topic.get("problems") or [], "terms": topic["terms"]}}
    parts = [f"# Reference anchors: topic {topic['name']}, sweep {topic['sweep']}", "## Eligibility", eligibility, "## Problems", "\n".join(problem_lines(repo, topic)),
             "## Facets and their terms", "\n".join(f"- {name} ({', '.join(rule['problems'])}): {', '.join(rule['terms'])}" for name, rule in facets.items()),
             section, aggregators, "## Exclusion codes", "\n".join(f"- {code}: {gloss}" for code, gloss in EXCLUDE_GLOSSES.items()), "## Decision rule", DECISION_RULE]
    return "\n\n".join(parts) + "\n"


def write_bundle(repo, topic, work, criteria):
    text = bundle_text(repo, topic, criteria)
    (Path(work) / BUNDLE_FILE).write_text(text)
    return hashlib.sha256(text.encode()).hexdigest()


def file_paths(paths):
    folders = {"/".join(parts[:i]) for parts in (p.split("/") for p in paths) for i in range(1, len(parts))}
    return [p for p in paths if p not in folders]


def tested(path):
    *folders, name = path.split("/")
    return any(TEST_DIR.match(f) for f in folders) or bool(TEST_FILE.match(name))


def documented(path):
    return any(DOCS.match(f) for f in path.split("/")[:-1])


def tree_order(paths):
    return sorted(paths, key=lambda p: 0 if ASSET.search(p) else 1 if tested(p) or documented(p) else 2)


def released(evidence):
    counts = [(evidence.get(k) or {}).get("count") for k in ("releases", "tags")]
    return any(c not in (None, 0) for c in counts) or any(isinstance(p, dict) and bool(p.get("published")) for p in (evidence.get("package") or {}).values())


def reference_row(fetch, work, held, sha):
    repo = held["repo"]
    where = f"rank {held['order_rank']} ({repo})"
    tree_sha, paths, status, _ = pinned_tree(fetch, work, repo)
    if status != "ok":
        raise TopicError(f"{where}: {status}")
    if tree_sha != sha:
        raise TopicError(f"{where}: the pinned tree is at {tree_sha}, not the commit {sha} the inputs pin; the reference reads the commit every judge read")
    missing, truncated, full = [], {}, {}

    def read(part, path, limit, lines=None):
        entry = read_file(fetch, repo, sha, path, sys.maxsize)
        if "error" in entry:
            if not (file_gone(entry["error"]) or UNPRINTABLE.search(entry["error"])):
                raise TopicError(f"{where}: {path}: {entry['error']}; build again, the rows already written are kept")
            missing.append(f"{path}: {entry['error']}")
            return None
        if entry.get("binary"):
            missing.append(f"{path}: binary")
            return None
        full[path] = entry["text"]
        cut = clip("".join(entry["text"].splitlines(keepends=True)[:lines]) if lines else entry["text"], limit)
        if cut != entry["text"]:
            truncated[part] = {"before": text_size(entry["text"]), "after": text_size(cut)}
        return cut

    def listed(part, chosen, limit, lines=None):
        return [{"path": p, "text": t} for p in chosen if (t := read(f"{part}:{p}", p, limit, lines)) is not None]

    files = file_paths(paths)
    readme_path = next((p for p in files if "/" not in p and README.match(p)), None)
    if not readme_path:
        missing.append("README: no root README in the pinned tree")
    readme = read("readme", readme_path, README_BYTES) if readme_path else None
    assets = listed("assets", sorted((p for p in files if ASSET.search(p)), key=lambda p: not FIRST.search(p))[:ASSET_FILES], ASSET_BYTES)
    tests = listed("tests", [p for p in files if tested(p)][:TEST_FILES], TEST_BYTES, TEST_LINES)
    changelog_path = next((p for p in files if CHANGELOG.match(p)), None)
    changelog = read("changelog", changelog_path, CHANGELOG_BYTES) if changelog_path else None
    manifests = listed("manifests", [m for m in MANIFESTS if m in set(files)][:MANIFEST_FILES], MANIFEST_BYTES)
    ordered = tree_order(paths)
    if len(ordered) > TREE_PATHS:
        truncated["tree"] = {"before": size(ordered), "after": size(ordered[:TREE_PATHS])}
    cues = [f"{path}:{line}"[:CUE_CHARS] for path in (readme_path, *(m["path"] for m in manifests)) if path in full for line in cue_lines(full[path], OBJECTIVITY_CUES)]
    row = {**{k: held[k] for k in ("order_rank", "repo", "sha", "facts", "evidence")}, "readme": readme or "", "tree": ordered[:TREE_PATHS], "assets": assets,
           "tests": tests, "changelog": changelog, "manifests": manifests,
           "prefilled": {"released": released(held["evidence"]), "changelog": changelog_path, "paid_tier_cues": cues}, "truncated": truncated,
           **({"missing": missing} if missing else {})}
    return capped(row, where)


def cut(row, part, value, measure):
    before = row["truncated"].get(part, {}).get("before", measure(row[part]))
    row[part] = value
    row["truncated"][part] = {"before": before, "after": measure(value)}


def capped(row, where):
    trimmed = False
    if size(row) > ROW_CAP and len(row["tree"]) > TRIMMED_TREE:
        cut(row, "tree", row["tree"][:TRIMMED_TREE], size)
        trimmed = True
    if size(row) > ROW_CAP and text_size(row["readme"]) > TRIMMED_README:
        cut(row, "readme", clip(row["readme"], TRIMMED_README), text_size)
        trimmed = True
    if size(row) > ROW_CAP:
        raise TopicError(f"{where}: {size(row)} bytes, over the {ROW_CAP}-byte cap after both trims (tree to {TRIMMED_TREE} paths, README to {TRIMMED_README} bytes); "
                         "asset files are never trimmed")
    return row, trimmed


def batch_rows(work, stratum, batch):
    path = work / set_file(batch)
    if not path.is_file():
        raise TopicError(f"no {path.name} in {work}; reference inputs are built for a drawn batch")
    sample = json.loads(path.read_text())
    pinned = pinned_inputs(work, sample)
    wanted = []
    for row in sample["rows"]:
        if row["stratum"] != stratum:
            continue
        held, sha = pinned[row["id"]], row["commit"].rsplit("/", 1)[-1]
        if "error" in held or held.get("sha") != sha:
            raise TopicError(f"{row['id']}: its inputs hold {held.get('error') or 'the commit ' + str(held.get('sha'))}, not a readable row at the set's commit {sha}")
        wanted.append((held, sha))
    return wanted


def purpose_rows(topic, work, stratum, purpose, ranks, fetch):
    if purpose not in PURPOSES:
        raise TopicError(f"purpose {purpose!r} is not one of {', '.join(PURPOSES)}")
    if not ranks:
        raise TopicError("--purpose needs --ranks")
    have = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
    if any(r not in have for r in ranks):
        fetch_inputs(topic, work, stratum, 0, fetch, ranks={r for r in ranks if r not in have})
        have = {r["order_rank"]: r for r in read_jsonl(work, inputs_file(work, stratum).name)}
    wanted = []
    for rank in ranks:
        held = have.get(rank)
        if held is None:
            raise TopicError(f"{stratum} rank {rank} has no screening inputs; it is not in {stratum}-screening-order.jsonl")
        if "error" in held:
            raise TopicError(f"{stratum} rank {rank} holds the fetch error {held['error']}; fetch its screening inputs again first")
        wanted.append((held, held["sha"]))
    return wanted


def build_packets(topic, repo, work, stratum, fetch, batch=None, purpose=None, ranks=None):
    work = Path(work)
    if (batch is None) == (purpose is None):
        raise TopicError("name exactly one of --batch and --purpose")
    wanted = batch_rows(work, stratum, batch) if batch else purpose_rows(topic, work, stratum, purpose, ranks, fetch)
    target = work / inputs_name(stratum)
    held = {r["order_rank"]: r for r in read_jsonl(work, target.name)}
    counts = {"built": 0, "kept": 0, "trimmed": 0}
    for inputs, sha in wanted:
        rank = inputs["order_rank"]
        if rank in held:
            if held[rank]["sha"] != sha:
                raise TopicError(f"{target.name} holds rank {rank} at {held[rank]['sha']}, not at {sha}; one rank is read at one commit")
            counts["kept"] += 1
            continue
        held[rank], trimmed = reference_row(fetch, work, inputs, sha)
        write_rows(target, held)
        counts["built"] += 1
        counts["trimmed"] += trimmed
    return counts
