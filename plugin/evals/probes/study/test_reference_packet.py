import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from study_calibration_set import EXCLUDE_CODES, LABELLED
from study_fixtures import FakeFetch, script, write_json, write_jsonl
from study_reference_packet import BUNDLE_FILE, EXCLUDE_GLOSSES, ROW_CAP, build_packets, inputs_name, write_bundle
from study_session import canonical_sha256
from study_topic import TopicError, load_topic
from study_v4_fixture import CRITERIA, PROBLEMS, v4_repo

SHA = "a" * 40
OTHER = "b" * 40
ELIGIBILITY = "A mechanism is an enforced or checkable step for a listed problem."
NOT_FOUND = ("", "exit 1: gh: Not Found (HTTP 404)")
SERVER = ("", "exit 1: gh: Server Error (HTTP 502)")
ESCAPES = ("", "exit 1: the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway")


def text_size(text):
    return len(json.dumps(text, ensure_ascii=False).encode()) - 2


def row_size(row):
    return len(json.dumps(row, ensure_ascii=False).encode())


def held_row(rank, repo, sha=SHA):
    return {"order_rank": rank, "repo": repo, "facts": {"stars": 5, "pushed": "2026-10-01", "description": "a kit"}, "sha": sha, "listing": ["README.md"], "readme": "short",
            "files": [], "evidence": {"releases": {"count": 0, "latest": None, "published": None}, "tags": {"count": 2, "latest": "v1"}, "package": {}, "workflows": [],
                                      "tests": {"count": 0, "paths": []}}}


