"""Emit matched R52P burst evidence as JSON on stdout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


SOURCE = Path("src/app/agent_store.ts")
SHARED_INPUTS = (
    Path("bridge/tests/bench/fixtures.py"),
    Path("bridge/tests/bench/adapters.py"),
    Path("tests/bench/adapter.ts"),
    Path("tests/bench/loader.mjs"),
    Path("tests/bench/oracle.json"),
    Path("src/plan/reducer.ts"),
)
PINNED_CONTROL = "398099878486af4085568186dad23639e3e9f8a335a89572cfbc9759bbadd8d4"
FIXTURE = "10e0c1e5132282c471fa3277cab74b149f70c8cad25b05215eb09db2cda7c5ed"
STREAM = "23dd4fdabda6e73cc48a4703db11105fd599e880f204b663a887cadf7f77cbcb"

SAMPLE = """
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import sys
import tempfile
from unittest.mock import patch

from bridge.tests.bench import adapters as a, fixtures as f

scratch = Path(sys.argv[1])
load = os.getloadavg()
if load[1] > 24:
    sys.exit("five-minute load exceeds the campaign ceiling")
memory = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines()
                  if line.startswith("MemAvailable:")))

@contextmanager
def isolated(fixture):
    with tempfile.TemporaryDirectory(dir=scratch) as tmp:
        home = Path(tmp)
        journal = home / "rooms" / fixture["events"][0]["room"] / "events.jsonl"
        journal.parent.mkdir(parents=True)
        journal.write_bytes(f.admit(f.journal(fixture["events"])))
        with patch.dict(os.environ, {"CW_HOME": str(home)}):
            yield home

with patch.object(a, "isolated", isolated):
    result = a.typescript(f.client_fixture(f.mixed(), "burst"), "burst")
metrics = result["metrics"]
correct = result["actual"] == result["expected"]
fresh = metrics["projection_freshness"]
if not (correct and fresh and result["fixture_sha256"] == sys.argv[2]
        and metrics["client_stream_sha256"] == sys.argv[3]):
    sys.exit("burst correctness, freshness, or fixture identity failed")

print(json.dumps({
    "fixture_sha256": result["fixture_sha256"], "stream_sha256": metrics["client_stream_sha256"],
    "correct": correct, "fresh": fresh, "node": result["runtime"], "python": platform.python_version(),
    "scratch_device": scratch.stat().st_dev, "load": load, "available_kib": memory,
    "ingest_ms": result["elapsed_ms"], "projection_ms": metrics["projection_read_ms"],
    "peak_rss_bytes": result["peak_rss_bytes"],
}))
"""


def digests(root):
    return {path: hashlib.sha256((root / path).read_bytes()).hexdigest()
            for path in (SOURCE, *SHARED_INPUTS)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path)
    args = parser.parse_args()
    roots = {"control": args.control.resolve(), "candidate": args.candidate.resolve()}
    scratch = args.scratch.resolve(strict=True)
    if not scratch.is_dir():
        parser.error("scratch must be an existing directory")

    before = {side: digests(root) for side, root in roots.items()}
    if before["control"][SOURCE] != PINNED_CONTROL:
        parser.error("control source differs from the pre-author source")
    if any(before["control"][p] != before["candidate"][p] for p in SHARED_INPUTS):
        parser.error("benchmark inputs differ across roots")

    evidence = {side: {"source_sha256": values[SOURCE], "samples": []}
                for side, values in before.items()}
    for pair in range(5):
        order = ("control", "candidate") if pair % 2 == 0 else ("candidate", "control")
        for side in order:
            result = subprocess.run([sys.executable, "-B", "-c", SAMPLE, str(scratch), FIXTURE, STREAM],
                                    cwd=roots[side], check=True, capture_output=True, text=True, timeout=30)
            evidence[side]["samples"].append(json.loads(result.stdout))
        control = evidence["control"]["samples"][-1]
        candidate = evidence["candidate"]["samples"][-1]
        if any(control[key] != candidate[key] for key in ("node", "python", "scratch_device")):
            parser.error("paired runtime or scratch medium differs")

    if any(digests(root) != before[side] for side, root in roots.items()):
        parser.error("source or benchmark inputs changed during measurement")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
