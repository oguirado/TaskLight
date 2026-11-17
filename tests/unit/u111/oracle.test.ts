// Explicit mirror of the Python MCP cases for the repository's Vitest entry point.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Record {
  name: string;
  status: "passed" | "failed" | "error";
  detail: string;
}
interface Report {
  count: number;
  records: Record[];
}

const child = spawnSync("python3", ["-B", resolve("tests/unit/u111/run_oracle.py")], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (child.error || child.status !== 0) {
  throw new Error(`U111 runner failed to launch: ${String(child.error)}\n${child.stderr}`);
}
const report = JSON.parse(child.stdout) as Report;
if (report.records.length === 0 || report.records.length !== report.count) {
  throw new Error("U111 discovery must report every unittest exactly once");
}
if (new Set(report.records.map(record => record.name)).size !== report.count) {
  throw new Error("U111 test identifiers must be unique");
}

describe("U111 fail-first MCP oracle (mirrored Python cases)", () => {
  it.each(report.records)("$name", record => {
    expect(record.status, `Infrastructure errors do not count as detection.\n${record.detail}`).not.toBe("error");
    expect(record.status, record.detail).toBe("passed");
  });
});
