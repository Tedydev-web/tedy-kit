import json
import unittest

from study_fixtures import FakeFetch, script, write_json
from study_topic import load_topic
from test_discovery import GQL, Base

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


if __name__ == "__main__":
    unittest.main()
