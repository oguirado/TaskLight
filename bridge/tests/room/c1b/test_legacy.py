"""Bootstrap prerequisite and public CLI slug-boundary compatibility."""
import json
import sys

from .support import BASE, RunCase


class BootstrapOracle(RunCase):
    def test_m6_preserved_lifecycle_call_bootstraps_a_missing_room(self):
        args = {"room": "demo", "agent": "exec-a", "state": "deployed", "run_id": "run-A_1"}
        process = self.launch([sys.executable, "-B", "-m", "bridge.room", "call", "agent_lifecycle",
                               "--json", json.dumps(args)])
        out, err = process.communicate(b"", timeout=10)
        self.assertEqual(process.returncode, 0, err)
        self.assertEqual(json.loads(out)["untrusted"]["ok"], True)
        self.assertEqual([event["op"]["state"] for event in self.events()], ["deployed"])
        self.assertFalse(self.marker.exists())

    def test_m4_valid_slug_boundary_is_accepted(self):
        room, agent = "r" * 48, "a" * 44 + "._-9"
        result = self.invoke(options=["--room", room, "--agent", agent, "--run-id", "Run_1-a"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.marker.exists())
        events = self.events(room)
        self.assertEqual(events[0]["agent"], agent)
        self.assertEqual(events[0]["op"]["state"], "deployed")
        self.assertEqual(events[-1]["op"]["state"], "finished")
