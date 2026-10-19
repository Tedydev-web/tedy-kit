import sys
from pathlib import Path

from study_fetch import Fetch
from study_pool import Pool, code_search, parse_json, run_social
from study_topic import TopicError, load_topic, topic_arguments


def channels_of(topic, stratum):
    channels = topic["strata"].get(stratum, {}).get("channels")
    if not isinstance(channels, dict):
        raise TopicError(f"{topic['path']}: strata.{stratum}.channels must be an object")
    return channels


def repo_search(fetch, pool, args, step, channel, via):
    if pool.done(step):
        return
    out, status, seconds = fetch.run(["gh", "search", "repos", *args, "--sort", "stars", "--limit", "100", "--json", "fullName"])
    items = parse_json(out, status, [])
    new = sum(pool.add(*item["fullName"].split("/", 1), channel, via) for item in items)
    pool.record(step, channel, via, status, seconds, len(items), len(items), new)
    fetch.pace(2.5)


def awesome_lists(fetch, pool, query, per_query):
    step = f"awesome {query}"
    if pool.done(step):
        return
    out, status, seconds = fetch.run(["gh", "search", "repos", query, "--sort", "stars", "--limit", str(per_query), "--json", "fullName"])
    lists = [item["fullName"] for item in parse_json(out, status, [])]
    linked = new = 0
    for name in lists:
        readme, _, _ = fetch.run(["gh", "api", "-H", "Accept: application/vnd.github.raw", f"repos/{name}/readme"])
        found, fresh = pool.links(readme, "awesome-list", f"listed in {name}")
        linked, new = linked + found, new + fresh
    pool.state.setdefault("aggregator_lists", []).extend(lists)
    pool.record(step, "awesome-list", f"{query} -> {', '.join(lists)}", status, seconds, len(lists), linked, new)


def marketplaces(pool, home):
    for market in sorted(Path(home).glob(".claude/plugins/marketplaces/*/.claude-plugin/marketplace.json")):
        name = market.parent.parent.name
        if pool.done(f"marketplace {name}"):
            continue
        found, fresh = pool.links(market.read_text(), "marketplace", f"marketplace {name}")
        pool.record(f"marketplace {name}", "marketplace", name, "ok", 0, 1, found, fresh)


def discover(topic, work, home, fetch):
    channels = channels_of(topic, "config")
    pool = Pool(Path(work) / "config-state.json")
    for query in channels.get("repo_queries", []):
        repo_search(fetch, pool, [query], f"repo {query}", "github-repo-search", f'repos "{query}"')
    for name in channels.get("topics", []):
        repo_search(fetch, pool, ["--topic", name], f"topic {name}", "github-topic", f"topic {name}")
    for query in channels.get("code_queries", []):
        code_search(fetch, pool, query, channels.get("code_pages", 10), "github-code-search")
    for query in channels.get("awesome_queries", []):
        awesome_lists(fetch, pool, query, channels.get("awesome_lists_per_query", 3))
    if channels.get("marketplaces"):
        marketplaces(pool, home)
    run_social(fetch, pool, channels.get("social", {}))
    return pool


def main(argv=None, fetch=None):
    args = topic_arguments("Discover the config stratum pool on every channel the topic lists.",
                           (["--work"], {"required": True, "help": "study working folder for state and cache"}),
                           (["--home"], {"default": str(Path.home()), "help": "home folder holding .claude/plugins"})).parse_args(argv)
    try:
        pool = discover(load_topic(args.repo, args.topic), args.work, args.home, fetch or Fetch())
    except TopicError as error:
        sys.exit(f"discover-config-pool: {error}")
    failed = sum(1 for entry in pool.state["log"] if entry["status"] != "ok")
    print(f"config identified {len(pool.state['hits'])}; per channel {pool.per_channel()}; failed steps {failed}")


if __name__ == "__main__":
    main()
