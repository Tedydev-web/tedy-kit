import json
import unittest

from study_topic import TopicError

CLAUDE = {"cli": "claude", "model": "claude-opus-5-5"}
AGY = {"cli": "agy", "model": "gemini-3.8-flash-high"}
EXPECTED = {1: {"repo": "o/one", "sha": "c" * 40}, 2: {"repo": "o/two", "sha": "d" * 40}}
CELLS = {c: {"v": 1, "why": "w"} for c in ("Authority", "Methodology", "Objectivity", "Date", "Position", "Novelty", "Relevance")}


def agy_stream(result, *steps):
    events = [{"event": "init", "init": {"model": "gemini-3.8-flash-high"}}, {"event": "step_update", "step_update": {"step_index": 0, "step_type": "user_input", "state": "DONE"}}]
    events += [{"event": "step_update", "step_update": {"step_index": i + 1, "step_type": t, "state": "DONE"}} for i, t in enumerate(steps)]
    return "".join(json.dumps(e) + "\n" for e in events + ([{"event": "result", "result": result}] if result else []))


def row(rank, repo):
    return json.dumps({"order_rank": rank, "repo": repo, "scores": CELLS, "mechanisms": ["gate"], "decision": "eligible"})


class ReplyTextTest(unittest.TestCase):
    def refused(self, option, out, status, message):
        from study_session_reply import reply_text
        with self.assertRaisesRegex(TopicError, message):
            reply_text(option, out, status)

    def test_every_failure_branch_of_a_reply_is_refused(self):
        self.refused(CLAUDE, "", "exit 1: boom", "claude claude-opus-5-5: exit 1: boom")
        self.refused(CLAUDE, "not json", "ok", "reply is not JSON")
        self.refused(CLAUDE, "[1, 2]", "ok", "reply is not a JSON object")
        self.refused(CLAUDE, json.dumps({"is_error": True, "result": "overloaded"}), "ok", "overloaded")
        self.refused(CLAUDE, json.dumps({"num_turns": 3, "permission_denials": [], "modelUsage": {"claude-opus-5-5": {}}}), "ok", "3 turns")
        self.refused(CLAUDE, json.dumps({"num_turns": 1, "permission_denials": [{"tool": "Bash"}], "modelUsage": {"claude-opus-5-5": {}}}), "ok", "permission denials")
        self.refused(CLAUDE, json.dumps({"num_turns": 1, "permission_denials": [], "modelUsage": {"claude-opus-4-8": {}}}), "ok", r"served \['claude-opus-4-8'\], not the requested")
        self.refused(AGY, agy_stream(None, "agent_response"), "ok", "holds no result event")
        self.refused(AGY, agy_stream({"status": "ERROR", "num_turns": 1, "response": ""}), "ok", "status ERROR")
        self.refused(AGY, agy_stream({"status": "SUCCESS", "num_turns": 1, "response": "x"}, "tool", "agent_response"), "ok",
                     r"step types \['tool'\] beyond user_input and agent_response, denied actions None; a screening session has no tools")
        for unknown in ("planner_response", "browser_action", "None"):
            self.refused(AGY, agy_stream({"status": "SUCCESS", "num_turns": 1, "response": "x"}, unknown, "agent_response"), "ok", f"step types \\['{unknown}'\\]")
        self.refused(AGY, agy_stream({"status": "SUCCESS", "num_turns": 1, "response": "", "denied_actions": [{"permission": "mcp"}]}), "ok", r"step types \[\] beyond .*denied actions \[")
        self.refused(AGY, agy_stream({"status": "SUCCESS", "num_turns": 2, "response": "x"}, "agent_response"), "ok", "2 turns; a screening session answers in one turn")

    def test_a_clean_reply_returns_the_text_and_what_served_it(self):
        from study_session_reply import reply_text
        self.assertEqual(reply_text(CLAUDE, json.dumps({"num_turns": 1, "permission_denials": [], "result": "x", "modelUsage": {"claude-opus-5-5": {}}}), "ok"), ("x", ["claude-opus-5-5"]))
        self.assertEqual(reply_text(AGY, "agy: a banner line that is not JSON\n" + agy_stream({"status": "SUCCESS", "num_turns": 1, "response": "y"}, "agent_response"), "ok"), ("y", None))


