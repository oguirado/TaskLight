"""Check the replacement waiter fixture against the checked reader and public waiter."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from bridge.room import app, store
from . import measure_waiter_churn as churn
from . import waiter_fixture as fixture
from .fixtures import encoded, journal, sha


class WaiterFixtureTests(unittest.TestCase):
    def generate(self, home):
        path = Path(home) / "rooms" / fixture.ROOM / "events.jsonl"
        path.parent.mkdir(parents=True)
        fixture.write_fixture(path)
        return path

    def test_fresh_generations_match_pin_and_checked_reader(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            first_path = self.generate(first)
            second_path = self.generate(second)
            data = first_path.read_bytes()
            self.assertTrue(data == second_path.read_bytes(), "fresh fixture bytes differ")
            self.assertEqual(len(data), fixture.JOURNAL_BYTES)
            self.assertEqual(sha(data), fixture.FIXTURE_SHA256)
            self.assertNotEqual(fixture.FIXTURE_SHA256, churn.CAP_SHA256)
            self.assertTrue(data.endswith(b"\n"))
            rows, malformed = store.read_checked(fixture.ROOM, home=first)
            self.assertEqual(malformed, 0)
            self.assertEqual(len(rows), data.count(b"\n"))
            self.assertEqual(journal(rows), data)
            self.assertEqual([row["lamport"] for row in rows], list(range(1, fixture.HEAD + 1)))
            acts = [row["act"] for row in rows]
            self.assertGreater(acts.count("heartbeat"), len(rows) // 2)
            self.assertIn("question", acts)
            self.assertEqual(acts.count("op"), 11)

    def test_changed_heartbeat_is_rejected_by_default_and_pinned_override(self):
        with tempfile.TemporaryDirectory() as home:
            path = self.generate(home)
            data = path.read_bytes()
            lines = data.splitlines(keepends=True)
            index = next(i for i, line in enumerate(lines)
                         if json.loads(line)["act"] == "heartbeat")
            row = json.loads(lines[index])
            row["text"] = row["text"][:-1] + "y"
            lines[index] = encoded(row) + b"\n"
            mutated = b"".join(lines)
            self.assertEqual(len(mutated), len(data))
            self.assertNotEqual(sha(mutated), fixture.FIXTURE_SHA256)
            path.write_bytes(mutated)
            command = [
                sys.executable, "-B", "-m", "bridge.tests.bench.measure_waiter_churn",
                "--baseline", str(churn.ROOT), "--candidate", str(churn.ROOT),
                "--cap-fixture", str(path),
            ]
            for override in ([], ["--fixture-sha256", fixture.FIXTURE_SHA256]):
                with self.subTest(override=override):
                    result = subprocess.run(command + override, cwd=churn.ROOT,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, "")
                    self.assertIn("pinned cap fixture SHA-256 mismatch", result.stderr)

    def test_scheduled_suffix_fits_and_returns_the_filtered_terminal(self):
        writes = list(fixture.scheduled_writes())
        schedule = [when for when, _ in writes]
        rows = [row for _, row in writes]
        self.assertEqual(schedule, [index / 5 for index in range(1, 52)])
        self.assertEqual([row["act"] for row in rows], ["heartbeat"] * 50 + ["op"])
        chunks = [encoded(row) + b"\n" for row in rows]
        after_beats = fixture.JOURNAL_BYTES + sum(len(chunk) for chunk in chunks[:-1])
        self.assertLessEqual(after_beats, store.CAP - store.SEMANTIC_RESERVE_BYTES)
        self.assertLessEqual(after_beats + len(chunks[-1]), store.CAP)

        with tempfile.TemporaryDirectory() as home:
            path = self.generate(home)
            ready = SimpleNamespace(wait=lambda _: None)
            published = SimpleNamespace(wait=lambda _: churn.append(path, chunks[clock.step]))
            clock = churn.clock_for(schedule, ready, published)
            args = {"room": fixture.ROOM, "since_lamport": fixture.HEAD, "timeout_s": 11,
                    "agents": ["worker"], "parent": "coordinator", "states": ["finished"]}
            with patch.dict(os.environ, CW_HOME=home), \
                    patch.object(time, "monotonic", clock.monotonic), \
                    patch.object(time, "sleep", clock.sleep):
                reply = app.dispatch("wait_agents", args)
            self.assertEqual(clock.step, len(schedule))
            self.assertEqual(path.stat().st_size, after_beats + len(chunks[-1]))
            self.assertEqual(reply["untrusted"], {
                "events": [{"agent": "worker", "run_id": "scheduled-run", "state": "finished",
                            "parent": {"agent": "coordinator", "run_id": None},
                            "lamport": fixture.HEAD + 51}],
                "cursor": fixture.HEAD + 51,
            })


if __name__ == "__main__":
    unittest.main()
