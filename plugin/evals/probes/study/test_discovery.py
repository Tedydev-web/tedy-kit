import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from study_fetch import Fetch, NetworkRefused
from study_fixtures import HERE, FakeFetch, script, topic_repo, write_json
from study_pool import Pool
from study_topic import TopicError, load_topic

KIT = HERE.parents[3]
GQL = json.dumps


def channels_topic(repo):
    topic = json.loads((repo / "docs/prior-art/topics/demo.json").read_text())
    topic["strata"]["config"]["channels"] = {
        "repo_queries": ["tdd agent"], "topics": ["claude-code"], "code_queries": ['"failing test" filename:SKILL.md'], "code_pages": 2,
        "awesome_queries": ["awesome tdd"], "awesome_lists_per_query": 1, "marketplaces": True,
        "social": {"x": ["tdd x"], "reddit": [["ClaudeCode", "tdd r"]], "youtube": ["tdd yt"], "facebook": ["tdd fb"]}}
    topic["strata"]["product"] = {"stop_row": 5, "forced_repos": [], "channels": {
        "harness": "claude|agent", "extra_text": "weaken\\w* tests?", "npm_queries": ["claude tdd"], "code_fields": ["hook_event_name"], "code_terms": ["tdd"],
        "code_extensions": ["ts"], "code_pages": 1, "repo_queries": ["tdd hook"], "harness_topics": ["claude-code"], "subject_topics": ["tdd"],
        "social": {"x": ["hook tdd"]}}}
    write_json(repo / "docs/prior-art/topics/demo.json", topic)
    return load_topic(repo, "demo")