class ParseReplyTest(unittest.TestCase):
    def test_a_duplicate_rank_and_a_row_nobody_asked_for_are_problems(self):
        from study_session_reply import parse_reply
        rows, _, problems = parse_reply("\n".join([row(1, "o/one"), row(1, "o/one"), row(2, "o/two")]), EXPECTED)
        self.assertIn("rank 1 appears twice", problems)
        self.assertEqual([r["sha"] for r in rows], ["c" * 40, "d" * 40])
        _, _, problems = parse_reply("{\"x\": 1}\n" + row(2, "o/two"), EXPECTED)
        self.assertEqual(problems, ["row None was not asked for", "rank 1 missing from the reply"])

    def test_json_booleans_are_neither_ranks_nor_scores(self):
        from study_session_reply import parse_reply
        expected = {1: EXPECTED[1]}
        _, _, problems = parse_reply(json.dumps({"order_rank": True, "repo": "o/one", "scores": CELLS, "mechanisms": [], "decision": "eligible"}), expected)
        self.assertEqual(problems, ["row True was not asked for", "rank 1 missing from the reply"])
        true_cells = {**CELLS, "Position": {"v": True, "why": "w"}}
        _, _, problems = parse_reply(json.dumps({"order_rank": 1, "repo": "o/one", "scores": true_cells, "mechanisms": [], "decision": "eligible"}), expected)
        self.assertEqual(problems, ["rank 1 lacks a 1 / 0.5 / 0 score for every cell"])

    def test_under_quality_criteria_v4_an_eligible_row_names_the_registry_problems_it_addresses(self):
        from study_session_prompt import REPLY_FORMAT, REPLY_FORMAT_V4, TEMPLATE_SHA256, reply_format, template_sha256
        from study_session_reply import parse_reply
        expected = {1: EXPECTED[1]}
        base = {"order_rank": 1, "repo": "o/one", "scores": CELLS, "mechanisms": ["gate"], "decision": "eligible"}
        self.assertEqual(parse_reply(json.dumps(base), expected)[2], [])
        self.assertEqual(parse_reply(json.dumps(base), expected, ["X1", "X2"])[2], ["rank 1 has no problems list naming the registry problems it addresses"])
        self.assertEqual(parse_reply(json.dumps({**base, "problems": []}), expected, ["X1", "X2"])[2], ["rank 1 is eligible but names no registry problem"])
        self.assertEqual(parse_reply(json.dumps({**base, "problems": ["X9"]}), expected, ["X1", "X2"])[2], ["rank 1 names problems ['X9'] outside the topic"])
        rows, _, problems = parse_reply(json.dumps({**base, "problems": ["X2"]}), expected, ["X1", "X2"])
        self.assertEqual((problems, rows[0]["problems"]), ([], ["X2"]))
        self.assertEqual(parse_reply(json.dumps({**base, "decision": "exclude: irrelevant", "problems": []}), expected, ["X1"])[2], [])
        self.assertIn("problems (the ids of the registry problems the repository carries a mechanism for; at least one for an eligible row)", REPLY_FORMAT_V4)
        self.assertNotIn("problems", REPLY_FORMAT)
        self.assertEqual((reply_format("docs/prior-art/quality-criteria-v3.md"), template_sha256("docs/prior-art/quality-criteria-v3.md")), (REPLY_FORMAT, TEMPLATE_SHA256))
        self.assertEqual(reply_format("docs/prior-art/quality-criteria-v4.md"), REPLY_FORMAT_V4)
        self.assertNotEqual(template_sha256("docs/prior-art/quality-criteria-v4.md"), TEMPLATE_SHA256)


if __name__ == "__main__":
    unittest.main()
