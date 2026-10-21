import fcntl
import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from study_calibration_set import EXCLUDE_CODES, LABELLED
from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_reference_labels import cite_holds
from study_session import MAX_PROMPT, canonical_sha256, session_folder
from study_session_prompt import REFERENCE_REPLY_FORMAT, REFERENCE_ROWS_NOTE, REFERENCE_TEMPLATE_SHA256, build_reference_prompt, reference_prompt_parts
from study_session_reply import REFERENCE_CODES, REFERENCE_CRITERIA, parse_reference_reply
from study_stage1 import LADDER
from study_topic import TopicError, flaggers, load_topic, reference_option
from test_sessions import SessionBase, agy_reply, claude_reply, reply_row

KIT = Path(__file__).resolve().parents[4]
SHA = "c" * 40
REFERENCE = {"cli": "claude", "model": "claude-fable-5-1", "effort": "max"}
LADDER_MODELS = [m for rung in LADDER for m in rung["models"]]
MCP_LIST = "NAME          TYPE   STATUS   COMMAND/URL\ncontext-mode  stdio  enabled  context-mode\n"
PLUGIN_LIST = "Installed plugins:\n- ponytail (enabled, 4.10.3)\n    Source:     antigravity\n"


def cell(value=1, cite="path:hooks/gate.sh"):
    return {"v": value, "cite": cite}


def label(rank, repo, **change):
    row = {"order_rank": rank, "repo": repo, "scores": {c: cell() for c in REFERENCE_CRITERIA},
           "mechanisms": [{"problem": "X1", "path": "hooks/gate.sh", "why": "the hook blocks a commit without a test"}], "decision": "eligible",
           "decision_cite": "path:hooks/gate.sh"}
    return json.dumps({**row, **change})


def fable(text, models=("claude-fable-5-1",), turns=1, denials=(), cost=0.42):
    body = {"type": "result", "is_error": False, "num_turns": turns, "permission_denials": list(denials), "result": text, "modelUsage": {m: {} for m in models},
            "usage": {"input_tokens": 25000, "output_tokens": 9500}, "duration_ms": 61000}
    return json.dumps({**body, **({"total_cost_usd": cost} if cost is not None else {})})


def needle(rank):
    return f'"order_rank": {rank}, "repo"'


class Recorder(FakeFetch):
    def __init__(self, rules=()):
        super().__init__(rules)
        self.argvs, self.folders = [], []

    def run(self, cmd, timeout=180, cwd=None):
        if cwd:
            self.argvs.append(list(cmd))
            self.folders.append((cwd, sorted(p.name for p in Path(cwd).iterdir())))
        return super().run(cmd, timeout, cwd)


class ReferenceBase(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata={"config": {"stop_row": None, "forced_repos": [], "channels": {}}, "product": {"stop_row": None, "forced_repos": [], "channels": {}}})
        self.work = Path(tempfile.mkdtemp(prefix="study-reference-"))
        self.addCleanup(shutil.rmtree, self.work)
        self.addCleanup(shutil.rmtree, self.repo)
        self.write_topic()
        write_json(self.work / "calibration-set.json", {"rows": [{"stratum": "config", "order_rank": 1}, {"stratum": "product", "order_rank": 7}, {"stratum": "config", "order_rank": 2}]})
        write_jsonl(self.work / "reference-inputs-config.jsonl", [self.inputs(1, "o/one", "Pricing: the paid tier adds a gate.", released=True),
                                                                   self.inputs(2, "o/two", "write the failing test first")])
        (self.work / "reference-bundle.md").write_text("# anchors bundle\n\nAuthority 1: maintained by a known owner.\n")

    def inputs(self, rank, repo, readme, released=False):
        return {"order_rank": rank, "repo": repo, "sha": SHA, "facts": {"pushed": "2026-09-30"}, "evidence": {}, "readme": readme, "tree": ["README.md", "hooks/gate.sh"],
                "assets": [], "tests": [], "changelog": "", "manifests": [], "prefilled": {"released": released, "changelog": False, "paid_tier_cues": []}, "truncated": {}}

    def write_topic(self, **change):
        path = self.repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        write_json(path, {**topic, "problems": ["X1", "X2"], "sessions": {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"},
                                                                          "B": {"cli": "claude", "model": "claude-sonnet-5-5", "effort": "high"}},
                          "qgs_judges": {"A": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}, "B": {"cli": "claude", "model": "claude-sonnet-5-5", "effort": "high"}},
                          "reader": {"cli": "claude", "model": "claude-opus-5-5", "effort": "high"}, "cross_family": {"cli": "agy", "model": "gemini-3.8-flash-high"},
                          "reference": REFERENCE, **change})

    def judge(self, fetch, *args, judge="reference"):
        return script("run-judge").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), "--judge", judge, "--set", "reference", "--batch", "calibration",
                                         "--stratum", "config", *args, "--today", "2026-10-21"], fetch=fetch, which=lambda cli: True, environ={})

    def refused(self, fetch, *args, judge="reference"):
        with self.assertRaises(SystemExit) as raised:
            self.judge(fetch, *args, judge=judge)
        return str(raised.exception)

    def rows(self, name="reference-calibration-config"):
        path = self.work / f"{name}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def sessions(self):
        path = self.work / "meta.json"
        return json.loads(path.read_text()).get("sessions", {}) if path.is_file() else {}

    def ledger(self):
        path = self.work / "claude-spend-ledger.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def nothing_written(self):
        self.assertEqual((self.rows(), self.ledger()), ([], []))
        self.assertEqual(self.sessions().get("reference-calibration-config", {}).get("blocks", []), [])

    def only_spend_written(self, message, cost=0.42, turns=1, served=("claude-fable-5-1",)):
        [line] = self.ledger()
        self.assertIn(message, line["refused"])
        self.assertEqual((line["ranks"], line["total_cost_usd"], line["num_turns"], line["served_models"]), ([1], cost, turns, list(served) if served is not None else None))
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.sessions().get("reference-calibration-config", {}).get("blocks", []), [])


