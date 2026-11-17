"""Run the mirrored Python oracle once and return one record per unittest."""
import io
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
records = []


class Results(unittest.TextTestResult):
    def record(self, test, status, detail=""):
        records.append({"name": test.id().split(".")[-1], "status": status,
                        "detail": detail.replace(str(ROOT), ".")})

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "passed")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.record(test, "failed", self.failures[-1][1])

    def addError(self, test, err):
        super().addError(test, err)
        self.record(test, "error", self.errors[-1][1])

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            is_failure = issubclass(err[0], test.failureException)
            target = self.failures if is_failure else self.errors
            # Report a parameterized method once, retaining its first failure.
            if not any(r["name"] == test.id().split(".")[-1] for r in records):
                self.record(test, "failed" if is_failure else "error", target[-1][1])


suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_*.py")
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, resultclass=Results).run(suite)
print(json.dumps({"count": result.testsRun, "records": records}, ensure_ascii=True))
