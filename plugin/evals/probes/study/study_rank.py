import math
import re
from pathlib import Path

from study_pool import AGGREGATOR_TEXT, ASSET, SOCIAL, cache_name, read_json, work_file
from study_topic import term_regex

VENDORED = {"fixtures", "fixture", "mirrors", "mirror", "dataset", "datasets", "profiles", "examples", "example", "vendor", "vendored",
            "third_party", "third-party", "node_modules", "__tests__", "test", "tests", "testdata", "repos", "imported", "skills-imported"}
UNIT = re.compile(r"(?:^|/)(?:skills|agents|commands|hooks|rules|workflows)/[^/]+")
CONFIG_DIR = re.compile(r"(?:^|/)(?:\.claude|\.claude-plugin|\.agents)/[^/]+/")
FOREIGN_SEGMENT = re.compile(r"^([A-Za-z0-9][\w.-]*)[@§]([\w.-]+)$")
SKILL_FILE = re.compile(r"(?:^|/)skills/[^/]+/SKILL\.md$")
CONFIG_CHANNELS = ("config-pool",)
NOT_SOCIAL_VIA = ("code ", "repos ", "topic ", "listed ", "marketplace ")


def order_key(row):
    return (-row["order"], -int(row["pushed"].replace("-", "")), row["repo"].lower())


def counted_code_queries(topic, queries):
    if not topic.get("facet"):
        return "all"
    term = term_regex(topic["terms"])
    return [q for q in queries if term.search(q)]


def counts_query(counted, via):
    return counted == "all" or via.split(": ", 1)[0] in {f"code {q}" for q in counted}


class Ranker:
    def __init__(self, terms, cache, counted="all"):
        self.term = term_regex(terms)
        self.cache = Path(cache)
        self.counted = counted

    def vendored(self, path):
        head = path[:ASSET.search(path).start()].split("/")
        return any(seg.lower() in VENDORED or seg.endswith("-main") or FOREIGN_SEGMENT.match(seg) or self.term.search(seg) for seg in head if seg)

    def foreign_repos(self, paths, with_term):
        found = set()
        for path in paths:
            if with_term and not (ASSET.search(path) and self.term.search(path)):
                continue
            segs = path.split("/")
            for parent, seg in zip(segs[:-2], segs[1:-1]):
                match = FOREIGN_SEGMENT.match(seg)
                if match and parent.lower() in VENDORED:
                    found.add(f"{match.group(1)}/{match.group(2)}".lower())
        return found

    def load(self, folder, key):
        return read_json(work_file(self.cache.parent, Path(self.cache.name) / folder / cache_name(key)), {"error": "not fetched"})

    def name_hit(self, row):
        return bool(self.term.search(row["repo"].split("/", 1)[1].replace("_", "-")) or self.term.search(row.get("description") or ""))

    def rank(self, pool_rows):
        rows = {}
        for row in pool_rows:
            key = row["repo"].lower()
            if key in rows:
                rows[key]["channels"] = sorted(set(rows[key]["channels"]) | set(row["channels"]))
                rows[key]["via"] = rows[key]["via"] + [v for v in row["via"] if v not in rows[key]["via"]]
            else:
                rows[key] = dict(row)
        shas = {key: self.load("asset-shas", key) for key in rows}
        created = {key: row.get("created") or "" for key, row in rows.items()}
        first_holder = {}
        for key, body in shas.items():
            for sha in set(body.get("shas", {}).values()):
                held = first_holder.get(sha)
                if held is None or (created[key], key) < (created[held], held):
                    first_holder[sha] = key
        ranked, aggregators, snowball = [], [], {}
        for key, row in rows.items():
            tree = self.load("trees", key)
            paths = tree.get("paths", [])
            hits = [p for p in paths if ASSET.search(p) and self.term.search(p)]
            kept = [p for p in hits if not self.vendored(p)]
            blob = shas[key].get("shas")
            original = kept if blob is None else [p for p in kept if p not in blob or first_holder.get(blob[p]) == key]
            units = sorted({unit(p) for p in original})
            code_queries = sorted({v.split(": ", 1)[0] for v in row["via"] if v.startswith("code ") and counts_query(self.counted, v)})
            social_hit = bool(SOCIAL & set(row["channels"])) and any(self.term.search(v) for v in row["via"] if not v.startswith(NOT_SOCIAL_VIA))
            name_hit = self.name_hit(row)
            all_units = {unit(p) for p in paths if ASSET.search(p) and not self.vendored(p)}
            focus = len(units) / max(1, len(all_units))
            order = len(code_queries) + (1 if units else 0) + focus + (1 if name_hit else 0) + (0.5 if social_hit else 0)
            reasons = [r for r, hit in (("text", bool(AGGREGATOR_TEXT.search(row["repo"] + " " + (row.get("description") or "")))),
                                        ("foreign-paths", len(self.foreign_repos(paths, False)) >= 3)) if hit]
            entry = {**row, "graded": len(code_queries) + len(hits) + (1 if name_hit else 0) + (0.5 if social_hit else 0), "asset_hits": hits[:6],
                     "asset_hit_count": len(hits), "code_queries": code_queries, "name_hit": name_hit, "social_hit": social_hit,
                     "description": (row.get("description") or "")[:200], "tree": "error" if tree.get("error") else "truncated" if tree.get("truncated") else "ok",
                     "order": round(order, 3), "units": units[:8], "unit_count": len(units), "all_units": len(all_units), "focus": round(focus, 3),
                     "copied_units": len({unit(p) for p in kept}) - len(units), "vendored_hits": len(hits) - len(kept),
                     "skill_files": sum(1 for p in paths if SKILL_FILE.search(p)), "sha_state": "error" if blob is None else "ok",
                     "created": created[key], "aggregator": reasons}
            if reasons:
                for name in self.foreign_repos(paths, True):
                    snowball.setdefault(name, set()).add(row["repo"])
            (aggregators if reasons else ranked).append(entry)
        ranked.sort(key=order_key)
        for index, row in enumerate(ranked, 1):
            row["order_rank"] = index
        fresh = {k: sorted(v) for k, v in snowball.items() if k not in rows}
        return {"rows": ranked, "aggregators": aggregators, "snowball_from_paths": fresh}