class ReferencePromptTest(unittest.TestCase):
    def test_the_prompt_holds_the_bundle_the_rubric_notes_one_row_and_the_reply_format(self):
        row = {"order_rank": 1, "repo": "o/one"}
        prompt = build_reference_prompt("# bundle\n", [], [row])
        self.assertEqual(prompt, "# bundle\n\n## Rows\n\n" + REFERENCE_ROWS_NOTE + "\n\n```json\n" + json.dumps(row) + "\n```\n\n" + REFERENCE_REPLY_FORMAT + "\n")
        noted = build_reference_prompt("# bundle\n", [{"line": 120, "quote": "A paid tier alone is not a vendor stance.", "criterion": "Objectivity", "cue": "objectivity:paid"}], [row])
        self.assertIn("# bundle\n\n## Rubric notes\n\n- line 120 (Objectivity): A paid tier alone is not a vendor stance.\n\n## Rows\n\n", noted)

    def test_the_worst_case_prompt_fits_the_prompt_limit_and_the_argv_limit(self):
        row = {"order_rank": 1, "repo": "o/one", "readme": ""}
        row["readme"] = "x" * (100_000 - len(json.dumps(row, ensure_ascii=False).encode()))
        self.assertEqual(len(json.dumps(row, ensure_ascii=False).encode()), 100_000)
        notes = [{"line": 100 + i, "quote": "q" * 300, "criterion": "Objectivity", "cue": "objectivity:paid"} for i in range(5)]
        size = len(build_reference_prompt("b" * 10_960, notes, [row]).encode())
        self.assertLess(size, MAX_PROMPT)
        self.assertLess(size, 131_072)
        shared, own = reference_prompt_parts("b" * 10_960, notes, [row])
        self.assertEqual(len(shared.encode()) + 2 + len(own.encode()), size)
        self.assertLess(max(len(shared.encode()), len(own.encode())), 131_072)

    def test_the_shared_part_is_everything_before_the_first_row_and_the_parts_join_to_the_prompt(self):
        notes = [{"line": 120, "quote": "A paid tier alone is not a vendor stance.", "criterion": "Objectivity", "cue": "objectivity:paid"}]
        for rows in ([{"order_rank": 1, "repo": "o/one"}], [{"order_rank": 2, "repo": "o/two", "readme": "other"}]):
            shared, own = reference_prompt_parts("# bundle\n", notes, rows)
            self.assertEqual(shared + "\n\n" + own, build_reference_prompt("# bundle\n", notes, rows))
            self.assertEqual(shared, "# bundle\n\n## Rubric notes\n\n- line 120 (Objectivity): A paid tier alone is not a vendor stance.\n\n## Rows\n\n" + REFERENCE_ROWS_NOTE)
            self.assertEqual(own, "```json\n" + json.dumps(rows[0]) + "\n```\n\n" + REFERENCE_REPLY_FORMAT + "\n")

    def test_the_template_sha_is_pinned_and_the_format_names_every_code_and_criterion(self):
        self.assertEqual(REFERENCE_TEMPLATE_SHA256, hashlib.sha256((REFERENCE_ROWS_NOTE + "\n\n" + REFERENCE_REPLY_FORMAT).encode()).hexdigest())
        self.assertEqual(REFERENCE_TEMPLATE_SHA256, "b81e03ba35967f04381cffb8f169e6553bc3976cd6c274775ff172325ed00196")
        self.assertEqual(set(REFERENCE_CODES), set(EXCLUDE_CODES))
        self.assertEqual(REFERENCE_CRITERIA, LABELLED)
        for word in (*REFERENCE_CODES, *REFERENCE_CRITERIA, "decision_cite", "path:", "readme:", "fact:"):
            self.assertIn(word, REFERENCE_REPLY_FORMAT)
        self.assertNotIn("Date", REFERENCE_REPLY_FORMAT)


    def test_a_fact_cite_is_the_full_dotted_path_from_the_row_root_with_examples_the_packet_holds(self):
        examples = re.findall(r"fact:([A-Za-z_]+(?:\.[A-Za-z_]+)+)", REFERENCE_REPLY_FORMAT)
        self.assertGreaterEqual(len(examples), 2)
        self.assertIn("evidence.changelog_head", examples)
        self.assertIn("full dotted path", REFERENCE_REPLY_FORMAT)
        packet = {"facts": {"pushed": "2026-09-30"}, "evidence": {"changelog_head": "## 1.0", "releases": {"count": 2}},
                  "prefilled": {"released": False, "changelog": "CHANGELOG.md", "paid_tier_cues": []}}
        for example in examples:
            self.assertTrue(cite_holds(f"fact:{example}", packet), example)
            self.assertFalse(cite_holds(f"fact:{example.split('.', 1)[1]}", packet), example)
        for key in ("facts", "evidence", "readme", "tree", "assets", "tests", "manifests", "changelog", "prefilled", "truncated"):
            self.assertIn(f"{key} (", REFERENCE_ROWS_NOTE)


