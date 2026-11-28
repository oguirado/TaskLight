"""Room CLI JSON results are byte-stable under a legacy console encoding."""
import json
import os
import subprocess
import sys

from bridge.tests.room.support import RoomCase


class ConsoleEncoding(RoomCase):
    def test_read_emits_utf8_with_ascii_stdout(self):
        event = self.post(text="café")
        result = subprocess.run(
            [sys.executable, "-B", "-m", "bridge.room", "read", "--room", "r1", "--json"],
            env=dict(os.environ, CW_HOME=str(self.home), PYTHONIOENCODING="ascii"),
            capture_output=True, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.endswith(b"\n"))
        self.assertNotIn(b"\r", result.stdout)
        reply = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(reply["events"][0].get("id"), event["id"])
        self.assertEqual(reply["events"][0].get("text"), event["text"])
