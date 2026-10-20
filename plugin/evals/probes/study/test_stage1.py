import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from study_fixtures import FakeFetch, script, topic_repo, write_json, write_jsonl
from study_topic import TopicError, load_topic

SONNET, OPUS = "claude-sonnet-5-5", "claude-opus-5-5"
EXAMPLES = [{"repo": f"e/{v}{i}", "description": f"{v} example {i}", "verdict": v, "problems": ["X1"] if v == "yes" else [], "why": "w"}
            for v in ("yes", "unsure", "no") for i in (1, 2)]
STRATA = {"config": {"stop_row": None, "forced_repos": [], "channels": {}}, "product": {"stop_row": None, "forced_repos": [], "channels": {}}}


class Stage1Replies(FakeFetch):
    def __init__(self, verdicts):
        super().__init__()
        self.verdicts = verdicts
        self.batches = []

    def run(self, cmd, timeout=180, cwd=None):
        super().run(cmd, timeout, cwd)
        if cmd[1:] == ["--version"]:
            return "9.9.9 (fixture)\n", "ok", 0
        model = cmd[cmd.index("--model") + 1]
        rows = [json.loads(block) for block in re.findall(r"```json\n(.+?)\n```", cmd[-1])]
        self.batches.append(len(rows))
        lines = []
        for row in rows:
            verdict = self.verdicts.get((model, row["repo"]), "yes")
            lines.append(json.dumps({"order_rank": row["order_rank"], "repo": row["repo"], "verdict": verdict, "problems": ["X1"] if verdict == "yes" else [], "why": "w"}))
        return json.dumps({"is_error": False, "num_turns": 1, "permission_denials": [], "result": "\n".join(lines), "modelUsage": {model: {}}}), "ok", 0


