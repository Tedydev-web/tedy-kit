import json
import re
from pathlib import Path

GH_LINK = re.compile(r"github\.com[/:]([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})")
INSTALL_REF = re.compile(r"(?:skills add|plugin install|plugin marketplace add|marketplace add)\s+([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})", re.I)
NOT_OWNERS = {"orgs", "topics", "sponsors", "features", "apps", "marketplace", "settings", "login", "about", "collections", "search",
              "notifications", "user-attachments", "assets", "issues", "pulls", "explore", "users", "enterprise", "site", "contact", "pricing"}
ASSET = re.compile(r"(^|/)(\.claude|\.claude-plugin|\.agents)/|(^|/)(SKILL\.md|AGENTS\.md|CLAUDE\.md|\.cursorrules)$|(^|/)skills/[^/]+/SKILL\.md$"
                   r"|(^|/)agents/[^/]+\.md$|(^|/)commands/[^/]+\.md$|(^|/)hooks/hooks\.json$")
CONFIG_DIR_MARKER = re.compile(r"(^|/)(\.claude|\.claude-plugin|\.agents)/")
AGGREGATOR_TEXT = re.compile(r"awesome|mirror|curated|marketplace|list of|directory of", re.I)
SOCIAL = {"x", "reddit", "youtube", "facebook"}


def cache_name(key):
    return key.lower().replace("/", "__") + ".json"


def read_json(path, default):
    path = Path(path)
    return json.loads(path.read_text()) if path.exists() else default


class Pool:
    def __init__(self, path):
        self.path = Path(path)
        self.state = read_json(self.path, {"hits": {}, "log": [], "done": []})

    def add(self, owner, repo, channel, evidence):
        repo = re.sub(r"\.git$", "", repo).rstrip(".")
        if owner.lower() in NOT_OWNERS or not repo or repo.lower() in {"blob", "tree"}:
            return False
        entry = self.state["hits"].setdefault(f"{owner}/{repo}".lower(), {"repo": f"{owner}/{repo}", "channels": {}})
        fresh = not entry["channels"]
        bucket = entry["channels"].setdefault(channel, [])
        if evidence not in bucket and len(bucket) < 12:
            bucket.append(evidence)
        return fresh

    def links(self, text, channel, via):
        found = set(GH_LINK.findall(text)) | set(INSTALL_REF.findall(text))
        return len(found), sum(self.add(owner, repo, channel, via) for owner, repo in found)

    def done(self, step):
        return step in self.state["done"]

    def record(self, step, channel, query, status, seconds, returned, linked, new, extra=None):
        self.state["log"].append({"step": step, "channel": channel, "query": query, "status": status, "seconds": seconds,
                                  "returned": returned, "repos_linked": linked, "new_repos": new, **(extra or {})})
        if status == "ok":
            self.state["done"].append(step)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.state))

    def failed_steps(self):
        return len({e["step"] for e in self.state["log"] if e["status"] != "ok"} - set(self.state["done"]))

    def per_channel(self):
        counts = {}
        for hit in self.state["hits"].values():
            for channel in hit["channels"]:
                counts[channel] = counts.get(channel, 0) + 1
        return counts


def parse_json(out, status, default):
    if status != "ok" or not out.strip():
        return default
    try:
        return json.loads(out)
    except ValueError:
        return default


def graphql_repositories(fetch, repos, fields, batch=40):
    found, failed = {}, 0
    keys = list(repos)
    for start in range(0, len(keys), batch):
        chunk = keys[start:start + batch]
        parts = [f"r{i}: repository(owner: {json.dumps(repos[k].split('/', 1)[0])}, name: {json.dumps(repos[k].split('/', 1)[1])}) {{ {fields} }}" for i, k in enumerate(chunk)]
        out, status, _ = fetch.run(["gh", "api", "graphql", "-f", f"query={{ {' '.join(parts)} }}"])
        body = parse_json(out, "ok" if out.strip().startswith("{") else status, {})
        data = body.get("data") if isinstance(body, dict) else None
        if not data:
            failed += 1
            continue
        for i, key in enumerate(chunk):
            found[key] = data.get(f"r{i}")
    return found, failed


def code_search(fetch, pool, query, pages, channel, skip_path=None):
    step = f"code {query}"
    if pool.done(step):
        return
    returned = kept = new = total = 0
    failures, seconds = [], 0
    for page in range(1, pages + 1):
        fetch.pace(6.5)
        out, status, spent = fetch.run(["gh", "api", "-X", "GET", "search/code", "-f", f"q={query}", "-f", "per_page=100", "-f", f"page={page}"])
        seconds += spent
        body = parse_json(out, status, None)
        if not isinstance(body, dict):
            failures.append(f"page {page}: {status}")
            break
        total = body.get("total_count", 0)
        items = body.get("items", [])
        returned += len(items)
        for item in items:
            if skip_path and skip_path.search(item["path"]):
                continue
            kept += 1
            new += pool.add(*item["repository"]["full_name"].split("/", 1), channel, f"code {query}: {item['path']}")
        if len(items) < 100 or page * 100 >= min(total, 1000):
            break
    pool.record(step, channel, query, "ok" if not failures else "; ".join(failures), round(seconds, 1), returned, kept, new,
                {"total_count": total, "truncated_at_1000": total > 1000})


def social_jobs(social):
    jobs = [(["twitter", "search", q, "--max", "40", "--json"], "x", f'x "{q}"') for q in social.get("x", [])]
    jobs += [(["rdt", "search", q, "-r", sub, "--sort", social.get("reddit_sort", "top"), "--time", "year", "--limit", "25", "--full-text", "--json"], "reddit", f'r/{sub} "{q}"')
             for sub, q in social.get("reddit", [])]
    jobs += [(["yt-dlp", "--skip-download", "--ignore-errors", "--print", "description", f"ytsearch8:{q}"], "youtube", f'youtube "{q}"') for q in social.get("youtube", [])]
    jobs += [(["opencli", "facebook", "search", q, "-f", "json"], "facebook", f'facebook "{q}"') for q in social.get("facebook", [])]
    return jobs


def run_social(fetch, pool, social, channel_name=None):
    for cmd, channel, via in social_jobs(social):
        step = f"social {via}"
        if pool.done(step):
            continue
        out, status, seconds = fetch.run(cmd, timeout=240)
        linked, new = pool.links(out, channel_name or channel, via) if status == "ok" else (0, 0)
        pool.record(step, channel, via, status, seconds, out.count("\n"), linked, new)
        fetch.pace(2 if channel == "x" else 1)


README_LINK = re.compile(r"github\.com/([A-Za-z0-9][\w.-]*)/([\w.-]+?)(?:\.git)?(?=[/)\s\"'#?>\]]|$)")


def readme(fetch, cache, repo):
    target = Path(cache) / "readmes" / (repo.lower().replace("/", "__") + ".md")
    if target.exists():
        return target.read_text()
    out, status, _ = fetch.run(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/readme"], timeout=120)
    if status != "ok":
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(out)
    return out


def term_links(text, term, skip):
    for line in text.splitlines():
        if not term.search(README_LINK.sub("", line)):
            continue
        for owner, name in README_LINK.findall(line):
            key = f"{owner}/{name}".lower()
            if owner.lower() not in NOT_OWNERS and key != skip.lower():
                yield owner, name, line