def contract_path(evidence, prefixes):
    known = next((evidence[len(p):] for p in prefixes if evidence.startswith(p)), None)
    if known is not None:
        return known
    return evidence.split(": ", 1)[1] if evidence.startswith("code ") and ": " in evidence else evidence


def rank_product(pool_rows, terms, code_queries=(), counted="all"):
    term = term_regex(terms)
    prefixes = sorted((f"code {q}: " for q in code_queries), key=len, reverse=True)
    rows, aggregators = [], []
    for row in pool_rows:
        text = row["repo"] + " " + (row.get("description") or "")
        if AGGREGATOR_TEXT.search(text):
            aggregators.append({"repo": row["repo"], "description": (row.get("description") or "")[:200]})
            continue
        own = [e for e in row["evidence"].get("code", []) if counts_query(counted, e)]
        evidence = {c: (own if c == "code" else v) for c, v in row["evidence"].items() if c != "code" or own}
        if counted != "all":
            evidence = {c: kept for c, v in evidence.items() if c not in CONFIG_CHANNELS for kept in [[e for e in v if term.search(e)]] if kept}
        contract = list(dict.fromkeys(contract_path(e, prefixes) for e in evidence.get("code", [])))
        name_hit = bool(term.search(row["repo"].split("/", 1)[1].replace("_", "-")) or term.search(row.get("description") or ""))
        order = len(evidence) + math.log2(1 + len(contract)) + (1 if name_hit else 0)
        rows.append({"repo": row["repo"], "order": round(order, 3), "channels": sorted(evidence), "contract_files": contract[:6],
                     "evidence": {c: v[:3] for c, v in evidence.items()}, "name_hit": name_hit, "description": (row.get("description") or "")[:200],
                     "stars": row["stars"], "created": row["created"][:10], "pushed": row["pushed"][:10], "archived": row["archived"], "fork": row["fork"],
                     **{k: row[k] for k in ("closed_issues", "merged_prs", "license") if k in row}})
    rows.sort(key=order_key)
    for index, row in enumerate(rows, 1):
        row["order_rank"] = index
    return {"rows": rows, "aggregators": aggregators}


def unit(path):
    found = UNIT.search(path) or CONFIG_DIR.search(path)
    return path[:found.end()].rstrip("/") if found else path
