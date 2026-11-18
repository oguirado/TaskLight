"""Measure journal reads made by the coordinator while lanes append events."""

import json
from unittest import mock

from bridge.room.ext import wave
from bridge.tests.room.cl.support import RoomCase


class WaveSnapshotTests(RoomCase):
    def test_coordinator_reads_only_before_launch_and_after_reaping(self):
        self.lifecycle("leader", "leader-run", "deployed")
        identities = [("lane-a", "run-a"), ("lane-b", "run-b"), ("lane-c", "run-c")]
        for state in ("deployed", "finished"):
            self.lifecycle(*identities[0], state)
        manifest = self.scratch / "manifest.json"
        manifest.write_text(json.dumps({
            "room": "demo", "parent": "leader", "parent_run": "leader-run",
            "lanes": [{"agent": agent, "run_id": run, "argv": ["worker"],
                       "result_file": str(self.scratch / (agent + ".json"))}
                      for agent, run in identities],
        }), encoding="utf-8")
        calls = []

        def spawn(command, **_kwargs):
            identity = (command[command.index("--agent") + 1],
                        command[command.index("--run-id") + 1])
            calls.append(("spawn", identity))
            self.lifecycle(*identity, "deployed", parent_agent="leader",
                           parent_run_id="leader-run")

            def wait(timeout=None):
                calls.append(("reap", identity))
                self.lifecycle(*identity, "finished", reason="exit:0")
                return 0

            return mock.Mock(wait=wait)

        terminal_history = wave._terminal_history

        def read(room, identities):
            calls.append(("read", tuple(identities)))
            return terminal_history(room, identities)

        with (
            mock.patch.object(wave.subprocess, "Popen", side_effect=spawn),
            mock.patch.object(wave, "_terminal_history", side_effect=read),
        ):
            code, out, _ = self.invoke(wave.main, ["--manifest", str(manifest)])

        first, second, third = identities
        self.assertEqual(calls, [
            ("read", (first, second, third)),
            ("spawn", second), ("spawn", third),
            ("reap", second), ("reap", third),
            ("read", (second, third)),
        ])
        self.assertEqual(code, 1)
        self.assertEqual([row["reason"] for row in json.loads(out)["wave"]["lanes"]],
                         ["already_terminal", "exit:0", "exit:0"])