class ReferenceReplyTest(unittest.TestCase):
    expected = {1: {"repo": "o/one", "sha": SHA}}

    def parse(self, **change):
        return parse_reference_reply(label(1, "o/one", **change), self.expected, ["X1", "X2"])

    def test_a_well_formed_row_keeps_the_contract_fields_and_the_pinned_sha(self):
        rows, problems = self.parse(note="dropped")
        self.assertEqual(problems, [])
        self.assertEqual(rows, [{"order_rank": 1, "repo": "o/one", "scores":{c: cell() for c in REFERENCE_CRITERIA},
                                 "mechanisms": [{"problem": "X1", "path": "hooks/gate.sh", "why": "the hook blocks a commit without a test"}], "decision": "eligible",
                                 "decision_cite": "path:hooks/gate.sh"}])

    def test_a_path_the_tree_lacks_is_left_to_the_citation_check(self):
        self.assertEqual(self.parse(decision_cite="path:not/in/the/tree.md")[1], [])

    def test_every_malformed_field_is_refused(self):
        scores = {c: cell() for c in REFERENCE_CRITERIA}
        cases = {"a bool score": {"scores": {**scores, "Authority": cell(True)}},
                 "a score of 2": {"scores": {**scores, "Authority": cell(2)}},
                 "a missing criterion": {"scores": {c: v for c, v in scores.items() if c != "Relevance"}},
                 "a Date cell": {"scores": {**scores, "Date": cell()}},
                 "an unknown cite kind": {"scores": {**scores, "Position": cell(1, "url:https://example.org")}},
                 "a README quote over 200 characters": {"scores": {**scores, "Position": cell(1, "readme:" + "x" * 201)}},
                 "an empty cite": {"scores": {**scores, "Position": cell(1, "path:")}},
                 "an unknown problem": {"mechanisms": [{"problem": "X9", "path": "hooks/gate.sh", "why": "w"}]},
                 "a mechanism without a path": {"mechanisms": [{"problem": "X1", "why": "w"}]},
                 "mechanism names": {"mechanisms": ["gate"]},
                 "an unknown exclude code": {"decision": "excluded: vendor"},
                 "the screening exclude form": {"decision": "exclude: copy"},
                 "no decision cite": {"decision_cite": None}}
        for case, change in cases.items():
            with self.subTest(case):
                rows, problems = self.parse(**change)
                self.assertEqual(rows, [])
                self.assertTrue(problems)
        self.assertEqual(parse_reference_reply(label(1, "o/other"), self.expected, ["X1"])[1], ["rank 1 names 'o/other', not o/one"])
        readme_200 = self.parse(scores={**scores, "Position": cell(1, "readme:" + "x" * 200)})
        self.assertEqual(readme_200[1], [])

    def test_a_missing_or_doubled_rank_is_refused(self):
        self.assertEqual(parse_reference_reply("", self.expected, ["X1"])[1], ["rank 1 missing from the reply"])
        doubled = label(1, "o/one") + "\n" + label(1, "o/one")
        self.assertEqual(parse_reference_reply(doubled, self.expected, ["X1"])[1], ["rank 1 appears twice"])
        self.assertEqual(parse_reference_reply(label(3, "o/three"), self.expected, ["X1"])[1], ["row 3 was not asked for", "rank 1 missing from the reply"])


class ReferenceTopicTest(ReferenceBase):
    def topic(self):
        return load_topic(self.repo, "demo")

    def test_the_reference_is_never_a_roster_or_ladder_model(self):
        self.assertEqual(reference_option(self.topic(), LADDER_MODELS), REFERENCE)
        for model, role in (("claude-opus-5-5", "sessions.A, qgs_judges.A, reader, the stage-1 ladder"),("gemini-3.8-flash-high", "cross_family")):
            with self.subTest(model):
                self.write_topic(reference={"cli": "claude" if model.startswith("claude") else "agy", "model": model})
                with self.assertRaisesRegex(TopicError, f"reference {model} is also {role}; the reference is never a judge, a stage-1 model or a replacement"):
                    reference_option(self.topic(), LADDER_MODELS)
        self.write_topic(reference={"cli": "claude", "model": "claude-haiku-5-5"})
        self.assertEqual(reference_option(self.topic()), {"cli": "claude", "model": "claude-haiku-5-5"})
        with self.assertRaisesRegex(TopicError, "reference claude-haiku-5-5 is also the stage-1 ladder"):
            reference_option(self.topic(), ["claude-haiku-5-5"])
        self.write_topic(reference={"cli": "claude"})
        with self.assertRaisesRegex(TopicError, "reference needs a cli"):
            reference_option(self.topic())

    def test_a_topic_without_a_reference_has_none(self):
        topic = self.topic()
        del topic["reference"]
        self.assertIsNone(reference_option(topic, LADDER_MODELS))

    def test_flaggers_default_by_role_and_are_validated(self):
        self.assertEqual(flaggers(self.topic()), {"rubric_trigger": [{"cli": "agy", "model": "gemini-3.8-flash-high"}],
                                                  "record_only": [{"cli": "agy", "model": "gpt-oss-120b-medium"}]})
        self.write_topic(rubric_trigger_flaggers=[{"cli": "agy", "model": "gemini-3.8-flash-high"}, {"cli": "agy", "model": "gpt-oss-120b-medium"}], record_only_flaggers=[])
        self.assertEqual(flaggers(self.topic())["record_only"], [])
        cases = {"listed twice; a flagger has one role": {"record_only_flaggers": [{"cli": "agy", "model": "gemini-3.8-flash-high"}]},
                 "is the reference; a flagger labels blind of it": {"record_only_flaggers": [REFERENCE]},
                 "record_only_flaggers must be a list": {"record_only_flaggers": {"cli": "agy", "model": "gpt-oss-120b-medium"}},
                 r"agy takes no effort": {"record_only_flaggers": [{"cli": "agy", "model": "gpt-oss-120b-medium", "effort": "high"}]}}
        for message, change in cases.items():
            with self.subTest(message):
                self.write_topic(**change)
                with self.assertRaisesRegex(TopicError, message):
                    flaggers(self.topic())

    def test_the_canon_topic_names_its_reference_and_both_flagger_roles(self):
        topic = load_topic(KIT, "canon")
        self.assertEqual(reference_option(topic, LADDER_MODELS), REFERENCE)
        self.assertEqual(flaggers(topic), {"rubric_trigger": [{"cli": "agy", "model": "gemini-3.8-flash-high"}], "record_only": [{"cli": "agy", "model": "gpt-oss-120b-medium"}]})
        self.assertEqual(json.loads((KIT / "docs/prior-art/topics/canon.json").read_text())["rubric_trigger_flaggers"], [{"cli": "agy", "model": "gemini-3.8-flash-high"}])


