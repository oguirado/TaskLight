"""M2-M5: virtual heartbeat deadlines and lifecycle transport fault injection."""
from .support import ALLOWED_OP, BASE, RunCase


class ClockOracle(RunCase):
    def assert_supervised(self, result, report, code=0):
        self.assertEqual(len(report["launches"]), 1,
                         "run must launch the command through the process boundary")
        self.assertFalse(report["launches"][0]["shell"], "child must start without a shell")
        self.assertTrue(report["launches"][0]["deployed"], "deployment must precede launch")
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, b"", "supervisor added output to the child's stream")
        self.assertEqual(report["after_return"], report["after_drain"],
                         "lifecycle heartbeat continued after supervisor return")
        attempts = report["attempts"]
        self.assertGreaterEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["args"]["state"], "deployed")
        self.assertEqual(attempts[-1]["args"]["state"], "finished" if code == 0 else "failed")
        self.assertEqual({attempt["args"]["run_id"] for attempt in attempts}, {"run-A_1"})
        return attempts

    def check_cadence(self, beat, options):
        result, report = self.probe(options, beat=beat)
        attempts = self.assert_supervised(result, report)
        alive = [attempt["at"] for attempt in attempts if attempt["args"]["state"] == "alive"]
        # An immediate alive is allowed; periodic beats must hit each due deadline.
        periodic = [at for at in alive if at > 0]
        self.assertEqual(len(periodic), 2, "expected both heartbeat deadlines before virtual exit")
        for actual, expected in zip(periodic, (beat, 2 * beat)):
            self.assertAlmostEqual(actual, expected, places=6)
        self.assertTrue(all(at < beat * 2.5 for at in alive), "alive emitted after child exit")
        self.assertEqual(result.stderr, b"")

    def test_m2_default_beat_is_fifteen_virtual_seconds(self):
        self.check_cadence(15, BASE)

    def test_m2_minimum_beat_is_two_virtual_seconds(self):
        self.check_cadence(2, BASE + ["--beat", "2"])

    def test_m2_maximum_beat_is_three_hundred_virtual_seconds(self):
        self.check_cadence(300, BASE + ["--beat", "300"])

    def test_m2_nonzero_exit_has_one_terminal_event_after_heartbeats(self):
        result, report = self.probe(BASE + ["--beat", "2"], beat=2, code=23)
        attempts = self.assert_supervised(result, report, 23)
        self.assertEqual(attempts[-1]["args"].get("reason"), "exit:23")
        self.assertEqual(sum(attempt["args"]["state"] in ("finished", "failed") for attempt in attempts), 1)
        self.assertTrue(any(attempt["args"]["state"] == "alive" for attempt in attempts[1:-1]))

    def test_m1_parent_fields_reach_deployment_transport(self):
        result, report = self.probe(BASE + ["--parent", "orchestrator", "--parent-run", "Parent_A-1",
                                           "--harness", "codex"], parent_seam=True)
        attempts = self.assert_supervised(result, report)
        deployed = attempts[0]["args"]
        self.assertEqual(deployed.get("parent_agent"), "orchestrator")
        self.assertEqual(deployed.get("parent_run_id"), "Parent_A-1")
        self.assertEqual(deployed.get("harness"), "codex")
        for attempt in attempts:
            args = attempt["args"]
            self.assertEqual((args["room"], args["agent"]), ("demo", "exec-a"))
            if "parent_agent" in args or "parent_run_id" in args:
                self.assertEqual((args.get("parent_agent"), args.get("parent_run_id")),
                                 ("orchestrator", "Parent_A-1"))

    def test_m5_transport_contains_only_lifecycle_metadata(self):
        self.env["C1B_CHILD_VALUE"] = "C1B_ENV_SENTINEL"
        result, report = self.probe()
        attempts = self.assert_supervised(result, report)
        for attempt in attempts:
            self.assertLessEqual(set(attempt["args"]), ALLOWED_OP | {"room", "agent"})
            self.assertNotIn("C1B_ENV_SENTINEL", str(attempt["args"]))
            self.assertNotIn("bridge.tests.room.c1b.child", str(attempt["args"]))


def write_loss_case(states, code):
    def test(self):
        result, report = self.probe(BASE + ["--beat", "2"], beat=2, code=code, fail=states)
        attempts = self.assert_supervised(result, report, code)
        self.assertTrue(any(attempt["args"]["state"] == "alive" for attempt in attempts))
        self.assertEqual(sum(attempt["args"]["state"] in ("finished", "failed") for attempt in attempts), 1)
        diagnostics = [line for line in result.stderr.splitlines() if b"lifecycle" in line.lower()]
        self.assertEqual(len(diagnostics), 1, "repeated lifecycle losses must produce one diagnostic")
    return test


for _name, _states, _code in (
    ("deployment", ("deployed",), 0),
    ("heartbeats", ("alive",), 0),
    ("termination", ("finished",), 0),
    ("all_writes_nonzero", ("deployed", "alive", "failed"), 23),
):
    setattr(ClockOracle, "test_m3_write_loss_at_" + _name, write_loss_case(_states, _code))
