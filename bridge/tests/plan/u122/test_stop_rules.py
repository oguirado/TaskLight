"""Synthetic admission checks only: these are never performance evidence."""
import unittest
from unittest import mock

from bridge.tests.bench import harness


class HardeningStopRules(unittest.TestCase):
    good = {"load5": 0, "mem_available_bytes": 20 * 1024**3}

    def pair(self, callback, reader, quiet=True, locked=True):
        return harness.paired("fold-mixed-10k", "python", {"fixture_sha256": "synthetic-fixture"},
            {"correct": True}, 1, callback, callback, quiet=quiet, locked=locked,
            reader=reader, authoritative=False)

    def test_missing_quiet_window_or_lock_stops_before_any_work(self):
        for quiet, locked in ((False, True), (True, False)):
            with self.subTest(quiet=quiet, locked=locked):
                callback = mock.Mock(side_effect=AssertionError("work before admission"))
                result = self.pair(callback, lambda: self.good, quiet, locked)
                callback.assert_not_called()
                self.assertEqual(result["status"], "INCONCLUSIVE")
                self.assertEqual(result["samples_ms"], {"base": None, "candidate": None})
                self.assertFalse(result["authoritative"])

    def test_missing_telemetry_and_load_memory_boundaries_stop_before_work(self):
        readings = [
            {}, {"load5": None, "mem_available_bytes": self.good["mem_available_bytes"]},
            {"load5": False, "mem_available_bytes": self.good["mem_available_bytes"]},
            {"load5": 0, "mem_available_bytes": None},
            {"load5": 0, "mem_available_bytes": False},
            {"load5": 18, "mem_available_bytes": self.good["mem_available_bytes"]},
            {"load5": 0, "mem_available_bytes": self.good["mem_available_bytes"] - 1},
        ]
        for reading in readings:
            with self.subTest(reading=reading):
                callback = mock.Mock(side_effect=AssertionError("contaminated run executed"))
                result = self.pair(callback, lambda: reading)
                callback.assert_not_called()
                self.assertEqual(result["status"], "INCONCLUSIVE")
                self.assertIsNone(result["p95_ms"]["candidate"])

    def test_semantic_divergence_blocks_before_timing_claims(self):
        callback = mock.Mock(return_value={"actual": {"correct": False}, "work_units": 1, "fixture_sha256": "synthetic-fixture"})
        result = self.pair(callback, lambda: self.good)
        callback.assert_called_once()
        self.assertEqual(result["status"], "BLOCK")
        self.assertFalse(result["correctness"]["ok"])
        self.assertIsNone(result["p95_ms"]["candidate"])

    def test_synthetic_schedule_pins_warmups_pairs_and_does_not_claim_speedup(self):
        callback = mock.Mock(return_value={"actual": {"correct": True}, "work_units": 1,
            "fixture_sha256": "synthetic-fixture", "elapsed_ms": 1, "peak_rss_bytes": 1,
            "process_scope": "synthetic-only"})
        result = self.pair(callback, lambda: self.good)
        self.assertEqual(harness.WARMUPS, 5)
        self.assertEqual(harness.OBSERVATIONS, 30)
        self.assertEqual(result["completed_warmups"], {"base": 5, "candidate": 5})
        self.assertEqual(result["completed_observations"], {"base": 30, "candidate": 30})
        self.assertEqual(callback.call_count, 70)
        self.assertEqual(len(result["pair_records"]), 30)
        self.assertFalse(result["authoritative"])
        self.assertEqual(result["comparison"], "repeatability; no speedup claim")
        self.assertEqual(result["base"], "working-copy-self")
        self.assertEqual(result["candidate"], "working-copy-self")