class ReferenceRunTest(ReferenceBase):
    def test_the_reference_labels_the_batch_rows_of_the_stratum_one_row_per_isolated_block(self):
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one"))), (needle(2), fable(label(2, "o/two"), cost=None))])
        self.judge(fetch)
        calls = fetch.called("claude -p")
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(c.startswith("claude -p --model claude-fable-5-1 --effort max --output-format json --tools  --setting-sources  ") for c in calls))
        self.assertEqual([r["order_rank"] for r in self.rows()], [1, 2])
        self.assertEqual(list(self.rows()[0]), ["order_rank", "repo", "scores", "mechanisms", "decision", "decision_cite"])
        inputs = [json.loads(line) for line in (self.work / "reference-inputs-config.jsonl").read_text().splitlines()]
        entry = self.sessions()["reference-calibration-config"]
        self.assertEqual((entry["cli"], entry["model"], entry["effort"], entry["threats"]), ("claude", "claude-fable-5-1", "max", []))
        bundle = hashlib.sha256((self.work / "reference-bundle.md").read_bytes()).hexdigest()
        self.assertEqual([(b["ranks"], b["packet_sha256"], b["template_sha256"]) for b in entry["blocks"]], [([1], bundle, REFERENCE_TEMPLATE_SHA256), ([2], bundle, REFERENCE_TEMPLATE_SHA256)])
        self.assertNotIn("criteria_sha256", entry["blocks"][0])
        self.assertNotIn("notes_sha256", entry["blocks"][0])
        self.assertEqual([b["row_sha256"] for b in entry["blocks"]], [{"1": canonical_sha256(inputs[0])}, {"2": canonical_sha256(inputs[1])}])
        prompt = (self.work / "prompts/reference-calibration-config-1-1.md").read_text()
        self.assertTrue(prompt.startswith("# anchors bundle\n"))
        self.assertIn('"order_rank": 1, "repo": "o/one"', prompt)
        self.assertNotIn('"order_rank": 2,', prompt)
        self.assertTrue(prompt.endswith(REFERENCE_REPLY_FORMAT + "\n"))
        self.assertNotIn("Date", json.dumps(self.rows()[0]["scores"]))

    def test_one_ledger_line_per_reference_block_with_a_missing_cost_as_null(self):
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one"))), (needle(2), fable(label(2, "o/two"), cost=None))])
        self.judge(fetch)
        prompts = [len((self.work / f"prompts/reference-calibration-config-{r}-{r}.md").read_bytes()) for r in (1, 2)]
        self.assertEqual(self.ledger(), [{"date": "2026-10-21", "key": "reference-calibration-config", "ranks": [r], "model": "claude-fable-5-1", "effort": "max",
                                          "total_cost_usd": cost, "usage": {"input_tokens": 25000, "output_tokens": 9500}, "duration_ms": 61000, "num_turns": 1,
                                          "served_models": ["claude-fable-5-1"], "prompt_bytes": size}
                                         for r, cost, size in ((1, 0.42, prompts[0]), (2, None, prompts[1]))])

    def test_a_resumed_run_skips_the_ranks_already_labelled(self):
        with self.assertRaises(SystemExit):
            self.judge(FakeFetch([(needle(1), fable(label(1, "o/one"))), (needle(2), ("", "exit 1: rate limited"))]))
        self.assertEqual([r["order_rank"] for r in self.rows()], [1])
        fetch = FakeFetch([(needle(2), fable(label(2, "o/two")))])
        self.judge(fetch)
        self.assertEqual(len(fetch.called("claude -p")), 1)
        self.assertEqual([r["order_rank"] for r in self.rows()], [1, 2])
        self.assertEqual([(line["ranks"], line.get("refused"), line["total_cost_usd"]) for line in self.ledger()],
                         [([1], None, 0.42), ([2], "claude claude-fable-5-1: exit 1: rate limited", None), ([2], None, 0.42)])

    def test_a_prompt_over_the_limit_is_refused_before_any_session(self):
        write_jsonl(self.work / "reference-inputs-config.jsonl", [self.inputs(1, "o/one", "x" * MAX_PROMPT), self.inputs(2, "o/two", "short")])
        fetch = FakeFetch([("claude -p", fable(label(1, "o/one")))])
        self.assertIn(f"over {MAX_PROMPT}; run a smaller block", self.refused(fetch))
        self.assertEqual(fetch.called("claude -p"), [])
        self.nothing_written()

    def test_a_reply_with_two_turns_a_denial_or_another_served_model_is_refused_with_only_its_spend_written(self):
        cases = {"2 turns": (fable(label(1, "o/one"), turns=2), 2, ["claude-fable-5-1"]),
                 "permission denials ['Bash']": (fable(label(1, "o/one"), denials=["Bash"]), 1, ["claude-fable-5-1"]),
                 "served ['claude-fable-5-1', 'claude-haiku-5-5']": (fable(label(1, "o/one"), models=("claude-fable-5-1", "claude-haiku-5-5")), 1,
                                                                    ["claude-fable-5-1", "claude-haiku-5-5"])}
        for message, (reply, turns, served) in cases.items():
            with self.subTest(message):
                (self.work / "claude-spend-ledger.jsonl").unlink(missing_ok=True)
                self.assertIn(message, self.refused(FakeFetch([("claude -p", reply)]), "--rows", "1-1"))
                self.only_spend_written(message, turns=turns, served=served)

    def test_a_reply_that_is_not_json_is_refused_with_a_null_spend_line(self):
        self.assertIn("reply is not JSON", self.refused(FakeFetch([("claude -p", "Error: overloaded")]), "--rows", "1-1"))
        self.only_spend_written("reply is not JSON", cost=None, turns=None, served=None)

    def test_a_session_that_leaves_a_file_behind_is_refused(self):
        class Writer(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                if cwd:
                    (Path(cwd) / "notes.txt").write_text("x")
                return super().run(cmd, timeout, cwd)

        self.assertIn("wrote ['notes.txt']", self.refused(Writer([("claude -p", fable(label(1, "o/one")))]), "--rows", "1-1"))
        self.only_spend_written("wrote ['notes.txt']")

    def test_a_block_whose_record_fails_still_logs_its_spend(self):
        work = self.work

        class Corrupter(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                if cwd:
                    (work / "meta.json").write_text("{")
                return super().run(cmd, timeout, cwd)

        with self.assertRaises(ValueError):
            self.judge(Corrupter([("claude -p", fable(label(1, "o/one")))]), "--rows", "1-1")
        self.assertEqual(self.rows(), [])
        [line] = self.ledger()
        self.assertEqual((line["ranks"], line["total_cost_usd"], line["num_turns"]), ([1], 0.42, 1))
        self.assertIn("the block was not recorded", line["refused"])

    def test_two_rows_send_a_byte_identical_system_part_from_one_fixed_empty_folder(self):
        folder = session_folder(self.work, "reference-calibration-config")
        folder.mkdir(exist_ok=True)
        (folder / "stale.txt").write_text("left by a killed run")
        self.addCleanup(shutil.rmtree, folder, True)
        fetch = Recorder([(needle(1), fable(label(1, "o/one"))), (needle(2), fable(label(2, "o/two")))])
        self.judge(fetch)
        first, second = fetch.argvs
        head = first[:first.index("--")]
        self.assertEqual(head, second[:second.index("--")])
        inputs = [json.loads(line) for line in (self.work / "reference-inputs-config.jsonl").read_text().splitlines()]
        bundle = (self.work / "reference-bundle.md").read_text()
        shared = reference_prompt_parts(bundle, [], inputs[:1])[0]
        self.assertEqual(shared, reference_prompt_parts(bundle, [], inputs[1:])[0])
        self.assertEqual(head[-3:], ["--exclude-dynamic-system-prompt-sections", "--append-system-prompt", shared])
        self.assertEqual([first[-1], second[-1]], [reference_prompt_parts(bundle, [], [row])[1] for row in inputs])
        self.assertEqual((self.work / "prompts/reference-calibration-config-1-1.md").read_text(), shared + "\n\n" + first[-1])
        self.assertEqual(fetch.folders, [(str(folder), [])] * 2)
        self.assertFalse(folder.exists())
        isolation = self.sessions()["reference-calibration-config"]["isolation"]
        self.assertIn("--max-turns 1 --exclude-dynamic-system-prompt-sections --append-system-prompt <everything before the first row>; "
                      "a fixed empty working folder per session key, emptied before each call; stdin closed", isolation)

    def test_a_second_run_of_the_same_key_is_refused_while_the_first_holds_the_folder(self):
        folder = session_folder(self.work, "reference-calibration-config")
        with open(self.work / "reference-calibration-config.session.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            fetch = FakeFetch([("claude -p", fable(label(1, "o/one")))])
            self.assertIn(f"another session holds {folder}", self.refused(fetch, "--rows", "1-1"))
        self.assertEqual(fetch.called("claude -p"), [])
        self.nothing_written()

    def test_a_malformed_row_is_kept_in_prompts_and_refused(self):
        bad = label(1, "o/one", decision="excluded: vendor")
        message = self.refused(FakeFetch([("claude -p", fable(bad))]), "--rows", "1-1")
        self.assertIn("reply kept in prompts/reference-calibration-config-1-1.response.txt, no row written", message)
        self.assertEqual((self.work / "prompts/reference-calibration-config-1-1.response.txt").read_text(), bad)
        self.only_spend_written("rank 1 needs a decision")

    def test_the_cli_refuses_what_the_reference_set_cannot_run(self):
        cases = [("--set reference needs --batch", ["--judge", "reference", "--set", "reference", "--stratum", "config"]),
                 ("no top-up-set.json in", ["--judge", "reference", "--set", "reference", "--batch", "top-up", "--stratum", "config"]),
                 ("--batch '../x' must be kebab-case", ["--judge", "reference", "--set", "reference", "--batch", "../x", "--stratum", "config"]),
                 ("--judge flagger needs --model", ["--judge", "flagger", "--set", "reference", "--batch", "calibration", "--stratum", "config"]),
                 ("claude-opus-5-5 is in neither rubric_trigger_flaggers nor record_only_flaggers", ["--judge", "flagger", "--model", "claude-opus-5-5", "--set", "reference",
                                                                                                       "--batch", "calibration", "--stratum", "config"]),
                 ("--model names a flagger", ["--judge", "reference", "--model", "gpt-oss-120b-medium", "--set", "reference", "--batch", "calibration", "--stratum", "config"]),
                 ("--set reference runs --judge reference or flagger", ["--judge", "qgs-A", "--set", "reference", "--batch", "calibration", "--stratum", "config"]),
                 ("--judge reference runs on --set reference", ["--judge", "reference", "--set", "calibration", "--stratum", "config", "--run", "1"]),
                 ("--batch and --model belong to --set reference", ["--judge", "qgs-A", "--set", "calibration", "--batch", "calibration", "--stratum", "config", "--run", "1"]),
                 ("--rerun-notes re-runs the reference", ["--judge", "flagger", "--model", "gpt-oss-120b-medium", "--rerun-notes", "1", "--set", "reference", "--batch",
                                                          "calibration", "--stratum", "config"])]
        for message, args in cases:
            with self.subTest(message):
                with self.assertRaises(SystemExit) as raised:
                    script("run-judge").main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), *args, "--today", "2026-10-21"], fetch=FakeFetch(),
                                             which=lambda cli: True, environ={})
                self.assertIn(message, str(raised.exception))

    def test_a_topic_without_a_reference_cannot_run_one(self):
        path = self.repo / "docs/prior-art/topics/demo.json"
        topic = json.loads(path.read_text())
        del topic["reference"]
        write_json(path, topic)
        self.assertIn("names no reference", self.refused(FakeFetch()))


