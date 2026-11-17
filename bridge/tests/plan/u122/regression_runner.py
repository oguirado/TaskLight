"""Run existing Python gates with scratch writes confined to this directory.

Invoke as a module. Existing test source and expectations are never rewritten.
The U122 discovery command is separate and deliberately remains red.
"""
from contextlib import ExitStack
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from .support import HERE, ROOT


def flatten(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from flatten(test)
        else:
            yield test


def main():
    reference = json.loads((HERE / "reference.json").read_text())
    hashes = reference["artifact_sha256"]
    before = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in hashes}
    loader = unittest.TestLoader()
    plan = unittest.TestSuite(test for test in flatten(loader.discover(str(ROOT / "bridge/tests/plan"), top_level_dir=str(ROOT)))
                              if not test.id().startswith("bridge.tests.plan.u122."))
    room_names = ["bridge.tests.room.u109.test_fold", "bridge.tests.room.test_post.Shape",
        "bridge.tests.room.test_post.Codes", "bridge.tests.room.test_read.Read",
        "bridge.tests.room.test_read.Inbox", "bridge.tests.room.test_read.Status"]
    room = unittest.TestSuite(test for test in flatten(loader.loadTestsFromNames(room_names))
                              if not test.id().endswith("test_default_clock_is_epoch_ms"))
    prop = loader.discover(str(ROOT / "bridge/tests/property"), top_level_dir=str(ROOT))
    from bridge.tests.property import support as property_support
    from bridge.tests.property import test_semantics as property_semantics
    report = {"schema": "u122-regressions/v1", "scope": "existing Python plan suite, selected in-process room suites, full Python U116 suite", "groups": {}}
    real_mkdtemp = tempfile.mkdtemp
    with tempfile.TemporaryDirectory(prefix="regressions-", dir=HERE) as directory:
        scratch = Path(directory)
        def confined_mkdtemp(suffix=None, prefix=None, dir=None):
            return real_mkdtemp(suffix=suffix, prefix=prefix, dir=scratch)
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(tempfile, "mkdtemp", confined_mkdtemp))
            # Fixtures were imported from their original read-only locations;
            # only generated evidence is redirected into the authorized surface.
            stack.enter_context(mock.patch.object(property_support, "PUBLIC", scratch))
            stack.enter_context(mock.patch.object(property_semantics, "PUBLIC", scratch))
            stack.enter_context(mock.patch("socket.socket", side_effect=AssertionError("network forbidden in selected regression gates")))
            for name, suite in (("plan", plan), ("room-selected", room), ("u116-python", prop)):
                output = io.StringIO()
                result = unittest.TextTestRunner(stream=output).run(suite)
                record = {"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
                    "skipped": len(result.skipped), "exit_code": 0 if result.wasSuccessful() else 1,
                    "failure_ids": [test.id() for test, _ in result.failures],
                    "error_ids": [test.id() for test, _ in result.errors],
                    "summary": "OK" if result.wasSuccessful() else "FAILED (failures=%d, errors=%d)" % (len(result.failures), len(result.errors))}
                report["groups"][name] = record
                print(name + ": " + json.dumps(record, sort_keys=True))
                if not result.wasSuccessful():
                    print(output.getvalue().replace(str(ROOT), ".")[-5000:])
    after = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in hashes}
    report["captured_sources_unchanged"] = before == after
    report["matches_pre_u122_reference"] = before == hashes
    conflicting = "bridge.tests.property.test_storage.StorageProperties.test_conflicting_same_op_id_retains_first_result_without_other_mutation"
    report["outside_u122"] = []
    if conflicting in report["groups"]["u116-python"]["error_ids"]:
        report["outside_u122"].append({
            "test": conflicting,
            "observed": "RoomError: bad_op: op_id conflict",
            "reason": "Existing transport/store disagreement about conflicting request bodies",
            "status": "BLOCKED",
            "source_sha256": {"bridge/room/store.py": hashlib.sha256((ROOT / "bridge/room/store.py").read_bytes()).hexdigest()}
        })
    (HERE / "regressions.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0 if report["captured_sources_unchanged"] and all(row["exit_code"] == 0 for row in report["groups"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
