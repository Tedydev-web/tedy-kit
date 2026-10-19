import json
import re
import sys
import urllib.parse
from pathlib import Path

from study_academic import run_academic
from study_fetch import Fetch
from study_pool import CONFIG_DIR_MARKER, GH_LINK, Pool, cache_name, code_search, parse_json, read_json, run_social
from study_topic import TopicError, load_topic, term_regex, topic_arguments

CHANNELS = ("npm", "social", "reverse", "code", "repo", "academic")
COMMAND = re.compile(r"\b(npx|bunx|uvx|pipx run|pnpm dlx|yarn dlx)\s+(?:-y\s+|--yes\s+|--from\s+\S+\s+)?(@?[a-z0-9][\w.-]*(?:/[\w.-]+)?)", re.I)
HOOK_CONFIG = re.compile(r"(^|/)(hooks/hooks\.json|\.claude/settings(\.local)?\.json|\.claude-plugin/plugin\.json|\.mcp\.json)$")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class Product:
    def __init__(self, topic, work, fetch):
        channels = topic["strata"].get("product", {}).get("channels")
        if not isinstance(channels, dict) or not isinstance(channels.get("harness"), str):
            raise TopicError(f"{topic['path']}: strata.product.channels needs a harness pattern")
        self.channels, self.work, self.fetch = channels, Path(work), fetch
        self.term = term_regex(topic["terms"])
        self.harness = re.compile(channels["harness"], re.I)
        self.extra = re.compile(channels["extra_text"], re.I) if channels.get("extra_text") else None
        self.pool = Pool(self.work / "product-state.json")

    def relevant(self, text):
        return bool(self.harness.search(text) and (self.term.search(text) or (self.extra and self.extra.search(text))))

    def npm(self):
        for query in self.channels.get("npm_queries", []):
            step = f"npm {query}"
            if self.pool.done(step):
                continue
            returned = linked = new = seconds = 0
            status = "ok"
            for offset in range(0, 1000, 250):
                url = f"https://registry.npmjs.org/-/v1/search?text={urllib.parse.quote(query)}&size=250&from={offset}"
                out, status, spent = self.fetch.run(["curl", "-sSf", url])
                seconds += spent
                objects = parse_json(out, status, {}).get("objects", [])
                returned += len(objects)
                for obj in objects:
                    pkg = obj["package"]
                    text = " ".join([pkg.get("name", ""), pkg.get("description") or "", " ".join(pkg.get("keywords") or [])])
                    link = GH_LINK.search((pkg.get("links") or {}).get("repository") or "")
                    if link and self.relevant(text):
                        linked += 1
                        new += self.pool.add(link.group(1), link.group(2), "npm", f"{pkg['name']} ({query})")
                if len(objects) < 250:
                    break
            self.pool.record(step, "npm", query, status, round(seconds, 1), returned, linked, new)

    def social(self):
        run_social(self.fetch, self.pool, self.channels.get("social", {}), "social")

    def academic(self):
        run_academic(self.fetch, self.pool, self.channels.get("academic", {}))

    def code(self):
        for field in self.channels.get("code_fields", []):
            for term in self.channels.get("code_terms", []):
                for ext in self.channels.get("code_extensions", []):
                    code_search(self.fetch, self.pool, f"{field} {term} extension:{ext}", self.channels.get("code_pages", 10), "code", CONFIG_DIR_MARKER)

    def repo(self):
        for query in self.channels.get("repo_queries", []):
            step = f"repo {query}"
            if self.pool.done(step):
                continue
            out, status, seconds = self.fetch.run(["gh", "search", "repos", query, "--limit", "100", "--json", "fullName,description"])
            items = parse_json(out, status, [])
            kept = [i for i in items if self.relevant(i["fullName"] + " " + (i.get("description") or ""))]
            new = sum(self.pool.add(*i["fullName"].split("/", 1), "repo", f'repos "{query}"') for i in kept)
            self.pool.record(step, "repo", query, status, seconds, len(items), len(kept), new)
            self.fetch.pace(2.5)
        for harness in self.channels.get("harness_topics", []):
            for subject in self.channels.get("subject_topics", []):
                step = f"topic {harness} {subject}"
                if self.pool.done(step):
                    continue
                out, status, seconds = self.fetch.run(["gh", "search", "repos", "--topic", harness, "--topic", subject, "--limit", "200", "--json", "fullName,description"])
                items = parse_json(out, status, [])
                new = sum(self.pool.add(*i["fullName"].split("/", 1), "repo", f"topics {harness}+{subject}") for i in items)
                self.pool.record(step, "repo", f"topic:{harness} topic:{subject}", status, seconds, len(items), len(items), new)
                self.fetch.pace(2.5)

    def resolve_package(self, runner, name):
        if runner in ("uvx", "pipx run"):
            out, status, _ = self.fetch.run(["curl", "-sSf", f"https://pypi.org/pypi/{name}/json"])
            info = parse_json(out, status, {}).get("info") or {}
            text = " ".join([name, info.get("summary") or "", info.get("keywords") or ""])
            urls = " ".join((info.get("project_urls") or {}).values()) + " " + (info.get("home_page") or "")
        else:
            out, status, _ = self.fetch.run(["curl", "-sSf", f"https://registry.npmjs.org/{name.replace('/', '%2F')}"])
            doc = parse_json(out, status, {})
            text = " ".join([name, doc.get("description") or "", " ".join(doc.get("keywords") or [])])
            repository = doc.get("repository")
            urls = (repository.get("url") if isinstance(repository, dict) else repository) or ""
        return text, GH_LINK.search(urls)

    def reverse(self):
        pool_file = self.work / "config-pool.json"
        if not pool_file.exists():
            raise TopicError(f"the reverse channel reads {pool_file}; run resolve-pool.py for the config stratum first")
        seen = {}
        for row in json.loads(pool_file.read_text())["rows"]:
            step = f"reverse {row['repo'].lower()}"
            if self.pool.done(step):
                continue
            paths = read_json(self.work / "cache" / "trees" / cache_name(row["repo"]), {}).get("paths", [])
            for path in [p for p in paths if HOOK_CONFIG.search(p)][:6]:
                out, status, _ = self.fetch.run(["curl", "-sSfL", "-A", UA, f"https://raw.githubusercontent.com/{row['repo']}/{row.get('branch') or 'HEAD'}/{path}"], timeout=60)
                for runner, name in COMMAND.findall(out if status == "ok" else ""):
                    name = re.sub(r"@[\d^~][\w.-]*$|@latest$", "", name)
                    if name not in seen:
                        seen[name] = self.resolve_package(runner.lower(), name)
                    text, link = seen[name]
                    if link and self.term.search(text):
                        self.pool.add(link.group(1), link.group(2), "reverse", f"{runner} {name} in {row['repo']}/{path}")
            self.pool.state["done"].append(step)
        hits = sum(1 for h in self.pool.state["hits"].values() if "reverse" in h["channels"])
        self.pool.record("reverse all", "reverse", "npx/bunx/uvx/pipx/dlx in hook, settings, plugin and MCP configs of the config pool", "ok", 0, len(seen), hits, hits,
                         {"packages_resolved": len(seen)})


