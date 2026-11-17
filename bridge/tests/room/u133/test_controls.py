"""A6: discriminating contract mutants; infrastructure never counts."""
import copy
import hashlib
import json

from .support import Boundary, HERE, HookCase, L, digest, encode, payload, work_projection


class ControlOracle(HookCase):
    def replay_oracle(self, boundary, dispatch=None):
        request = payload("alive")
        first = self.invoke(request, dispatch or boundary)
        self.assertIs(first.get("untrusted", {}).get("ok"), True, "replay positive premise failed")
        before = copy.deepcopy(boundary.events)
        boundary.now_ms += 30001
        second = self.invoke(request, dispatch or boundary)
        self.assertIs(second.get("untrusted", {}).get("ok"), True, "replay positive premise failed")
        self.assertEqual(boundary.events, before, "replay appended a second lifecycle mutation")
        self.assertEqual(second, first, "replay changed the original Lamport")

    def test_a6_unstable_id_mutant_is_detected_after_throttle_window(self):
        self.replay_oracle(Boundary())  # Nominal path must pass first.
        boundary = Boundary()
        counter = 0
        def unstable(name, args):
            nonlocal counter
            if name == "agent_lifecycle":
                counter += 1
                args = dict(args, op_id=digest(["unstable-id", counter]))
            return boundary(name, args)
        with self.assertRaisesRegex(AssertionError, "replay appended"):
            self.replay_oracle(boundary, unstable)

    def test_a6_cleanup_omission_mutant_is_detected(self):
        nominal = Boundary(work_projection())
        self.invoke(payload("failed"), nominal)
        self.assert_cleaned(nominal.projection)
        boundary = Boundary(work_projection())
        def omitted(name, args):
            if name == "task_release":
                return {"untrusted": {"ok": True, "lamport": L}}
            return boundary(name, args)
        self.invoke(payload("failed"), omitted)
        with self.assertRaisesRegex(AssertionError, "cleanup omitted"):
            self.assert_cleaned(boundary.projection)

    def claim_oracle(self, strip_fence=False):
        boundary = Boundary(work_projection())
        def race(b, args):
            if args["task_id"] == "T01":
                b.projection["tasks"][0].update(claim_lamport=L + 1, rev=args["base_rev"])
        boundary.on_release = race
        def dispatch(name, args):
            if name == "task_release" and strip_fence:
                args = {k: v for k, v in args.items() if k != "claim_lamport"}
            return boundary(name, args)
        self.invoke(payload("failed"), dispatch)
        self.assertEqual(boundary.projection["tasks"][0]["assignee"], "exec-a",
                         "claim fence lost successor ownership")

    def test_a6_claim_fence_omission_mutant_is_detected_after_read_race(self):
        self.claim_oracle()
        with self.assertRaisesRegex(AssertionError, "claim fence lost successor ownership"):
            self.claim_oracle(strip_fence=True)

    def test_a6_infrastructure_failure_is_never_mutant_detection(self):
        def broken(name, args):
            raise RuntimeError("fixture infrastructure unavailable")
        result = self.invoke(payload("alive"), broken)
        self.assert_error(result, "internal")
        # An internal error cannot satisfy the positive premise of a replay
        # oracle, and no assertRaises(Exception) is used to count detection.
        self.assertNotIn("untrusted", result)

    def test_hardening_200_events_fixed_clock_growth_and_cleanup(self):
        fixture_bytes = (HERE / "fixtures.json").read_bytes()
        fixture = json.loads(fixture_bytes)
        boundary = Boundary(work_projection())
        results = []
        for item in fixture["burst"]:
            boundary.now_ms = item["at_ms"]
            before = len(boundary.events)
            result = self.invoke(item["payload"], boundary)
            self.assertIs(result.get("untrusted", {}).get("ok"), True)
            results.append({"appended": len(boundary.events) - before,
                            "fixture_sha256": hashlib.sha256(encode(item["payload"])).hexdigest()})
        self.assertEqual(len(fixture["burst"]), 200)
        self.assertEqual(len([e for e in boundary.events if e[0] == "agent_lifecycle"]), 4)
        self.assertEqual(len([e for e in boundary.events if e[0] == "task_release"]), 2)
        self.assertEqual(len([v for v in results if v["appended"] == 0]), 196)
        self.assert_cleaned(boundary.projection)
        # Synthetic clocks establish correctness only, never wall-time PASS.
        report = {"fixture_sha256": hashlib.sha256(fixture_bytes).hexdigest(),
                  "calls": results, "event_count": len(boundary.events),
                  "encoded_event_bytes": len(encode(boundary.events)),
                  "wall_time_status": "INCONCLUSIVE", "wall_times": None,
                  "load5": None, "cleanup": "complete"}
        (self.home / "hardening.json").write_text(json.dumps(report))