class FlaggerRunTest(ReferenceBase):
    def lists(self):
        return [("agy mcp list", MCP_LIST), ("agy plugin list", PLUGIN_LIST)]

    def test_a_flagger_labels_blind_through_agy_and_records_its_agy_lists(self):
        fetch = Recorder([*self.lists(), (needle(1), agy_reply(label(1, "o/one"))), (needle(2), agy_reply(label(2, "o/two")))])
        self.judge(fetch, "--model", "gemini-3.8-flash-high", judge="flagger")
        name = "reference-calibration-config-flagger-gemini-3.8-flash-high"
        self.assertEqual([r["order_rank"] for r in self.rows(name)], [1, 2])
        [call] = [c for c in fetch.called("agy --model") if needle(1) in c]
        self.assertTrue(call.startswith("agy --model gemini-3.8-flash-high --output-format stream-json "))
        self.assertTrue(fetch.argvs[0][-1].startswith("# anchors bundle"))
        self.assertNotIn("--append-system-prompt", fetch.argvs[0])
        self.assertEqual(fetch.folders, [(str(session_folder(self.work, name)), [])] * 2)
        self.assertIn("a fixed empty working folder per session key, emptied before each call", self.sessions()[name]["isolation"])
        snapshot = {"mcp_sha256": hashlib.sha256(MCP_LIST.encode()).hexdigest(), "plugins_sha256": hashlib.sha256(PLUGIN_LIST.encode()).hexdigest(),
                    "context_mode_enabled": True, "ponytail_enabled": True}
        entry = self.sessions()[name]
        self.assertEqual([b["agy_lists"] for b in entry["blocks"]], [{"before": snapshot, "after": snapshot}] * 2)
        self.assertNotIn("refused", entry)
        self.assertEqual([(line["total_cost_usd"], line["num_turns"], line["served_models"]) for line in self.ledger()], [(None, 1, None), (None, 1, None)])

    def test_an_agy_list_that_fails_after_the_session_still_logs_its_spend(self):
        class After(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                if cmd[:3] == ["agy", "mcp", "list"] and self.called("agy --model"):
                    self.calls.append(" ".join(cmd))
                    return "", "exit 1: gone", 0
                return super().run(cmd, timeout, cwd)

        message = self.refused(After([*self.lists(), ("agy --model", agy_reply(label(1, "o/one")))]), "--model", "gemini-3.8-flash-high", "--rows", "1-1",
                               judge="flagger")
        self.assertIn("agy mcp list: exit 1: gone", message)
        [line] = self.ledger()
        self.assertEqual((line["model"], line["num_turns"], line["refused"]), ("gemini-3.8-flash-high", 1, "agy mcp list: exit 1: gone"))
        self.assertEqual(self.rows("reference-calibration-config-flagger-gemini-3.8-flash-high"), [])

    def test_disabled_agy_lists_are_recorded_as_disabled(self):
        mcp, plugins = MCP_LIST.replace("  enabled  ", "  disabled  "), PLUGIN_LIST.replace("(enabled,", "(disabled,")
        self.judge(FakeFetch([("agy mcp list", mcp), ("agy plugin list", plugins), ("agy --model", agy_reply(label(1, "o/one")))]), "--model", "gemini-3.8-flash-high",
                   "--rows", "1-1", judge="flagger")
        lists = self.sessions()["reference-calibration-config-flagger-gemini-3.8-flash-high"]["blocks"][0]["agy_lists"]["before"]
        self.assertEqual((lists["context_mode_enabled"], lists["ponytail_enabled"]), (False, False))

    def test_an_agy_list_that_fails_stops_the_run_unretried(self):
        fetch = FakeFetch([("agy mcp list", ("", "exit 1: no config")), ("agy plugin list", PLUGIN_LIST), ("agy --model", agy_reply(label(1, "o/one")))])
        self.assertIn("agy mcp list: exit 1: no config", self.refused(fetch, "--model", "gemini-3.8-flash-high", judge="flagger"))
        self.assertEqual(fetch.called("agy --model"), [])

    def test_a_refused_flagger_row_is_retried_once_then_recorded_and_the_run_goes_on(self):
        tool = agy_reply(label(1, "o/one")).replace('"step_type": "agent_response"', '"step_type": "tool"')
        fetch = FakeFetch([*self.lists(), (needle(1), tool), (needle(2), agy_reply(label(2, "o/two")))])
        self.judge(fetch, "--model", "gpt-oss-120b-medium", judge="flagger")
        name = "reference-calibration-config-flagger-gpt-oss-120b-medium"
        self.assertEqual(len([c for c in fetch.called("agy --model") if needle(1) in c]), 2)
        self.assertEqual([r["order_rank"] for r in self.rows(name)], [2])
        entry = self.sessions()[name]
        self.assertEqual([b["ranks"] for b in entry["blocks"]], [[2]])
        [refusal] = entry["refused"]
        self.assertEqual((refusal["rank"], refusal["date"]), (1, "2026-10-21"))
        self.assertIn("step types ['tool'] beyond user_input and agent_response", refusal["reason"])
        self.assertEqual([(line["ranks"], "step types ['tool']" in line.get("refused", "")) for line in self.ledger()], [([1], True), ([1], True), ([2], False)])

    def test_a_malformed_flagger_reply_refused_twice_is_recorded_and_a_retry_that_answers_is_not(self):
        fetch = FakeFetch([*self.lists(), (needle(1), agy_reply(label(1, "o/one", decision="maybe"))), (needle(2), agy_reply(label(2, "o/two")))])
        self.judge(fetch, "--model", "gpt-oss-120b-medium", "--rows", "1-1", judge="flagger")
        name = "reference-calibration-config-flagger-gpt-oss-120b-medium"
        entry = self.sessions()[name]
        self.assertEqual((entry["blocks"], [r["rank"] for r in entry["refused"]]), ([], [1]))
        self.assertEqual(entry["model"], "gpt-oss-120b-medium")
        self.assertEqual([(line["model"], "rank 1 needs a decision" in line["refused"]) for line in self.ledger()], [("gpt-oss-120b-medium", True)] * 2)

        class Flaky(FakeFetch):
            def run(self, cmd, timeout=180, cwd=None):
                line = " ".join(cmd)
                if line.startswith("agy --model") and not self.called("agy --model"):
                    self.calls.append(line)
                    self.cwds.append(cwd)
                    return "", "exit 1: quota", 0
                return super().run(cmd, timeout, cwd)

        retry = Flaky([*self.lists(), (needle(1), agy_reply(label(1, "o/one")))])
        self.judge(retry, "--model", "gpt-oss-120b-medium", "--rows", "1-1", judge="flagger")
        entry = self.sessions()[name]
        self.assertEqual(([b["ranks"] for b in entry["blocks"]], [r["rank"] for r in entry["refused"]]), ([[1]], [1]))
        self.assertEqual([r["order_rank"] for r in self.rows(name)], [1])


class NoteRerunTest(ReferenceBase):
    note = {"line": 120, "quote": "A paid tier alone is not a vendor stance.", "criterion": "Objectivity", "cue": "objectivity:pricing"}

    def write_notes(self, *notes):
        write_json(self.work / "reference-notes-calibration.json", list(notes))

    def test_a_round_reruns_exactly_the_rows_some_note_selects_with_every_note_line_in_the_prompt(self):
        other = {**self.note, "line": 98, "quote": "Position 1: it names the alternative.", "criterion": "Position", "cue": "position:vs"}
        self.write_notes(other, self.note)
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one")))])
        self.judge(fetch, "--rerun-notes", "1")
        self.assertEqual(len(fetch.called("claude -p")), 1)
        name = "reference-calibration-config-notes-1"
        self.assertEqual([r["order_rank"] for r in self.rows(name)], [1])
        prompt = (self.work / f"prompts/{name}-1-1.md").read_text()
        self.assertIn("## Rubric notes\n\n- line 98 (Position): Position 1: it names the alternative.\n- line 120 (Objectivity): A paid tier alone is not a vendor stance.\n\n"
                      "## Rows", prompt)
        notes_sha = hashlib.sha256((self.work / "reference-notes-calibration.json").read_bytes()).hexdigest()
        self.assertEqual(self.sessions()[name]["blocks"][0]["notes_sha256"], notes_sha)
        self.assertEqual([line["key"] for line in self.ledger()], [name])

    def test_a_later_round_reruns_the_union_under_its_own_key(self):
        self.write_notes(self.note)
        self.judge(FakeFetch([(needle(1), fable(label(1, "o/one")))]), "--rerun-notes", "1")
        self.write_notes(self.note, {**self.note, "criterion": "Methodology", "cue": "fact:prefilled.paid_tier_cues"})
        write_jsonl(self.work / "reference-inputs-config.jsonl", [self.inputs(1, "o/one", "Pricing: the paid tier adds a gate.", released=True),
                                                                   {**self.inputs(2, "o/two", "write the failing test first"),
                                                                    "prefilled": {"released": False, "changelog": False, "paid_tier_cues": ["3: sponsor us"]}}])
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one"))), (needle(2), fable(label(2, "o/two")))])
        self.judge(fetch, "--rerun-notes", "2")
        self.assertEqual([r["order_rank"] for r in self.rows("reference-calibration-config-notes-2")], [1, 2])
        self.assertEqual([r["order_rank"] for r in self.rows("reference-calibration-config-notes-1")], [1])

    def test_a_fact_cue_selects_the_rows_whose_packet_field_is_set(self):
        self.write_notes({**self.note, "criterion": "Authority", "cue": "fact:prefilled.released"})
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one")))])
        self.judge(fetch, "--rerun-notes", "1")
        self.assertEqual([r["order_rank"] for r in self.rows("reference-calibration-config-notes-1")], [1])

    def test_a_decision_note_reruns_the_rows_its_cue_selects(self):
        self.write_notes({**self.note, "criterion": "decision"})
        fetch = FakeFetch([(needle(1), fable(label(1, "o/one")))])
        self.judge(fetch, "--rerun-notes", "1")
        self.assertEqual([r["order_rank"] for r in self.rows("reference-calibration-config-notes-1")], [1])
        self.assertIn("- line 120 (decision): A paid tier alone is not a vendor stance.", (self.work / "prompts/reference-calibration-config-notes-1-1-1.md").read_text())

    def test_a_rerun_is_refused_after_the_protocol_freeze_or_the_batchs_reference_freeze(self):
        self.write_notes(self.note)
        for name, text in (("protocol-freeze.json", "protocol-freeze.json exists; no note re-runs a row after the protocol freeze"),
                           ("reference-freeze-calibration.json", "reference-freeze-calibration.json exists; nothing after the freeze changes a label")):
            with self.subTest(name):
                write_json(self.work / name, {})
                fetch = FakeFetch([("claude -p", fable(label(1, "o/one")))])
                self.assertIn(text, self.refused(fetch, "--rerun-notes", "1"))
                self.assertEqual(fetch.called("claude -p"), [])
                (self.work / name).unlink()

    def test_a_note_outside_the_four_field_form_is_refused_before_any_session(self):
        cases = {"a free-text field": {**self.note, "value": 1}, "a missing quote": {k: v for k, v in self.note.items() if k != "quote"},
                 "a criterion outside the five": {**self.note, "criterion": "Date"}, "a criterion named in another case": {**self.note, "criterion": "Decision"},
                 "an unknown README cue": {**self.note, "cue": "objectivity:cheap"},
                 "a fact outside prefilled and evidence": {**self.note, "cue": "fact:facts.stars"}, "a line that is not a number": {**self.note, "line": "120"}}
        for case, note in cases.items():
            with self.subTest(case):
                self.write_notes(note)
                fetch = FakeFetch([("claude -p", fable(label(1, "o/one")))])
                self.assertIn("reference-notes-calibration.json note 1 must hold exactly line, quote, criterion and cue", self.refused(fetch, "--rerun-notes", "1"))
                self.assertEqual(fetch.called("claude -p"), [])

    def test_a_missing_note_or_a_cue_that_selects_nothing_is_refused(self):
        self.assertIn("no reference-notes-calibration.json in", self.refused(FakeFetch(), "--rerun-notes", "1"))
        self.write_notes()
        self.assertIn("reference-notes-calibration.json must hold a non-empty list of notes", self.refused(FakeFetch(), "--rerun-notes", "1"))
        self.write_notes(self.note)
        self.assertIn("--rerun-notes 0 must be a round number from 1", self.refused(FakeFetch(), "--rerun-notes", "0"))
        self.write_notes({**self.note, "cue": "objectivity:sponsor"})
        self.assertIn("no note of reference-notes-calibration.json selects a config row of calibration", self.refused(FakeFetch(), "--rerun-notes", "1"))


class OtherKindsWriteNoLedgerTest(SessionBase):
    def test_a_screening_block_appends_no_ledger_line(self):
        self.pilot(FakeFetch([("claude -p", claude_reply(reply_row(1, "o/one")))]))
        self.assertFalse((self.work / "claude-spend-ledger.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
