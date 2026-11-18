"""Paired checked-reader benchmark on the frozen R52R cap fixture."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
from statistics import median
import subprocess
import sys
import tempfile
import time

from bridge.room import store
from bridge.tests.bench import adapters, fixtures, harness


CAP_BYTES = 16 * 1024 * 1024
CAP_SHA256 = "af82737d7e67970859f1148a3b65960344050ea12b4f7e62ab93d9ae48730aa0"
PAIRS = 5
WORKLOADS = ("cold-full", "warm-recent", "invalidated-prefix")
VARIANTS = ("baseline", "candidate")


def full_checked_read(room, since, *, home):
    """Pre-R52R control, including file admission and full parse before filtering."""
    store._check_room(room)
    if not store._is_int(since) or since < 0:
        raise store.RoomError("bad_args", "since must be a non-negative integer")
    reason = "Room data could not be read."

    def open_readonly(path, flags):
        return os.open(path, flags | getattr(os, "O_NONBLOCK", 0))

    path = store._events_path(home, room)
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            raise store.RoomError("room_read_failed", reason)
        with open(path, "rb", opener=open_readonly) as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise store.RoomError("room_read_failed", reason)
            data = stream.read()
    except OSError:
        raise store.RoomError("room_read_failed", reason) from None

    events, malformed = full_parse(data)
    if malformed or any(event["room"] != room for event in events):
        raise store.RoomError("room_read_failed", reason)
    return [event for event in events if event["lamport"] > since], 0


def full_parse(data):
    """Keep the control's split and decode independent of the candidate."""
    if not data:
        return [], 0
    ends = data.endswith(b"\n")
    parts = data.split(b"\n")
    events, malformed = [], 0
    for i, raw in enumerate(parts):
        is_last = i == len(parts) - 1
        if ends and is_last:
            continue
        if not ends and is_last:
            continue
        if raw.strip() == b"":
            continue
        try:
            line = raw.decode("utf-8")
        except Exception:
            malformed += 1
            continue
        try:
            obj = json.loads(line)
        except Exception:
            malformed += 1
            continue
        if not isinstance(obj, dict):
            malformed += 1
            continue
        if not store._is_valid_event(obj):
            malformed += 1
            continue
        events.append(obj)
    return events, malformed


def fixture_bytes(path):
    with path.open("rb") as stream:
        data = stream.read(CAP_BYTES + 1)
    if len(data) != CAP_BYTES or fixtures.sha(data) != CAP_SHA256:
        raise ValueError("fixture does not match the pinned R52R cap length and SHA-256")
    if store.CAP != CAP_BYTES:
        raise ValueError("runtime journal cap does not match the R52R cap")
    return data


