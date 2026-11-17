"""File-backed runner for existing room suites and multiprocessing spawn."""
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

from .support import HERE, ROOT


def existing(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from existing(item)
        elif ".u132." not in item.id() and ".u133." not in item.id():
            yield item


def main():
    suite = unittest.defaultTestLoader.discover(str(ROOT / "bridge/tests/room"),
                                              top_level_dir=str(ROOT))
    stream = io.StringIO()
    popen = subprocess.Popen
    def without_bytecode(args, *positional, **keywords):
        # Some legacy helpers use isolated Python and strip Python environment
        # variables. Keep their bytecode artifacts out of the product tree too.
        if isinstance(args, (list, tuple)) and args and Path(str(args[0])).name.startswith("python"):
            args = [args[0], "-B", *args[1:]]
        return popen(args, *positional, **keywords)
    with mock.patch.object(subprocess, "Popen", side_effect=without_bytecode):
        result = unittest.TextTestRunner(stream=stream, verbosity=1).run(unittest.TestSuite(existing(suite)))
    print("\n".join(stream.getvalue().splitlines()[-4:]))
    report = {"tests": result.testsRun, "failures": [t.id() for t, _ in result.failures],
              "errors": [t.id() for t, _ in result.errors], "skips": [t.id() for t, _ in result.skipped]}
    path = HERE / "regressions.json"
    if "--snapshot" in sys.argv:
        path.write_text(json.dumps(report, indent=2) + "\n")
    if "--compare" in sys.argv:
        baseline = json.loads(path.read_text())
        if report != baseline:
            print("Regression comparison: CHANGED")
            return 1
        print("Regression comparison: UNCHANGED")
    print(json.dumps(report))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
