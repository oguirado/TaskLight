import { spawnSync } from "node:child_process";
import type { Fixture } from "./adapter";
export function fixture(size = 10_000, seed = 115): Fixture {
  const result = spawnSync("python3", ["-B", "-m", "bridge.tests.bench.fixtures", "--size", String(size), "--seed", String(seed)], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.status !== 0) throw new Error("synthetic fixture generator failed");
  return JSON.parse(result.stdout) as Fixture;
}

export function clientFixture(kind: "history" | "burst"): Fixture {
  const result = spawnSync("python3", ["-B", "-c",
    "from bridge.tests.bench.fixtures import mixed,client_fixture,encoded; import sys; print(encoded(client_fixture(mixed(),sys.argv[1])).decode())", kind],
    { encoding: "utf8", maxBuffer: 8*1024*1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (result.status !== 0) throw new Error("synthetic client fixture generator failed");
  return JSON.parse(result.stdout) as Fixture;
}
