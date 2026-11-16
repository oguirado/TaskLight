import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Vitest does not collect .py files. Execute the stdlib suite once and expose
// each unittest result separately in the combined acceptance command.
const root = process.cwd();
const run = spawnSync("python3", ["-B", "-c", `
import json, sys, unittest
records = []
class Result(unittest.TextTestResult):
    def addSuccess(self, test):
        super().addSuccess(test)
        records.append({"name": test.id().split(".")[-1], "status": "passed", "detail": ""})
    def addFailure(self, test, err):
        super().addFailure(test, err)
        records.append({"name": test.id().split(".")[-1], "status": "failed", "detail": self.failures[-1][1]})
    def addError(self, test, err):
        super().addError(test, err)
        records.append({"name": test.id().split(".")[-1], "status": "error", "detail": self.errors[-1][1]})
suite = unittest.defaultTestLoader.discover("bridge/tests/room/u76", pattern="test_*.py")
unittest.TextTestRunner(stream=sys.stderr, resultclass=Result).run(suite)
print(json.dumps(records))
`], { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 });

if (run.error || run.status !== 0) throw new Error(`Python test harness failed: ${String(run.error)}\n${run.stderr}`);
const records = JSON.parse(run.stdout) as { name: string; status: string; detail: string }[];
if (records.length === 0) throw new Error("No U76 unittest cases discovered");

describe("U76 stdlib MCP oracle", () => {
  it.each(records)("$name", record => {
    expect(record.status, record.detail).toBe("passed");
  });
});