class Base(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo()
        self.work = Path(tempfile.mkdtemp(prefix="study-work-"))
        self.home = Path(tempfile.mkdtemp(prefix="study-home-"))
        for path in (self.repo, self.work, self.home):
            self.addCleanup(shutil.rmtree, path)
        self.topic = channels_topic(self.repo)


class FetchTest(unittest.TestCase):
    def test_no_network_flag_refuses_every_command(self):
        old = os.environ.get("STUDY_NO_NETWORK")
        os.environ["STUDY_NO_NETWORK"] = "1"
        try:
            with self.assertRaises(NetworkRefused):
                Fetch(sleep=lambda s: None).run(["gh", "api", "rate_limit"])
        finally:
            if old is None:
                del os.environ["STUDY_NO_NETWORK"]

    def test_gh_rate_limits_wait_for_the_reset_then_retry(self):
        pauses = []

        class Scripted(Fetch):
            replies = [("", "exit 1: API rate limit exceeded", 0), ("9", "ok", 0), ("[]", "ok", 0)]

            def _once(self, cmd, timeout):
                return self.replies.pop(0)

        out, status, _ = Scripted(sleep=pauses.append).run(["gh", "search", "repos", "x"])
        self.assertEqual((out, status), ("[]", "ok"))
        self.assertEqual(pauses, [30])


class ConfigDiscoveryTest(Base):
    def fetch(self):
        return FakeFetch([
            ("search repos tdd agent", GQL([{"fullName": "o/a"}])),
            ("--topic claude-code", GQL([{"fullName": "o/b"}, {"fullName": "o/a"}])),
            ("search/code", GQL({"total_count": 1, "items": [{"path": "skills/tdd/SKILL.md", "repository": {"full_name": "o/c"}}]})),
            ("search repos awesome tdd", GQL([{"fullName": "list/awesome-tdd"}])),
            ("repos/list/awesome-tdd/readme", "- [d](https://github.com/o/d) tdd skill\n"),
            ("twitter search", "see https://github.com/o/x"), ("rdt search", "https://github.com/o/r"),
            ("yt-dlp", "github.com/o/y"), ("opencli facebook search tdd fb", "github.com/o/f"),
        ])

    def test_every_listed_channel_is_searched_and_logged(self):
        market = self.home / ".claude/plugins/marketplaces/m/.claude-plugin/marketplace.json"
        write_json(market, {"plugins": [{"source": "https://github.com/o/m"}]})
        fetch = self.fetch()
        pool = script("discover-config-pool").discover(self.topic, self.work, self.home, fetch)
        self.assertEqual(pool.per_channel(), {"github-repo-search": 1, "github-topic": 2, "github-code-search": 1, "awesome-list": 1, "marketplace": 1,
                                              "x": 1, "reddit": 1, "youtube": 1, "facebook": 1})
        self.assertIn("code \"failing test\" filename:SKILL.md: skills/tdd/SKILL.md", pool.state["hits"]["o/c"]["channels"]["github-code-search"])
        self.assertEqual(fetch.called("rdt search"), ["rdt search tdd r -r ClaudeCode --sort top --time year --limit 25 --full-text --json"])
        self.assertEqual(len(fetch.called("search/code")), 1)
        saved = json.loads((self.work / "config-state.json").read_text())
        self.assertEqual(len(saved["log"]), 9)

    def test_a_rerun_resumes_from_the_saved_state_without_calling_again(self):
        script("discover-config-pool").discover(self.topic, self.work, self.home, self.fetch())
        again = FakeFetch()
        script("discover-config-pool").discover(self.topic, self.work, self.home, again)
        self.assertEqual(again.calls, [])

    def test_a_failed_call_is_logged_not_dropped(self):
        fetch = FakeFetch([("search repos tdd agent", ("", "exit 1: boom"))])
        pool = script("discover-config-pool").discover(self.topic, self.work, self.home, fetch)
        self.assertEqual([e["status"] for e in pool.state["log"] if e["channel"] == "github-repo-search"], ["exit 1: boom"])

    def test_a_topic_without_config_channels_is_refused(self):
        topic = load_topic(self.repo, "demo")
        topic["strata"]["config"].pop("channels")
        with self.assertRaisesRegex(TopicError, "strata.config.channels must be an object"):
            script("discover-config-pool").discover(topic, self.work, self.home, FakeFetch())


ATOM = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
 <entry><id>http://arxiv.org/abs/2510.00001v2</id><published>2025-10-01T00:00:00Z</published><title>Agents that
 tamper with tests</title><summary>Code at https://github.com/lab/bench.</summary><arxiv:comment>see github.com/lab/tool</arxiv:comment></entry>
</feed>"""


class AcademicDiscoveryTest(Base):
    def academic_topic(self, stratum="config"):
        topic = json.loads((self.repo / "docs/prior-art/topics/demo.json").read_text())
        topic["strata"][stratum]["channels"]["academic"] = {"arxiv": ['abs:"test tampering"'], "semantic_scholar": ["test tampering agents"], "max_results": 5}
        write_json(self.repo / "docs/prior-art/topics/demo.json", topic)
        return load_topic(self.repo, "demo")

    def test_the_academic_channel_logs_papers_and_pools_their_repositories(self):
        s2 = GQL({"data": [{"paperId": "p1", "title": "LLM test cheating", "year": 2026, "url": "https://www.semanticscholar.org/paper/p1",
                             "abstract": "We release github.com/lab/bench", "externalIds": {"ArXiv": "2510.00001"}}]})
        fetch = FakeFetch([("export.arxiv.org", ATOM), ("api.semanticscholar.org", s2)])
        pool = script("discover-config-pool").discover(self.academic_topic(), self.work, self.home, fetch)
        self.assertEqual(fetch.called("export.arxiv.org"), ["curl -sSf https://export.arxiv.org/api/query?search_query=abs%3A%22test%20tampering%22&start=0&max_results=5&sortBy=relevance"])
        self.assertEqual(fetch.called("api.semanticscholar.org"), ["curl -sSf https://api.semanticscholar.org/graph/v1/paper/search?query=test%20tampering%20agents&limit=5"
                                                                    "&fields=title,year,url,abstract,externalIds"])
        self.assertEqual(pool.state["papers"]["arxiv:2510.00001"], {"title": "Agents that tamper with tests", "published": "2025-10-01", "url": "https://arxiv.org/abs/2510.00001",
                                                                    "channels": ["arxiv", "semantic-scholar"], "queries": ['arxiv abs:"test tampering"', 's2 test tampering agents']})
        self.assertEqual(pool.state["hits"]["lab/bench"]["channels"], {"arxiv": ["arxiv:2510.00001"], "semantic-scholar": ["arxiv:2510.00001"]})
        self.assertIn("lab/tool", pool.state["hits"])
        self.assertEqual([(e["channel"], e["returned"], e["status"]) for e in pool.state["log"] if e["channel"] in ("arxiv", "semantic-scholar")],
                         [("arxiv", 1, "ok"), ("semantic-scholar", 1, "ok")])

    def test_a_rate_limited_or_unparsable_academic_call_is_logged_as_failed(self):
        fetch = FakeFetch([("export.arxiv.org", "<feed"), ("api.semanticscholar.org", ("", "exit 22: The requested URL returned error: 429"))])
        pool = script("discover-config-pool").discover(self.academic_topic(), self.work, self.home, fetch)
        self.assertEqual([(e["channel"], e["status"]) for e in pool.state["log"] if e["channel"] in ("arxiv", "semantic-scholar")],
                         [("arxiv", "unparsable Atom feed"), ("semantic-scholar", "exit 22: The requested URL returned error: 429")])

    def test_the_product_stratum_runs_the_academic_channel_too(self):
        product = script("discover-product-pool").Product(self.academic_topic("product"), self.work, FakeFetch([("export.arxiv.org", ATOM)]))
        product.academic()
        self.assertEqual(sorted(product.pool.state["hits"]), ["lab/bench", "lab/tool"])


class ProductDiscoveryTest(Base):
    def test_npm_keeps_only_harness_packages_with_a_topic_term(self):
        objects = [{"package": {"name": "claude-tdd", "description": "claude hook", "links": {"repository": "https://github.com/o/keep"}}},
                   {"package": {"name": "tdd-only", "description": "no harness", "links": {"repository": "https://github.com/o/drop"}}},
                   {"package": {"name": "agent-guard", "description": "agent stops weakened tests", "links": {"repository": "https://github.com/o/extra"}}}]
        product = script("discover-product-pool").Product(self.topic, self.work, FakeFetch([("registry.npmjs.org", GQL({"objects": objects}))]))
        product.npm()
        self.assertEqual(sorted(product.pool.state["hits"]), ["o/extra", "o/keep"])

    def test_code_search_skips_agent_config_paths(self):
        items = [{"path": ".claude/hooks/x.ts", "repository": {"full_name": "o/config"}}, {"path": "src/hook.ts", "repository": {"full_name": "o/product"}}]
        product = script("discover-product-pool").Product(self.topic, self.work, FakeFetch([("search/code", GQL({"total_count": 2, "items": items}))]))
        product.code()
        self.assertEqual(list(product.pool.state["hits"]), ["o/product"])
        self.assertEqual(product.pool.state["log"][0]["query"], "hook_event_name tdd extension:ts")

    def test_repo_search_filters_on_relevance_and_topics_do_not(self):
        fetch = FakeFetch([("search repos tdd hook", GQL([{"fullName": "o/hit", "description": "claude tdd"}, {"fullName": "o/miss", "description": "web"}])),
                           ("--topic claude-code --topic tdd", GQL([{"fullName": "o/topic"}]))])
        product = script("discover-product-pool").Product(self.topic, self.work, fetch)
        product.repo()
        self.assertEqual(sorted(product.pool.state["hits"]), ["o/hit", "o/topic"])

    def test_reverse_reads_hook_commands_of_the_config_pool(self):
        write_json(self.work / "config-pool.json", {"rows": [{"repo": "o/cfg", "branch": "main"}]})
        write_json(self.work / "cache/trees/o__cfg.json", {"paths": ["hooks/hooks.json", "README.md"]})
        fetch = FakeFetch([("raw.githubusercontent.com/o/cfg/main/hooks/hooks.json", '{"command": "npx -y tdd-guard@1.2"}'),
                           ("registry.npmjs.org/tdd-guard", GQL({"description": "tdd guard", "repository": {"url": "git+https://github.com/o/guard.git"}}))])
        product = script("discover-product-pool").Product(self.topic, self.work, fetch)
        product.reverse()
        self.assertEqual(product.pool.state["hits"]["o/guard"]["channels"]["reverse"], ["npx tdd-guard in o/cfg/hooks/hooks.json"])
        self.assertEqual(len(fetch.called("README.md")), 0)

    def test_reverse_without_a_config_pool_says_what_to_run(self):
        product = script("discover-product-pool").Product(self.topic, self.work, FakeFetch())
        with self.assertRaisesRegex(TopicError, "run resolve-pool.py"):
            product.reverse()

    def test_social_hits_land_in_one_social_channel(self):
        product = script("discover-product-pool").Product(self.topic, self.work, FakeFetch([("twitter", "github.com/o/s")]))
        product.social()
        self.assertEqual(product.pool.state["hits"]["o/s"]["channels"], {"social": ['x "hook tdd"']})


class DevTopicChannelsTest(unittest.TestCase):
    def test_the_dev_topic_drives_every_discovery_step_without_errors(self):
        topic = load_topic(KIT, "dev")
        work = Path(tempfile.mkdtemp(prefix="study-dev-"))
        self.addCleanup(shutil.rmtree, work)
        fetch = FakeFetch()
        script("discover-config-pool").discover(topic, work, work, fetch)
        product = script("discover-product-pool").Product(topic, work, fetch)
        for channel in ("npm", "social", "code", "repo"):
            getattr(product, channel)()
        self.assertEqual(len(fetch.called("search repos")), 15 + 7 + 5 + 15 + 30)
        self.assertEqual(len(fetch.called("search/code")), 8 + 3 * 6 * 8)
        self.assertEqual(len(fetch.called("registry.npmjs.org")), 23)


class LocalInventoryTest(Base):
    def test_installed_assets_are_tagged_by_term_and_carry_no_text(self):
        skill = self.home / ".claude/skills/tdd-coach/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: tdd-coach\ndescription: proprietary words about tests\nlicense: Proprietary\n---\nbody\n")
        other = self.home / ".claude/skills/docs/SKILL.md"
        other.parent.mkdir(parents=True)
        other.write_text("---\nname: docs\ndescription: writes docs\n---\n")
        root = self.home / ".claude/plugins/cache/p/1.0"
        (root / "agents").mkdir(parents=True)
        (root / "agents/qa.md").write_text("---\ndescription: runs the test suite\n---\n")
        write_json(self.home / ".claude/plugins/installed_plugins.json", {"plugins": {"p@m": [{"installPath": str(root), "version": "1.0", "gitCommitSha": "abc"}]}})
        write_json(self.home / ".claude/plugins/marketplaces/m/.claude-plugin/marketplace.json", {"plugins": [{"name": "t", "description": "tdd kit", "source": {"repo": "o/t"}}]})
        rows = script("discover-local-inventory").inventory(self.topic, self.home)
        self.assertEqual([(r["kind"], r["name"], r["matched_terms"]) for r in rows],
                         [("user-skill", "tdd-coach", ["tdd"]), ("plugin-agent", "p@m:qa", ["test"]), ("marketplace-plugin", "t@m", ["tdd"])])
        self.assertEqual(rows[0]["path"], "~/.claude/skills/tdd-coach/SKILL.md")
        self.assertEqual(rows[2]["url"], "https://github.com/o/t")
        self.assertNotIn("proprietary words", json.dumps(rows))

    def test_a_topic_without_a_local_stratum_is_refused(self):
        topic = load_topic(self.repo, "demo")
        topic["strata"].pop("local")
        with self.assertRaisesRegex(TopicError, "no local stratum"):
            script("discover-local-inventory").inventory(topic, self.home)


class ResolveAndTreesTest(Base):
    def info(self, name, archived=False):
        return {"nameWithOwner": name, "description": "d", "createdAt": "2026-01-01T00:00:00Z", "pushedAt": "2026-09-01T00:00:00Z", "stargazerCount": 9,
                "isArchived": archived, "isFork": False, "licenseInfo": {"spdxId": "MIT"}, "defaultBranchRef": {"name": "main", "target": {"oid": "f" * 40}},
                "issues": {"totalCount": 1}, "pullRequests": {"totalCount": 2}}

    def test_hits_resolve_to_canonical_repositories_with_a_pinned_head(self):
        pool = Pool(self.work / "config-state.json")
        pool.add("O", "A", "x", "e1")
        pool.add("o", "gone", "x", "e2")
        pool.record("s", "x", "q", "ok", 0, 0, 0, 0)
        snow = Pool(self.work / "snowball-state.json")
        snow.add("o", "a-renamed", "snowball", "e3")
        snow.record("s", "snowball", "q", "ok", 0, 0, 0, 0)
        fetch = FakeFetch([("graphql", GQL({"data": {"r0": self.info("o/A"), "r1": None, "r2": self.info("o/A", archived=False)}}))])
        from datetime import datetime, timezone
        rows, prisma = script("resolve-pool").resolve(self.work, ["config", "snowball"], fetch, datetime(2026, 10, 1, tzinfo=timezone.utc))
        self.assertEqual([(r["repo"], r["oid"], r["channels"]) for r in rows], [("o/A", "f" * 40, ["snowball", "x"])])
        self.assertEqual(prisma, {"identified": 3, "not_resolvable": 1, "unresolved_batches": 0, "resolved": 1, "archived": 0, "forks": 0})
        self.assertEqual(rows[0]["impact"], 3.3)

    def test_a_failed_graphql_batch_is_counted(self):
        pool = Pool(self.work / "config-state.json")
        pool.add("o", "a", "x", "e")
        pool.record("s", "x", "q", "ok", 0, 0, 0, 0)
        rows, prisma = script("resolve-pool").resolve(self.work, ["config"], FakeFetch([("graphql", ("", "exit 1: bad"))]), None)
        self.assertEqual((rows, prisma["unresolved_batches"], prisma["not_resolvable"]), ([], 1, 1))

    def test_trees_are_fetched_at_the_pinned_commit_and_errors_are_cached(self):
        write_json(self.work / "config-pool.json", {"rows": [{"repo": "o/a", "oid": "f" * 40, "archived": False, "fork": False},
                                                             {"repo": "o/b", "branch": "main", "archived": False, "fork": False},
                                                             {"repo": "o/old", "archived": True, "fork": False}]})
        tree = {"truncated": False, "tree": [{"path": "skills/tdd/SKILL.md", "type": "blob", "sha": "1"}, {"path": "src/x.js", "type": "blob", "sha": "2"}]}
        fetch = FakeFetch([("repos/o/a/git/trees/" + "f" * 40, GQL(tree)), ("repos/o/b/git/trees/main", ("", "exit 1: 404"))])
        self.assertEqual(script("fetch-repo-trees").fetch_trees(self.work, "config", fetch), (1, 1))
        self.assertEqual(json.loads((self.work / "cache/asset-shas/o__a.json").read_text())["shas"], {"skills/tdd/SKILL.md": "1"})
        self.assertIn("error", json.loads((self.work / "cache/trees/o__b.json").read_text()))
        self.assertEqual(script("fetch-repo-trees").fetch_trees(self.work, "config", FakeFetch()), (0, 0))


if __name__ == "__main__":
    unittest.main()
