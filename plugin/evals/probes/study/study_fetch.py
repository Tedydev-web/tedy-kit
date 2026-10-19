import math
import os
import re
import subprocess
import time

RATE_LIMITED = ("rate limit", "secondary rate", "abuse detection")
MAX_WAIT = 300
STDERR_SHOWN = 200
TRY_AGAIN = re.compile(r"try again in (\d+(?:\.\d+)?)s\b")


class NetworkRefused(RuntimeError):
    pass


class Fetch:
    def __init__(self, sleep=time.sleep, retries=4):
        self.sleep = sleep
        self.retries = retries
        self.last_stderr = ""

    def _once(self, cmd, timeout, cwd=None):
        if os.environ.get("STUDY_NO_NETWORK"):
            raise NetworkRefused(f"STUDY_NO_NETWORK is set; refused: {' '.join(cmd)[:200]}")
        started = time.time()
        self.last_stderr = ""
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL)
            status = "ok" if result.returncode == 0 else f"exit {result.returncode}: {result.stderr.strip()[:STDERR_SHOWN]}"
            out, self.last_stderr = result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            out, status = "", "timeout"
        except FileNotFoundError:
            out, status = "", f"missing command: {cmd[0]}"
        return out, status, round(time.time() - started, 1)

    def run(self, cmd, timeout=180, cwd=None):
        for attempt in range(1, self.retries + 1):
            out, status, seconds = self._once(cmd, timeout, cwd)
            asked = TRY_AGAIN.search(status)
            limited = cmd[0] == "gh" and (asked or "(HTTP 429)" in status or any(word in status.lower() for word in RATE_LIMITED))
            if not limited or attempt == self.retries:
                return out, status, seconds
            if asked or "(HTTP 429)" in status:
                self.sleep(min(MAX_WAIT, math.ceil(float(asked.group(1))) + 1) if asked else 60)
            else:
                self.sleep(self._reset_pause())
        return out, status, seconds

    def _reset_pause(self):
        out, status, _ = self._once(["gh", "api", "rate_limit", "--jq", ".resources.core.reset"], 60)
        out = out.strip()
        return max(30, int(out) - int(time.time()) + 5) if status == "ok" and out.isdigit() else 65

    def pace(self, seconds):
        self.sleep(seconds)