def invalidate_prefix(journal, data, head):
    """Rewrite an interior row in place and append a later complete row."""
    start = data.index(b"\n", len(data) // 3) + 1
    end = data.index(b"\n", start) + 1
    changed = json.loads(data[start:end])
    changed["lamport"] = head + 1
    replacement = fixtures.journal([changed])
    if len(replacement) != end - start:
        raise ValueError("interior rewrite would shift record boundaries")
    appended = fixtures.journal([fixtures.event(head + 2, text="paired append")])
    with journal.open("r+b") as stream:
        stream.seek(start)
        stream.write(replacement)
        stream.seek(0, os.SEEK_END)
        stream.write(appended)


def sample(workload, variant, fixture, scratch):
    telemetry = harness.telemetry()
    if any(value is None for value in telemetry.values()):
        raise RuntimeError("load or available memory is AUSENTE")
    data = fixture_bytes(fixture)
    # A lexical Lamport scan avoids warming the checked parser before cold-full.
    # The byte-pinned fixture consists of single-line canonical JSON objects.
    head = max(int(value) for value in re.findall(rb'"lamport":([0-9]+)', data))
    since = 0 if workload == "cold-full" else head - 1
    reader = full_checked_read if variant == "baseline" else store.read_checked

    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        home = Path(directory)
        journal = home / "rooms" / fixtures.ROOM / "events.jsonl"
        journal.parent.mkdir(parents=True)
        journal.write_bytes(data)
        seed_sha = None
        if workload != "cold-full":
            seed = reader(fixtures.ROOM, since, home=home)
            seed_sha = fixtures.sha(fixtures.encoded(seed))
            del seed
        if workload == "invalidated-prefix":
            invalidate_prefix(journal, data, head)
        del data

        start = time.perf_counter_ns()
        reply = reader(fixtures.ROOM, since, home=home)
        elapsed_ns = time.perf_counter_ns() - start
        peak_rss_bytes = adapters.rss_bytes()
        events, malformed = reply
        if not events or malformed != 0:
            raise ValueError("checked reader failed to return a clean replay")

        return {
            "variant": variant, "runtime": sys.version,
            **telemetry,
            "scratch_device": journal.stat().st_dev, "store_cap_bytes": store.CAP,
            "since": since, "fixture_sha256": CAP_SHA256, "seed_result_sha256": seed_sha,
            "journal_sha256": fixtures.sha(journal.read_bytes()),
            "result_sha256": fixtures.sha(fixtures.encoded(reply)),
            "elapsed_ns": elapsed_ns, "peak_rss_bytes": peak_rss_bytes,
        }


def paired_report(fixture, scratch):
    workloads = {}
    match_keys = ("runtime", "scratch_device", "store_cap_bytes", "since",
                  "fixture_sha256", "journal_sha256", "seed_result_sha256", "result_sha256")
    for workload in WORKLOADS:
        pairs = []
        for index in range(PAIRS):
            order = VARIANTS if index % 2 == 0 else VARIANTS[::-1]
            samples = {}
            for variant in order:
                result = subprocess.run(
                    [sys.executable, "-B", "-m", "bridge.tests.bench.measure_checked_prefix",
                     "--fixture", str(fixture), "--scratch", str(scratch),
                     "--sample", workload, variant],
                    cwd=fixtures.ROOT, check=True, capture_output=True, text=True, timeout=30,
                )
                samples[variant] = json.loads(result.stdout)
            baseline, candidate = (samples[variant] for variant in VARIANTS)
            for key in match_keys:
                if baseline[key] != candidate[key]:
                    raise RuntimeError(f"{workload} pair {index + 1} differs in {key}")
            pairs.append({
                "order": order, **samples,
                "improvement_fraction": 1 - candidate["elapsed_ns"] / baseline["elapsed_ns"],
                "rss_overhead_fraction": candidate["peak_rss_bytes"] / baseline["peak_rss_bytes"] - 1,
            })
        improvement = median(pair["improvement_fraction"] for pair in pairs)
        rss_overhead = median(pair["rss_overhead_fraction"] for pair in pairs)
        candidate_ms = median(pair["candidate"]["elapsed_ns"] for pair in pairs) / 1_000_000
        time_pass = (candidate_ms <= 20 and improvement >= 0.35
                     if workload == "warm-recent" else improvement >= -0.10)
        workloads[workload] = {
            "pairs": pairs, "median_paired_improvement_fraction": improvement,
            "median_paired_rss_overhead_fraction": rss_overhead,
            "median_candidate_ms": candidate_ms,
            "time_pass": time_pass, "rss_pass": rss_overhead <= 0.10,
        }

    return {
        "fixture_sha256": CAP_SHA256, "fixture_bytes": CAP_BYTES,
        "template_inputs": [],  # Checked reads validate wire shape without loading templates.
        "workloads": workloads,
        "pass": all(value["time_pass"] and value["rss_pass"] for value in workloads.values()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True, help="frozen R52R journal bytes")
    parser.add_argument("--sample", nargs=2, metavar=("WORKLOAD", "VARIANT"), help=argparse.SUPPRESS)
    parser.add_argument("--scratch", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    fixture = args.fixture.resolve()
    try:
        if args.sample:
            workload, variant = args.sample
            if workload not in WORKLOADS or variant not in VARIANTS or args.scratch is None:
                parser.error("invalid sample arguments")
            print(json.dumps(sample(workload, variant, fixture, args.scratch)))
            return 0
        if args.scratch is not None:
            parser.error("--scratch requires an internal sample")
        fixture_bytes(fixture)
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            report = paired_report(fixture, Path(directory))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.exit(2, f"benchmark stopped: {exc}\n")
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
