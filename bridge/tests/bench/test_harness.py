"""Admission, repeatability, reporting and adversarial controls (no baseline timings)."""
import copy
import json
import math
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from . import fixtures as f
from . import harness as h
from . import run
from . import adapters

GOOD = {"load5": 1.0, "mem_available_bytes": h.MEMORY_FLOOR}


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"seed": 115, "fixture_sha256": "fixture-hash", "journal_bytes": 123, "event_count": 1}
        self.expected = {"accepted": 1}
        self.calls = []

    def work(self, side):
        def callback():
            self.calls.append(side)
            # Instrumented harness test data, never published as performance evidence.
            return {"elapsed_ms": float(len(self.calls)), "actual": self.expected,
                    "work_units": 1, "fixture_sha256": "fixture-hash", "peak_rss_bytes": 1024,
                    "process_scope": "test-double"}
        return callback

    def paired(self, **kw):
        defaults = dict(quiet=True, locked=True, reader=lambda: dict(GOOD))
        defaults.update(kw)
        return h.paired("test-only", "self-pair", self.manifest, self.expected, 1,
                        self.work("base"), self.work("candidate"), **defaults)

    def test_exact_warmups_samples_alternation_and_recomputable_percentiles(self):
        result = self.paired()
        self.assertEqual(result["status"], "PASS")
        self.assertFalse(result["authoritative"])
        self.assertEqual(len(self.calls), 2*(5+30))
        self.assertEqual(self.calls[:6], ["base", "candidate", "candidate", "base", "base", "candidate"])
        self.assertEqual(len(result["pair_records"]), 30)
        for side in ("base", "candidate"):
            values = result["samples_ms"][side]
            self.assertEqual(len(values), 30)
            for field, p in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99)):
                self.assertEqual(result[field][side], sorted(values)[math.ceil(p*30)-1])
            self.assertEqual(result["peak_rss_bytes"][side], 1024)
        for pair in result["pair_records"]:
            self.assertEqual(pair["load_before"], GOOD)
            self.assertEqual(pair["load_after"], GOOD)
            self.assertEqual(set(pair["sides"]), {"base", "candidate"})
        self.assertIn("no speedup", result["reason"])

    def test_nearest_rank_not_interpolation(self):
        self.assertEqual(h.percentile([100, 1, 4, 3], .5), 3)
        self.assertEqual(h.percentile(list(range(1, 31)), .95), 29)
        self.assertEqual(h.percentile(list(range(1, 31)), .99), 30)
        self.assertIsNone(h.percentile([], .95))

    def test_no_work_starts_for_missing_receipt_or_lock(self):
        for kwargs in ({"quiet": False}, {"locked": False}):
            self.calls.clear()
            r = self.paired(**kwargs)
            self.assertEqual(r["status"], "INCONCLUSIVE")
            self.assertEqual(self.calls, [])
            self.assertIsNone(r["p95_ms"]["base"])

    def test_admission_boundary_missing_telemetry_and_memory_floor(self):
        for reading in ({**GOOD, "load5": 18}, {**GOOD, "load5": 24}, {**GOOD, "load5": 25},
                        {**GOOD, "load5": None}, {**GOOD, "load5": float("nan")},
                        {**GOOD, "load5": True}, {**GOOD, "mem_available_bytes": None},
                        {**GOOD, "mem_available_bytes": h.MEMORY_FLOOR-1}):
            with self.subTest(reading=reading):
                self.calls.clear()
                r = self.paired(reader=lambda: reading)
                self.assertEqual(r["status"], "INCONCLUSIVE")
                self.assertEqual(self.calls, [])
                self.assertIsNone(r["samples_ms"]["base"])
        self.assertIsNone(h.admission({**GOOD, "load5": 17.999}, True, True))

    def test_crossing_retains_partial_evidence_and_no_authoritative_baseline(self):
        def reader():
            # Ten warmup calls, then one measured side: contamination is after it.
            return {**GOOD, "load5": 18 if len(self.calls) >= 11 else 1}
        r = self.paired(reader=reader, authoritative=True)
        self.assertEqual(r["status"], "INCONCLUSIVE")
        self.assertEqual(len(r["samples_ms"]["base"]), 1)
        self.assertIsNone(r["samples_ms"]["candidate"])
        self.assertEqual(r["pair_records"][0]["load_after"]["load5"], 18)
        self.assertFalse(r["authoritative"])

    def test_missing_rss_never_passes(self):
        callback = self.work("base")
        def no_rss():
            value = callback()
            value["peak_rss_bytes"] = None
            return value
        r = h.paired("test-only", "missing-rss", self.manifest, self.expected, 1, no_rss, no_rss,
                     quiet=True, locked=True, reader=lambda: dict(GOOD))
        self.assertEqual(r["status"], "INCONCLUSIVE")
        self.assertIn("RSS", r["reason"])
        self.assertEqual(len(r["samples_ms"]["base"]), 30)
        self.assertIsNone(r["peak_rss_bytes"]["base"])

    def test_mismatched_fixture_identity_blocks_even_with_matching_output(self):
        callback = self.work("base")
        def bad():
            value = callback()
            value["fixture_sha256"] = "different-payload"
            return value
        r = h.paired("test-only", "mismatch", self.manifest, self.expected, 1, bad, bad,
                     quiet=True, locked=True, reader=lambda: GOOD)
        self.assertEqual(r["status"], "BLOCK")
        self.assertFalse(r["correctness"]["checks"]["fixture_identity"])

    def test_fast_agreeing_noops_and_adapter_owned_expectations_block(self):
        for actual, units in (({}, 1), (self.expected, 0)):
            bad = lambda: {"actual": actual, "expected": actual, "elapsed_ms": .0001,
                           "fixture_sha256": "fixture-hash", "work_units": units, "peak_rss_bytes": 1024}
            r = h.paired("test-only", "no-op", self.manifest, self.expected, 1, bad, bad,
                         quiet=True, locked=True, reader=lambda: GOOD)
            self.assertEqual(r["status"], "BLOCK")
            self.assertIsNone(r["samples_ms"]["base"])

    def test_heartbeat_mock_cannot_measure_swarm_derivation(self):
        expected = f.reservations()["swarm"]["expected_cards"]
        fake = lambda: {"actual": {"heartbeats": 15}, "fixture_sha256": "fixture-hash",
                        "work_units": 15, "elapsed_ms": .001, "peak_rss_bytes": 1024}
        result = h.paired("swarm-vm-derive", "heartbeat-mutant", self.manifest, expected, 15, fake, fake,
                          quiet=True, locked=True, reader=lambda: GOOD)
        self.assertEqual(result["status"], "BLOCK")

    def test_infrastructure_failure_is_inconclusive(self):
        def unavailable():
            raise OSError("fixture runner unavailable")
        r = h.paired("test-only", "infra", self.manifest, {}, 1, unavailable, unavailable,
                     quiet=True, locked=True, reader=lambda: GOOD)
        self.assertEqual(r["status"], "INCONCLUSIVE")
        self.assertIsNone(r["correctness"]["ok"])

    def test_failed_native_adapter_retains_command_exit_and_output_hashes(self):
        from types import SimpleNamespace
        fixture = f.mixed(size=13)
        with patch.object(adapters.subprocess, "run", return_value=SimpleNamespace(returncode=7, stdout=b"", stderr=b"synthetic failure")):
            def failed():
                return adapters.typescript(fixture, "fold")
            r = h.paired("test-only", "native-failure", fixture["manifest"], {}, 1, failed, failed,
                         quiet=True, locked=True, reader=lambda: GOOD)
        self.assertEqual(r["status"], "INCONCLUSIVE")
        receipt = r["execution_failures"][0]
        self.assertEqual(receipt["exit_code"], 7)
        self.assertEqual(receipt["command"][0], "node")
        self.assertEqual(receipt["stderr_sha256"], f.sha(b"synthetic failure"))

    def test_correctness_block_survives_simultaneous_load_crossing(self):
        def bad():
            self.calls.append("broken")
            return {"actual": {}, "work_units": 0, "fixture_sha256": "fixture-hash"}
        r = h.paired("test-only", "broken", self.manifest, self.expected, 1, bad, bad,
                     quiet=True, locked=True, reader=lambda: {**GOOD, "load5": 18 if self.calls else 1})
        self.assertEqual(r["status"], "BLOCK")

    def test_exclusive_lock_rejects_overlap(self):
        with h.timing_lock() as first:
            with h.timing_lock() as second:
                self.assertTrue(first)
                self.assertFalse(second)

    def test_receipt_must_be_explicit_grant_unexpired_and_quiet(self):
        with f.isolated() as home:
            path = home / "receipt.json"
            self.assertIsNone(h.read_receipt(None))
            receipt = {"schema": "tasklight-bench/quiet-window-v1", "granted": True, "exclusive": True,
                       "verification_running": False, "expires_at": time.time()+60}
            path.write_bytes(f.encoded(receipt))
            self.assertEqual(h.read_receipt(path)["sha256"], f.sha(path.read_bytes()))
            for key, value in (("granted", False), ("exclusive", False), ("verification_running", True),
                               ("expires_at", 0), ("expires_at", None)):
                path.write_bytes(f.encoded({**receipt, key: value}))
                self.assertIsNone(h.read_receipt(path))

    def test_unavailable_metrics_are_null_and_complete_registry_is_explicit(self):
        with patch.object(run, "read_receipt", return_value=None):
            reports = run.run_all()
        self.assertEqual({r["benchmark"] for r in reports}, {r[0] for r in run.registry()})
        for r in reports:
            self.assertEqual(r["status"], "INCONCLUSIVE")
            self.assertIsNone(r["p95_ms"]["base"])
            self.assertIsNone(r["peak_rss_bytes"]["candidate"])
        life = next(r for r in reports if r["benchmark"] == "lifecycle-burst")
        self.assertEqual(life["counts"]["attempted"], 105)
        self.assertIsNone(life["counts"]["committed"])
        self.assertIsNone(life["journal_bytes"])
        self.assertIsNone(life["bytes_per_committed_event"])
        for name in ("swarm-vm-derive", "lifecycle-burst", "room-recover-checkpoint"):
            self.assertIn("AUSENTE", next(r for r in reports if r["benchmark"] == name)["reason"])

    def test_public_json_hash_summary_and_output_scope(self):
        with f.isolated() as home:
            path = home / "report.json"
            report = h.report("test-only", "unavailable", reason="AUSENTE")
            digest = run.write_reports([report], path)
            self.assertEqual(f.sha(path.read_bytes()), digest)
            self.assertIn(digest, path.with_suffix(".md").read_text())
            loaded = json.loads(path.read_text())[0]
            for field in ("benchmark", "variant", "status", "reason", "base", "candidate", "seed", "fixture_sha256",
                          "journal_bytes", "samples_ms", "p50_ms", "p95_ms", "p99_ms", "peak_rss_bytes", "load5", "correctness"):
                self.assertIn(field, loaded)
        for path in ("package.json", "tests/unit/escaped.json", "../escaped.json"):
            with self.assertRaises(ValueError):
                run.output_path(path)

    def test_report_validator_rejects_forged_pass_and_bad_percentiles(self):
        r = self.paired()
        self.assertIs(h.validate_report(r), r)
        broken = copy.deepcopy(r)
        broken["p95_ms"]["base"] = 0
        with self.assertRaisesRegex(ValueError, "percentiles"):
            h.validate_report(broken)
        broken = copy.deepcopy(r)
        broken["peak_rss_bytes"]["base"] = None
        with self.assertRaisesRegex(ValueError, "complete measurements"):
            h.validate_report(broken)
        broken = copy.deepcopy(r)
        broken["correctness"]["actual"] = {}
        with self.assertRaisesRegex(ValueError, "frozen correctness"):
            h.validate_report(broken)

    def test_targets_do_not_reject_valid_baselines(self):
        r = h.report("fold-mixed-10k", "python")
        r.update(status="PASS", p95_ms={"base": 900, "candidate": 900})
        run.target_assessment(r)
        self.assertEqual(r["status"], "PASS")
        self.assertFalse(r["optimization_target"]["candidate_meets"])


if __name__ == "__main__":
    unittest.main()