class ReferencePacketTest(unittest.TestCase):
    def setUp(self):
        self.repo = v4_repo()
        registry = "| Id | Problem | Area |\n|---|---|---|\n" + "".join(f"| {p} | statement of {p} | area |\n" for p in PROBLEMS)
        (self.repo / "docs/prior-art/problems-demo.md").write_text(registry)
        config = self.repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(config.read_text())
        config.write_text(json.dumps({**topic, "eligibility": {"vi": "-", "en": ELIGIBILITY}}))
        self.topic = load_topic(self.repo, "demo")
        self.work = Path(tempfile.mkdtemp(prefix="study-reference-"))
        self.addCleanup(shutil.rmtree, self.work)
        self.held = [held_row(7, "o/one"), held_row(9, "o/two")]
        write_jsonl(self.work / "config-screening-inputs.jsonl", self.held)
        rows = [{"id": f"calibration-config-{i}", "stratum": "config", "order_rank": h["order_rank"], "repo": h["repo"],
                 "commit": f"https://github.com/{h['repo']}/commit/{h['sha']}", "inputs_sha256": canonical_sha256(h), "qgs_sha256": "0" * 64}
                for i, h in enumerate(self.held, 1)]
        write_json(self.work / "calibration-set.json", {"sweep": self.topic["sweep"], "batch": "calibration", "criteria": CRITERIA, "rows_per_stratum": {"config": 2},
                                                        "rows": rows})
        self.tree("o/one", ["README.md"])
        self.tree("o/two", ["README.md"])

    def tree(self, repo, paths, oid=SHA):
        write_json(self.work / "cache/trees" / (repo.replace("/", "__") + ".json"), {"oid": oid, "truncated": False, "paths": paths})

    def build(self, fetch, **options):
        return build_packets(self.topic, self.repo, self.work, "config", fetch, **(options or {"batch": "calibration"}))

    def rows(self):
        return {r["order_rank"]: r for r in map(json.loads, (self.work / inputs_name("config")).read_text().splitlines())}

    def files(self, repo, contents):
        return [(f"repos/{repo}/contents/{path}?ref={SHA}", text) for path, text in contents.items()]

    def test_each_part_keeps_its_cap(self):
        assets = {f"skills/s{i:02}/SKILL.md": f"skill {i}\n" for i in range(11)} | {"AGENTS.md": "agents\n", "commands/zz.md": "z", "skills/s00/SKILL.md": "é\"" * 3500}
        tests = {f"tests/test_{i:02}.py": "".join(f"line {n}\n" for n in range(60)) for i in range(11)} | {"tests/a_test.py": "w" * 3000}
        manifests = {"package.json": "p" * 3000, "pyproject.toml": "q" * 10, "go.mod": "g"}
        paths = ["README.md", "CHANGELOG.md", "docs", "docs/guide.md", "src/app.py", *assets, *tests, *manifests]
        self.tree("o/one", sorted(paths))
        self.build(FakeFetch(self.files("o/one", {"README.md": "r" * 40000, "CHANGELOG.md": "c" * 5000, **assets, **tests, **manifests})))
        row = self.rows()[7]
        self.assertEqual(text_size(row["readme"]), 32000)
        self.assertEqual(row["truncated"]["readme"], {"before": 40000, "after": 32000})
        self.assertEqual([a["path"] for a in row["assets"]][:2], ["AGENTS.md", "skills/s00/SKILL.md"])
        self.assertEqual(len(row["assets"]), 10)
        self.assertEqual(text_size(row["assets"][1]["text"]), 6000)
        self.assertEqual(row["truncated"]["assets:skills/s00/SKILL.md"], {"before": 14000, "after": 6000})
        self.assertEqual(len(row["tests"]), 10)
        self.assertEqual([t["path"] for t in row["tests"]][:2], ["tests/a_test.py", "tests/test_00.py"])
        self.assertEqual(text_size(row["tests"][0]["text"]), 1000)
        self.assertEqual(row["tests"][1]["text"], "".join(f"line {n}\n" for n in range(40)))
        self.assertEqual(text_size(row["changelog"]), 4000)
        self.assertEqual([(m["path"], text_size(m["text"])) for m in row["manifests"]], [("package.json", 2000), ("pyproject.toml", 10)])
        self.assertEqual(row["tree"][:2], ["AGENTS.md", "commands/zz.md"])
        self.assertNotIn("docs", row["tree"][:len(assets) + len(tests) + 1])
        self.assertLess(row["tree"].index("docs/guide.md"), row["tree"].index("src/app.py"))
        self.assertEqual(row["prefilled"], {"released": True, "changelog": "CHANGELOG.md", "paid_tier_cues": []})
        self.assertEqual({k: row[k] for k in ("order_rank", "repo", "sha", "facts", "evidence")}, {k: self.held[0][k] for k in ("order_rank", "repo", "sha", "facts", "evidence")})

    def test_a_huge_tree_is_trimmed_first_and_the_readme_only_when_still_over(self):
        assets = {f"skills/s{i}/SKILL.md": "x" * 7000 for i in range(10)}
        tests = {f"tests/test_{i}.py": "t" * 1000 for i in range(10)}
        tree = ["README.md", "CHANGELOG.md", *assets, *tests] + [f"src/module_{i:05}/implementation_file_{i:05}.py" for i in range(60000)]
        self.tree("o/one", sorted(tree))
        self.tree("o/two", sorted(tree))
        self.build(FakeFetch(self.files("o/one", {"README.md": "r" * 40000, "CHANGELOG.md": "c" * 4000, **assets, **tests}) + self.files("o/two", {"README.md": "r" * 40000})))
        row = self.rows()[7]
        self.assertEqual(len(row["tree"]), 100)
        self.assertEqual(row["tree"][:20], sorted(assets) + sorted(tests))
        self.assertEqual(row["truncated"]["tree"]["after"], row_size(row["tree"]))
        self.assertEqual(text_size(row["readme"]), 8000)
        self.assertEqual(row["truncated"]["readme"], {"before": 40000, "after": 8000})
        self.assertEqual([text_size(a["text"]) for a in row["assets"]], [6000] * 10)
        self.assertLessEqual(row_size(row), ROW_CAP)
        small = self.rows()[9]
        self.assertEqual((len(small["tree"]), text_size(small["readme"])), (100, 32000))

    def test_assets_are_never_trimmed(self):
        self.tree("o/one", sorted(["README.md"] + [f"agents/a{i}.md" for i in range(10)] + [f"lib/deep/path/number_{i:05}.ts" for i in range(5000)]))
        self.build(FakeFetch(self.files("o/one", {"README.md": "r" * 40000, **{f"agents/a{i}.md": "a" * 6000 for i in range(10)}})))
        row = self.rows()[7]
        self.assertEqual([(a["path"], len(a["text"])) for a in row["assets"]], [(f"agents/a{i}.md", 6000) for i in range(10)])
        self.assertNotIn("assets", " ".join(row["truncated"]))

    def test_the_worst_case_stays_within_the_cap(self):
        nasty = ("x" * 60 + '"\\é\n') * 400
        assets = {f"skills/s{i:02}/SKILL.md": nasty for i in range(12)}
        tests = {f"tests/t{i:02}.py": nasty for i in range(12)}
        manifests = {name: "enterprise pricing\n" + nasty for name in ("package.json", "pyproject.toml", "Cargo.toml")}
        tree = sorted(["README.md", "CHANGELOG.md", *assets, *tests, *manifests] + [f"src/pkg/module_{i:06}/file.py" for i in range(50000)])
        self.held[0]["evidence"] |= {"owner_top_repos": [{"name": "n" * 30, "stars": 9, "description": "d" * 160} for _ in range(10)],
                                     "changelog_head": nasty[:1500], "workflows": [f"workflow-{i}.yml" for i in range(10)],
                                     "tests": {"count": 900, "paths": [f"tests/unit/{i}/test_case.py" for i in range(30)]}}
        write_jsonl(self.work / "config-screening-inputs.jsonl", self.held)
        readme = "".join(f"Our enterprise plan and pricing line {i}\n" for i in range(3)) + nasty * 10
        self.tree("o/one", tree)
        self.build(FakeFetch(self.files("o/one", {"README.md": readme, "CHANGELOG.md": nasty, **assets, **tests, **manifests})), purpose="stage1-flags", ranks=[7])
        row = self.rows()[7]
        self.assertGreater(row_size(self.held[0]["evidence"]), 5000)
        self.assertEqual([text_size(a["text"]) for a in row["assets"]], [6000] * 10)
        self.assertEqual((len(row["tree"]), text_size(row["readme"])), (100, 8000))
        self.assertLessEqual(row_size(row), ROW_CAP)
        self.assertEqual(row["prefilled"]["paid_tier_cues"], [f"README.md:{i + 1}: Our enterprise plan and pricing line {i}" for i in range(3)]
                         + ["package.json:1: enterprise pricing", "pyproject.toml:1: enterprise pricing"])

    def test_a_row_still_over_the_cap_after_both_trims_is_refused(self):
        self.held[0]["evidence"]["owner_top_repos"] = [{"name": "n", "stars": 1, "description": "d" * 120000}]
        write_jsonl(self.work / "config-screening-inputs.jsonl", self.held)
        with self.assertRaisesRegex(TopicError, "over the 100000-byte cap after both trims"):
            self.build(FakeFetch(), purpose="stage1-flags", ranks=[7])
        self.assertFalse((self.work / inputs_name("config")).exists())

    def test_a_tree_pinned_at_another_commit_is_refused(self):
        self.tree("o/two", ["README.md"], oid=OTHER)
        with self.assertRaisesRegex(TopicError, f"rank 9 .*{OTHER}.*{SHA}"):
            self.build(FakeFetch())
        self.assertEqual(sorted(self.rows()), [7])

    def test_the_bundle_holds_every_part_and_its_hash_is_stable(self):
        first = write_bundle(self.repo, self.topic, self.work, CRITERIA)
        text = (self.work / BUNDLE_FILE).read_text()
        self.assertEqual(first, hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(write_bundle(self.repo, self.topic, self.work, CRITERIA), first)
        criteria = (self.repo / CRITERIA).read_text()
        section = criteria[criteria.index("## GitHub assets"):].split("\n## ", 1)[0].strip()
        aggregators = next(p for p in criteria.split("\n\n") if p.startswith("**Aggregators.**"))
        for part in (ELIGIBILITY, section, aggregators, *(f"{p}: statement of {p}" for p in PROBLEMS), "alpha (X1, X2): tdd, test", "beta (X3, X4): guard, lint",
                     *(f"{code}: {gloss}" for code, gloss in EXCLUDE_GLOSSES.items()), "Novelty is 1 for a row with at least one mechanism",
                     "excluded: copy, excluded: dead or excluded: aggregator", *LABELLED):
            self.assertIn(part, text)
        self.assertEqual(set(EXCLUDE_GLOSSES), set(EXCLUDE_CODES))

    def test_the_bundle_refuses_a_registry_without_a_topic_problem(self):
        (self.repo / "docs/prior-art/problems-demo.md").write_text("| X1 | only one |\n")
        with self.assertRaisesRegex(TopicError, r"no row for \['X2', 'X3', 'X4'\]"):
            write_bundle(self.repo, self.topic, self.work, CRITERIA)

    def test_a_missing_file_goes_to_missing_and_a_transient_error_is_refused(self):
        self.tree("o/one", ["README.md", "AGENTS.md", "tests/test_gone.py", "assets/logo.png"])
        self.build(FakeFetch([(f"repos/o/one/contents/tests/test_gone.py?ref={SHA}", NOT_FOUND), *self.files("o/one", {"AGENTS.md": "agents", "README.md": "readme"})]))
        row = self.rows()[7]
        self.assertEqual(row["missing"], ["tests/test_gone.py: exit 1: gh: Not Found (HTTP 404)"])
        self.assertEqual((row["readme"], row["tests"], [a["path"] for a in row["assets"]]), ("readme", [], ["AGENTS.md"]))
        (self.work / inputs_name("config")).unlink()
        self.build(FakeFetch([(f"repos/o/one/contents/tests/test_gone.py?ref={SHA}", ESCAPES)]))
        self.assertEqual(self.rows()[7]["missing"], [f"tests/test_gone.py: {ESCAPES[1]}"])
        (self.work / inputs_name("config")).unlink()
        with self.assertRaisesRegex(TopicError, "AGENTS.md: exit 1: gh: Server Error"):
            self.build(FakeFetch([(f"repos/o/one/contents/AGENTS.md?ref={SHA}", SERVER)]))

    def test_rows_already_built_at_the_pinned_commit_are_kept(self):
        self.build(FakeFetch())
        again = FakeFetch()
        self.assertEqual(self.build(again), {"built": 0, "kept": 2, "trimmed": 0})
        self.assertEqual(again.calls, [])

    def test_a_purpose_row_needs_screening_inputs_without_an_error(self):
        write_jsonl(self.work / "config-screening-order.jsonl", [{"order_rank": 7, "repo": "o/one"}])
        with self.assertRaisesRegex(TopicError, "rank 50 has no screening inputs"):
            self.build(FakeFetch(), purpose="exclusion-audit", ranks=[50])
        write_jsonl(self.work / "config-screening-inputs.jsonl", [{**self.held[0], "error": "tree: exit 1", "error_kind": "transient"}])
        with self.assertRaisesRegex(TopicError, "rank 7 holds the fetch error tree: exit 1"):
            self.build(FakeFetch(), purpose="exclusion-audit", ranks=[7])

    def test_the_command_line_builds_a_batch_and_refuses_a_purpose_without_ranks(self):
        main = script("build-reference-packets").main
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--batch", "calibration"], fetch=FakeFetch())
        self.assertIn(f"{inputs_name('config')}: 2 rows built, 0 kept, 0 trimmed", out.getvalue())
        self.assertIn(f"{BUNDLE_FILE}: sha256 ", out.getvalue())
        with self.assertRaisesRegex(SystemExit, "--purpose needs --ranks"):
            main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--purpose", "adjudication"], fetch=FakeFetch())
        with self.assertRaisesRegex(SystemExit, "no top-up-set.json"):
            main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--stratum", "config", "--batch", "top-up"], fetch=FakeFetch())


if __name__ == "__main__":
    unittest.main()