def main(argv=None, fetch=None):
    args = topic_arguments("Discover the product stratum pool: npm, code search, reverse references, social, repository search and the academic channel.",
                           (["--work"], {"required": True, "help": "study working folder for state and cache"}),
                           (["--channels"], {"default": ",".join(CHANNELS), "help": "comma-separated subset of " + ", ".join(CHANNELS)})).parse_args(argv)
    only = [c for c in args.channels.split(",") if c]
    unknown = sorted(set(only) - set(CHANNELS))
    if unknown:
        sys.exit(f"discover-product-pool: unknown channels {unknown}")
    try:
        product = Product(load_topic(args.repo, args.topic), args.work, fetch or Fetch())
        for name in CHANNELS:
            if name in only:
                getattr(product, name)()
                print(f"{name} done; repos so far {len(product.pool.state['hits'])}", flush=True)
    except TopicError as error:
        sys.exit(f"discover-product-pool: {error}")
    counts = {c: sum(1 for h in product.pool.state["hits"].values() if c in h["channels"]) for c in ("npm", "code", "reverse", "social", "repo", "arxiv", "semantic-scholar")}
    print(f"product repos {len(product.pool.state['hits'])}; per channel {counts}; failed steps {product.pool.failed_steps()}, run again to retry them")


if __name__ == "__main__":
    main()