class Stage1Test(unittest.TestCase):
    def setUp(self):
        self.repo = topic_repo(strata=STRATA)
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "problems": ["X1", "X2"], "stage1_examples": EXAMPLES})
        self.work = Path(tempfile.mkdtemp(prefix="study-stage1-"))
        for folder in (self.repo, self.work):
            self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        for stratum in STRATA:
            (self.work / f"stage1-packet-{stratum}.md").write_text(f"stage-1 packet {stratum}: problems X1 X2\n")

    def topic(self):
        return load_topic(self.repo, "demo")

    def pool(self, stratum, count, empty=()):
        write_jsonl(self.work / f"{stratum}-screening-order.jsonl",
                    [{"order_rank": i, "repo": f"{stratum[0]}/r{i}", "description": "" if i in empty else f"repo {i} guards tdd"} for i in range(1, count + 1)])

    def call(self, name, *args, fetch=None):
        extra = {"fetch": fetch} if fetch is not None else {}
        if name == "run-stage1":
            extra.update(which=lambda cli: True, environ={"ANTHROPIC_API_KEY": "fixture"})
        script(name).main(["--topic", "demo", "--repo", str(self.repo), "--work", str(self.work), *args], **extra)

    def frozen(self):
        self.call("freeze-stage1", "--today", "2026-10-20")

    def batch(self, batch, rows):
        sample = {"sweep": "261001-demo", "batch": batch, "rows": [{"id": r["id"], "stratum": r["stratum"], "order_rank": r["order_rank"], "repo": r["repo"]} for r in rows]}
        write_json(self.work / f"{batch}-set.json", sample)
        freeze = self.work / "stage1-freeze.json"
        write_json(self.work / f"{batch}-labels.json", {"batch": batch, "set_sha256": hashlib.sha256((self.work / f"{batch}-set.json").read_bytes()).hexdigest(),
                                                        "stage1_freeze_sha256": hashlib.sha256(freeze.read_bytes()).hexdigest() if freeze.is_file() else None,
                                                        "complete": len(rows), "rows": rows})

    def labelled_rows(self, batch, positives, negatives, first=1):
        rows = []
        for n in range(positives + negatives):
            stratum = "config" if n % 2 == 0 else "product"
            rank = first + n // 2
            rows.append({"id": f"{batch}-{stratum}-{n}", "stratum": stratum, "order_rank": rank, "repo": f"{stratum[0]}/r{rank}",
                         "user": {"decision": "eligible" if n < positives else "excluded: irrelevant", "Relevance": 1 if n < positives else 0}})
        return rows

    def runs(self, rows, shape, model, run, missed=()):
        for stratum in STRATA:
            write_jsonl(self.work / f"judge-{stratum}-stage1-{shape}-{model}-run{run}.jsonl",
                        [{"order_rank": r["order_rank"], "repo": r["repo"], "verdict": "no" if r["repo"] in missed else "yes", "problems": [], "why": "w"}
                         for r in rows if r["stratum"] == stratum])

    def inputs(self, count):
        for stratum in STRATA:
            self.pool(stratum, count)
            self.call("build-stage1-inputs", "--stratum", stratum, "--shape", "brief", fetch=FakeFetch())

    def test_the_prompt_carries_two_or_three_worked_examples_per_verdict(self):
        from study_stage1 import examples, examples_text
        self.assertEqual(len(examples(self.topic())), 6)
        self.assertEqual(examples_text(self.topic()).count('"verdict": "unsure"'), 2)
        path = self.repo / "docs/prior-art/topics/demo.json"
        write_json(path, {**json.loads(path.read_text()), "stage1_examples": EXAMPLES[:5]})
        with self.assertRaisesRegex(TopicError, r"stage1_examples holds \{'yes': 2, 'unsure': 2, 'no': 1\}; the prompt carries 2 or 3 worked examples per verdict"):
            examples(self.topic())

    def test_inputs_hold_name_and_description_asset_paths_for_config_and_a_readme_lead_and_empty_rows_pass_unread(self):
        self.pool("config", 3, empty={2})
        write_json(self.work / "cache/trees/c__r1.json", {"oid": "e" * 40, "paths": ["README.md", "skills/tdd/SKILL.md", "src/x.ts"]})
        write_json(self.work / "cache/trees/c__r2.json", {"oid": "e" * 40, "paths": ["README.md", "src/x.ts"]})
        write_json(self.work / "cache/trees/c__r3.json", {"oid": "e" * 40, "paths": [".claude/settings.json"]})
        from study_stage1 import auto_pass, build_inputs
        brief = build_inputs(self.work, "config", "brief", FakeFetch())
        self.assertEqual(brief[0], {"order_rank": 1, "repo": "c/r1", "description": "repo 1 guards tdd"})
        self.assertEqual([auto_pass(r) for r in brief], [False, True, False])
        paths = build_inputs(self.work, "config", "paths", FakeFetch())
        self.assertEqual([r["asset_paths"] for r in paths], [["skills/tdd/SKILL.md"], [], [".claude/settings.json"]])
        readme = build_inputs(self.work, "config", "readme", FakeFetch([("repos/c/r2/readme", "# r2\n" + "line\n" * 40), ("repos/c/r3/readme", ("", "exit 1: HTTP 404"))]))
        self.assertEqual((readme[1]["readme_lead"].count("\n"), readme[2]["readme_lead"], auto_pass(readme[1])), (19, "", False))
        with self.assertRaisesRegex(TopicError, "README of c/r1: exit 1: HTTP 502; build the readme shape again"):
            (self.work / "cache/readmes/c__r1.md").unlink(missing_ok=True)
            build_inputs(self.work, "config", "readme", FakeFetch([("repos/c/r1/readme", ("", "exit 1: HTTP 502"))]))

    def test_the_ladder_is_frozen_before_any_label_is_read_and_the_rung_choice_reads_the_freeze(self):
        from study_calibration_set import labelled
        from study_stage1 import LADDER, choose_rung
        self.assertEqual([(r["rung"], r["models"], r["shape"]) for r in LADDER],
                         [(1, [SONNET], "brief"), (2, [OPUS, SONNET], "brief"), (3, [OPUS, SONNET], "paths"), (4, [OPUS, SONNET], "readme")])
        rows = self.labelled_rows("calibration", 59, 1)
        with self.assertRaisesRegex(TopicError, "no stage1-freeze.json in .*; freeze the stage-1 ladder with freeze-stage1.py before any calibration label is read"):
            choose_rung(self.work, rows)
        self.batch("calibration", rows)
        with self.assertRaisesRegex(SystemExit, "calibration-labels.json already hold calibration labels; the ladder must be frozen before any label is read"):
            self.frozen()
        with self.assertRaisesRegex(TopicError, "calibration-labels.json was not imported under the current stage1-freeze.json"):
            labelled(self.work)
        (self.work / "calibration-labels.json").unlink()
        self.frozen()
        frozen = json.loads((self.work / "stage1-freeze.json").read_text())
        self.assertEqual((frozen["batch_max"], frozen["date"], sorted(frozen["packets"])), (100, "2026-10-20", ["config", "product"]))
        with self.assertRaisesRegex(SystemExit, "already exists; the stage-1 ladder is frozen once"):
            self.frozen()
        write_json(self.work / "stage1-freeze.json", {**frozen, "ladder": frozen["ladder"][1:]})
        with self.assertRaisesRegex(TopicError, "froze another ladder than the toolchain's"):
            choose_rung(self.work, rows)

    def test_the_first_rung_whose_two_runs_meet_the_pass_rule_is_chosen_and_the_rungs_tried_are_written(self):
        self.inputs(30)
        self.frozen()
        rows = self.labelled_rows("calibration", 59, 1)
        self.batch("calibration", rows)
        self.runs(rows, "brief", SONNET, 1, missed={"c/r1"})
        self.runs(rows, "brief", SONNET, 2)
        with self.assertRaisesRegex(SystemExit, r"no stage-1 rung meets the pass rule yet \(rung 1 lower bounds \[0.\d+, 0.95\]\)"):
            self.call("choose-stage1-rung", "--today", "2026-10-20")
        for run in (1, 2):
            self.runs(rows, "brief", OPUS, run)
        self.call("choose-stage1-rung", "--today", "2026-10-20")
        chosen = json.loads((self.work / "stage1-rung.json").read_text())
        self.assertEqual((chosen["rung"], [t["rung"] for t in chosen["tried"]], [t["meets"] for t in chosen["tried"]], chosen["batches"]), (2, [1, 2], [False, True], ["calibration"]))
        self.assertEqual((chosen["tried"][0]["runs"][0]["missed"], chosen["tried"][1]["runs"][0]["passed"]), (["c/r1"], 59))
        self.assertEqual((chosen["tried"][0]["differ"], chosen["tried"][0]["rows"], chosen["tried"][1]["differ"]), (1, 60, 0))
        self.assertEqual(chosen["tried"][1]["runs"][0]["strata"]["config"]["positives"], 30)
        with self.assertRaisesRegex(SystemExit, "already exists; the rung is chosen once"):
            self.call("choose-stage1-rung")

    def test_a_pool_run_goes_in_batches_of_at_most_100_rows_and_rows_without_text_pass_unread(self):
        for stratum in STRATA:
            self.pool(stratum, 5, empty={3})
            self.call("build-stage1-inputs", "--stratum", stratum, "--shape", "brief", fetch=FakeFetch())
        self.frozen()
        replies = Stage1Replies({(SONNET, "c/r2"): "no"})
        with self.assertRaisesRegex(SystemExit, "no stage1-rung.json in"):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", SONNET, "--set", "pool", fetch=replies)
        write_json(self.work / "stage1-rung.json", {"rung": 1})
        with self.assertRaisesRegex(SystemExit, "rung 1 was chosen: it runs claude-sonnet-5-5 on the brief shape, not claude-opus-5-5 on brief"):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", OPUS, "--set", "pool", fetch=replies)
        with mock.patch("study_stage1.BATCH_MAX", 2):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", SONNET, "--set", "pool", "--today", "2026-10-20", fetch=replies)
        self.assertEqual(replies.batches, [2, 2])
        meta = json.loads((self.work / "meta.json").read_text())["sessions"]["stage1-config-brief-claude-sonnet-5-5"]
        self.assertEqual(([b["ranks"] for b in meta["blocks"]], meta["blocks"][0]["shape"], meta["model"]), ([[1, 2], [4, 5]], "brief", SONNET))
        rows = [json.loads(line) for line in (self.work / "stage1-config-brief-claude-sonnet-5-5.jsonl").read_text().splitlines()]
        self.assertEqual([(r["order_rank"], r["verdict"]) for r in rows], [(1, "yes"), (2, "no"), (4, "yes"), (5, "yes")])

    def test_a_stage1_block_over_100_rows_is_refused_before_any_session(self):
        from study_session import run_block
        write_jsonl(self.work / "stage1-inputs-config-brief.jsonl", [{"order_rank": i, "repo": f"c/r{i}", "description": "d"} for i in range(1, 102)])
        fetch = FakeFetch()
        with self.assertRaisesRegex(TopicError, "a stage-1 batch holds at most 100 rows; this one holds 101"):
            run_block({"work": str(self.work), "stratum": "config", "name": "n", "option": {"cli": "claude", "model": SONNET}, "kind": "stage1",
                       "inputs": "stage1-inputs-config-brief.jsonl", "ranks": list(range(1, 102))}, fetch)
        self.assertEqual(fetch.calls, [])

    def test_too_few_positives_pooled_fires_the_top_up_trigger_and_the_top_up_rows_join_the_pooled_bound(self):
        from study_calibration_set import labelled, top_up_trigger
        from study_stage1 import choose_rung
        self.inputs(50)
        self.frozen()
        rows = self.labelled_rows("calibration", 50, 10)
        self.batch("calibration", rows)
        with self.assertRaisesRegex(SystemExit, "the calibration labels hold 50 positives pooled, fewer than 59; draw the top-up batch"):
            self.call("choose-stage1-rung")
        self.assertEqual(top_up_trigger(self.work), ("top-up", "fewer than 59 positives pooled (50): the rows join the pooled bound"))
        top = self.labelled_rows("top-up", 9, 21, first=31)
        self.batch("top-up", top)
        pooled = labelled(self.work, ("calibration", "top-up"))
        for run in (1, 2):
            self.runs(pooled, "brief", SONNET, run)
        self.call("choose-stage1-rung", "--today", "2026-10-20")
        chosen = json.loads((self.work / "stage1-rung.json").read_text())
        self.assertEqual((chosen["rung"], chosen["batches"], chosen["tried"][0]["runs"][0]["positives"]), (1, ["calibration", "top-up"], 59))
        with self.assertRaisesRegex(TopicError, "no top-up trigger fired: the labels hold 59 positives pooled"):
            top_up_trigger(self.work)
        with self.assertRaisesRegex(SystemExit, "rung 1 was chosen, so no held-out batch confirms it"):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", SONNET, "--set", "held-out", fetch=Stage1Replies({}))
        self.assertEqual(choose_rung(self.work, pooled)["rung"], 1)

    def test_a_rung_above_the_first_fires_the_held_out_trigger_and_the_pool_waits_until_it_misses_no_held_out_positive(self):
        from study_calibration_set import labelled, top_up_trigger
        from study_stage1 import held_out_check
        self.inputs(50)
        self.frozen()
        rows = self.labelled_rows("calibration", 59, 1)
        self.batch("calibration", rows)
        write_json(self.work / "stage1-rung.json", {"rung": 2})
        self.assertEqual(top_up_trigger(self.work), ("held-out", "stage-1 rung 2 was chosen above the first: the rows are held out to confirm it"))
        held = self.labelled_rows("held-out", 20, 10, first=31)
        self.batch("held-out", held)
        self.assertEqual(len(labelled(self.work)), 60)
        replies = Stage1Replies({(OPUS, "c/r31"): "no", (SONNET, "c/r31"): "no"})
        with self.assertRaisesRegex(SystemExit, "the held-out batch is not judged by every model of rung 2"):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", OPUS, "--set", "pool", fetch=replies)
        for model in (OPUS, SONNET):
            for stratum in STRATA:
                self.call("run-stage1", "--stratum", stratum, "--shape", "brief", "--model", model, "--set", "held-out", "--today", "2026-10-20", fetch=replies)
        with self.assertRaisesRegex(TopicError, r"rung 2 missed 1 held-out positives \(c/r31\); it is not confirmed"):
            held_out_check(self.work, 2, labelled(self.work, ("held-out",)))
        with self.assertRaisesRegex(SystemExit, "rung 2 missed 1 held-out positives"):
            self.call("run-stage1", "--stratum", "config", "--shape", "brief", "--model", OPUS, "--set", "pool", fetch=replies)
        with self.assertRaisesRegex(TopicError, "the held-out batch is already drawn"):
            top_up_trigger(self.work)


if __name__ == "__main__":
    unittest.main()
