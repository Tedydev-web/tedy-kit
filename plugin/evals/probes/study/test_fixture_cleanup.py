import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class FixtureCleanupTest(unittest.TestCase):
    def test_a_topic_repo_is_removed_when_the_process_exits_without_cleanup(self):
        code = "import study_fixtures; print(study_fixtures.topic_repo())"
        run = subprocess.run([sys.executable, "-c", code], cwd=HERE, capture_output=True, text=True, check=True)
        repo = Path(run.stdout.strip())
        self.assertTrue(repo.name.startswith("study-topic-"))
        self.assertFalse(repo.exists(), f"{repo} was left behind")


if __name__ == "__main__":
    unittest.main()
