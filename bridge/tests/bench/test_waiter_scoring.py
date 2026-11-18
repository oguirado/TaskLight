"""Regression checks for paired waiter scoring."""
import json
import unittest
from unittest.mock import patch

from . import measure_waiter_churn as churn
from . import waiter_fixture as fixture
from .fixtures import journal


class WaiterScoringTests(unittest.TestCase):
    def score(self, baseline, candidate, name="cold_full"):
        sample = {"inputs": {}, "aggregate_cpu_ns": 1000, "heartbeat_repeat_folds": 0}
        observations = {"baseline": {**sample, **baseline},
                        "candidate": {**sample, **candidate}}
        with patch.object(churn, "measure", side_effect=lambda tree, *_: observations[tree]):
            return churn.paired(name, "baseline", "candidate", None, None)

    def test_rss_reduction_passes(self):
        report = self.score({"peak_rss_bytes": 1000}, {"peak_rss_bytes": 811})
        self.assertTrue(report["passed"])
        self.assertAlmostEqual(report["median_paired_peak_rss_improvement"], 0.189)

    def test_rss_regression_boundary(self):
        for peak_rss, expected in ((1100, True), (1110, False)):
            with self.subTest(peak_rss=peak_rss):
                report = self.score({"peak_rss_bytes": 1000}, {"peak_rss_bytes": peak_rss})
                self.assertEqual(report["passed"], expected)

    def test_cpu_regression_limit_is_one_sided(self):
        baseline = {"peak_rss_bytes": 1000}
        for cpu, expected in ((811, True), (1100, True), (1110, False)):
            with self.subTest(cpu=cpu):
                report = self.score(baseline, {**baseline, "aggregate_cpu_ns": cpu})
                self.assertEqual(report["passed"], expected)

    def test_concurrent_heartbeat_requires_twenty_percent_cpu_reduction(self):
        baseline = {"peak_rss_bytes": 1000}
        for cpu, expected in ((800, True), (801, False)):
            with self.subTest(cpu=cpu):
                report = self.score(baseline, {**baseline, "aggregate_cpu_ns": cpu},
                                    name="concurrent_heartbeat")
                self.assertEqual(report["passed"], expected)

    def test_zero_or_missing_baseline_holds(self):
        candidate = {"peak_rss_bytes": 1000}
        for baseline in ({"peak_rss_bytes": 0}, {}, {"peak_rss_bytes": None},
                         {"peak_rss_bytes": 1000, "aggregate_cpu_ns": 0}):
            with self.subTest(baseline=baseline):
                report = self.score(baseline, candidate)
                self.assertFalse(report["passed"])
                self.assertIn("baseline", report["hold_reason"])

    def test_missing_trial_holds(self):
        with patch.object(churn, "measure", side_effect=churn.TrialError("waiter sample is missing")):
            report = churn.paired("cold_full", "baseline", "candidate", None, None)
        self.assertFalse(report["passed"])
        self.assertIn("waiter sample is missing", report["hold_reason"])

    def test_near_cap_concurrent_latency_and_repeat_folds_are_gated(self):
        baseline = {"peak_rss_bytes": 1000, "slowest_terminal_latency_ns": 1000,
                    "heartbeat_repeat_folds": 50}
        for latency, folds, expected in ((1100, 0, True), (1110, 0, False), (1000, 1, False)):
            with self.subTest(latency=latency, folds=folds):
                candidate = {**baseline, "aggregate_cpu_ns": 800,
                             "slowest_terminal_latency_ns": latency,
                             "heartbeat_repeat_folds": folds}
                report = self.score(baseline, candidate, name="near_cap_heartbeat_4")
                self.assertEqual(report["passed"], expected)

    def test_near_cap_reserves_the_exact_pinned_suffix(self):
        from bridge.room import store

        workloads = churn.near_cap_workloads(store.CAP)
        writes = list(fixture.scheduled_writes())
        for waiters in (1, 4):
            initial, chunks, schedule, count, args, reply = workloads[f"near_cap_heartbeat_{waiters}"]
            self.assertEqual(count, waiters)
            self.assertEqual(list(schedule), [when for when, _ in writes])
            suffix = b"".join(chunk.encode() for chunk in chunks)
            self.assertEqual(suffix, journal(row for _, row in writes))
            self.assertEqual(len(initial), store.CAP - len(suffix))
            self.assertEqual(json.loads(initial.splitlines()[-1])["lamport"], fixture.HEAD)
            self.assertGreater(args["timeout_s"], schedule[-1])
            self.assertEqual(reply["events"][0]["lamport"], writes[-1][1]["lamport"])
            idle = workloads[f"near_cap_no_write_{waiters}"]
            self.assertIs(idle[0], initial)
            self.assertEqual(idle[1:4], ([], [], waiters))
            self.assertTrue(idle[-1]["timed_out"])
