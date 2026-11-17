"""CLI registry. Publication and optimization admission remain external decisions."""
import argparse
import copy
import json
from pathlib import Path
import sys

from . import adapters
from .fixtures import ROOT, SEED, mixed, near_cap, reservations, encoded, sha, journal, client_fixture, concurrency_fixture
from .harness import paired, report, read_receipt, timing_lock, telemetry, validate_report


def registry():
    return [
        ("fold-mixed-10k", "python", "fold_plan(events, templates)", 10_000),
        ("fold-mixed-10k", "typescript", "foldPlan(events, template)", 10_000),
        ("wall-plan-cache", "cached-plan", "one warmed plan(room) read", 1),
        ("wall-plan-cache", "states", "one warmed states() read", 1),
        ("wall-plan-cache", "ingest-read", "one ingest followed by plan(room) and states()", 3),
        ("room-tail-near-cap", "latest", "real dispatcher latest page; setup/parse counter excluded", 1),
        ("room-tail-near-cap", "filtered", "real dispatcher filtered page", 1),
        ("room-tail-near-cap", "future", "real dispatcher future-cursor resync", 1),
        ("wall-history-soak", "history", "sum of client ingestion chunks; generation/heap checks excluded", 100_000),
        ("wall-event-burst", "ingestion", "fixed-seed ingestion burst; browser boundary separate", 512),
        ("wall-event-burst", "browser", "real browser update latency and DOM mutations per beat", 512),
        ("diary-scroll-10k", "browser", "real-browser render and scripted scroll", 10_000),
        ("room-concurrency", "i0-writes", "maximum acknowledged latency across eight synchronized writers", 8),
        ("room-concurrency", "acquisition-u119", "U119 frozen acquisition protocol", 8),
        ("swarm-vm-derive", "reserved-u112-u136", "real view-model derivation only", 15),
        ("lifecycle-burst", "reserved-u132", "agent_lifecycle: transitions, replay and throttling", 105),
        ("room-recover-checkpoint", "not-applicable-u102", "U102 prerequisite", 0),
    ]


def frozen_expectation(fixture, benchmark, variant):
    semantic = {k: copy.deepcopy(v) for k, v in fixture.get("expected", {}).items() if k != "ingestion"}
    if benchmark == "fold-mixed-10k":
        return semantic
    if benchmark == "wall-plan-cache":
        if variant != "ingest-read":
            return {"projection": semantic, "ingestion": fixture["expected"]["ingestion"], "read_present": True}
        semantic["memory"]["goal"] = {"text": "Updated synthetic goal", "rev": 0xffff}
        semantic["last_lamport"] = 0xffff
        semantic["counts"]["applied"] += 1
        return {"accepted": True, "projection": semantic}
    if benchmark in ("wall-history-soak", "wall-event-burst"):
        count = 100_000 if benchmark == "wall-history-soak" else 512
        if benchmark == "wall-event-burst":
            semantic["memory"]["goal"] = {"text": "Synthetic burst 480", "rev": 20_480}
            semantic["last_lamport"] = 20_480
            semantic["counts"]["applied"] = 24
        return {"accepted": count, "projection": semantic, "last_id": f"e-{20_000+count-1:016x}",
                "operations": 27 if benchmark == "wall-event-burst" else 11, "recent_non_ops": 5000}
    if benchmark == "room-tail-near-cap":
        events = fixture["events"]
        head = events[-1]["lamport"]
        after = 0 if variant == "filtered" else (head+1 if variant == "future" else head-100)
        return {"untrusted": adapters.reference_page(events, after, 100, ["question"] if variant == "filtered" else None)}
    if benchmark == "room-concurrency":
        return {"acknowledged": 8, "failures": 0, "malformed": 0, "unique_acknowledgements": 8,
                "committed": 8, "exactly_once": True, "ordered": True, "unique_mutations": 8,
                "folded_tasks": 8, "fold_rejections": 0,
                "mutation_payloads": [[f"writer-{i}", f"Synthetic writer {i}", f"writer_{i:08d}"] for i in range(8)]}
    raise ValueError("no real adapter")


def unavailable(benchmark, variant):
    if variant == "browser":
        return "AUSENTE: real browser runner; DOM emulation cannot supply paint or scroll evidence"
    if benchmark == "swarm-vm-derive":
        return "AUSENTE: verified U112/U136 adapter at pinned I0; heartbeat substitution forbidden"
    if benchmark == "lifecycle-burst":
        return "AUSENTE: U132 agent_lifecycle adapter; lifecycle excluded at pinned I0"
    if variant == "acquisition-u119":
        return "AUSENTE: U119 frozen acquisition protocol; distinct from I0 writes"
    if benchmark == "room-recover-checkpoint":
        return "AUSENTE: not applicable until U102"
    return None


def target_assessment(result):
    # Targets never turn a semantically valid baseline into a failure.
    targets = {("wall-plan-cache", "cached-plan"): 2, ("wall-plan-cache", "ingest-read"): 4,
               ("fold-mixed-10k", "python"): 500, ("room-tail-near-cap", "latest"): 10}
    limit = targets.get((result["benchmark"], result["variant"]))
    if limit is not None:
        result["optimization_target"] = {"kind": "TARGET", "p95_ms": limit,
             "candidate_meets": None if result["status"] != "PASS" else result["p95_ms"]["candidate"] <= limit}

    if result["benchmark"] == "room-tail-near-cap" and result["variant"] == "latest":
        values = [p["sides"].get("candidate", {}).get("records_parsed") for p in result["pair_records"]]
        result["optimization_target"].update(records_parsed=512,
            candidate_records_meet=None if not values or any(v is None for v in values) else max(values) <= 512)
    if result["benchmark"] == "room-concurrency" and result["variant"] == "i0-writes":
        from .harness import percentile
        samples = {side: [v for p in result["pair_records"] for v in p["sides"].get(side, {}).get("ack_samples_ms", [])]
                   for side in ("base", "candidate")}
        result["acknowledgements"] = {side: {"samples_ms": values or None,
            "p95_ms": percentile(values, .95), "p99_ms": percentile(values, .99)} for side, values in samples.items()}
        complete = result["status"] == "PASS"
        result["optimization_target"] = {"kind": "TARGET", "ack_p95_ms": 50, "ack_p99_ms": 100,
            "candidate_meets": None if not complete else percentile(samples["candidate"], .95) <= 50 and percentile(samples["candidate"], .99) <= 100}
    if result["benchmark"] == "wall-history-soak":
        result["optimization_target"] = {"kind": "TARGET", "recent_cache_events": 5000, "recent_cache_bytes": 16*1024**2,
            "scope": "public display; internal retention also requires heap observations"}


def artifact_hashes():
    paths = ["bridge/plan/fold.py", "bridge/room/store.py", "bridge/room/app.py", "bridge/room/ext/events.py",
             "src/plan/reducer.ts", "src/app/agent_store.ts", "tests/bench/oracle.json", "tests/bench/adapter.ts",
             "tests/bench/loader.mjs", "bridge/tests/bench/fixtures.py", "bridge/tests/bench/harness.py",
             "bridge/tests/bench/adapters.py", "bridge/tests/bench/run.py"]
    paths += [str(p.relative_to(ROOT)) for directory in (ROOT/"src"/"plan", ROOT/"bridge"/"plan")
              for p in directory.glob("*") if p.suffix in (".py", ".ts")]
    paths += ["tests/bench/report.schema.json"]
    return {p: sha((ROOT/p).read_bytes()) for p in sorted(set(paths))}


def run_all(quiet_receipt=None, selected=None):
    receipt = read_receipt(quiet_receipt)
    fixtures = {"mixed": mixed(), "tail": near_cap()}
    reserved = reservations()
    reports = []
    hashes = artifact_hashes()
    for benchmark, variant, boundary, units in registry():
        if selected and benchmark not in selected:
            continue
        fixture = fixtures["tail" if benchmark == "room-tail-near-cap" else "mixed"]
        if benchmark in ("wall-history-soak", "wall-event-burst") and variant != "browser":
            fixture = client_fixture(fixture, "history" if benchmark == "wall-history-soak" else "burst")
        if benchmark == "room-concurrency" and variant == "i0-writes":
            fixture = concurrency_fixture()
        reason = unavailable(benchmark, variant)
        if reason:
            # Reservation bytes are not a persisted lifecycle journal.
            manifest = {"seed": SEED, "fixture_sha256": sha(encoded(reserved)), "journal_bytes": None,
                        "event_count": 105 if benchmark == "lifecycle-burst" else (10_000 if benchmark == "diary-scroll-10k" else None)}
            result = report(benchmark, variant, manifest, reason)
            if benchmark == "lifecycle-burst":
                result["counts"] = reserved["lifecycle"]["counts"]
        else:
            expected = frozen_expectation(fixture, benchmark, variant)
            if benchmark == "fold-mixed-10k" and variant == "python":
                callback = lambda: adapters.fold(fixture)
            elif benchmark == "room-tail-near-cap":
                callback = lambda: adapters.tail(fixture, variant)
            elif benchmark == "room-concurrency":
                callback = lambda: adapters.concurrency(fixture)
            else:
                adapter_variant = "fold" if benchmark == "fold-mixed-10k" else ("burst" if variant == "ingestion" else variant)
                callback = lambda: adapters.typescript(fixture, adapter_variant)
            with timing_lock() as locked:
                result = paired(benchmark, variant, fixture["manifest"], expected, units, callback, callback,
                                quiet=receipt is not None, locked=locked, receipt=receipt, authoritative=receipt is not None)
            if benchmark == "room-tail-near-cap":
                # Correctness check outside measurement; a swallowed error is a BLOCK.
                check = adapters.cap_check(fixture)
                result["cap_correctness"] = check
                if not check["ok"]:
                    result.update(status="BLOCK", reason="CAP atomicity correctness failed", correctness=check)
        result["fixture_manifest"] = fixture["manifest"] if not reason else None
        result["boundary"] = boundary
        result["artifact_sha256"] = hashes
        result["quiet_window_receipt_sha256"] = receipt["sha256"] if receipt else None
        result["command"] = ["python3", "-B", "-m", "bridge.tests.bench.run", "--benchmark", benchmark]
        result["exit_code"] = 2 if result["status"] == "BLOCK" else (3 if result["status"] == "INCONCLUSIVE" else 0)
        target_assessment(result)
        reports.append(result)
    return reports


def output_path(value):
    path = (ROOT/value).resolve()
    allowed = [ROOT/"tests"/"bench", ROOT/"bridge"/"tests"/"bench"]
    if not any(path.is_relative_to(p.resolve()) for p in allowed):
        raise ValueError("report output must stay in benchmark directories")
    return path


def write_reports(reports, output):
    path = output_path(output)
    path.parent.mkdir(exist_ok=True, parents=True)
    for value in reports:
        validate_report(value)
    data = encoded(reports)+b"\n"
    path.write_bytes(data)
    digest = sha(data)
    lines = ["# Benchmark report", "", f"JSON: [{path.name}]({path.name})", "", f"SHA-256: `{digest}`", "",
             "Timings do not confer optimization admission. Missing metrics remain null.", "",
             "| Benchmark | Variant | Status | Reason |", "|---|---|---|---|"]
    lines.extend(f"| {r['benchmark']} | {r['variant']} | {r['status']} | {r['reason']} |" for r in reports)
    path.with_suffix(".md").write_text("\n".join(lines)+"\n", encoding="utf-8")
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet-window-receipt")
    parser.add_argument("--benchmark", action="append", choices=sorted({r[0] for r in registry()}))
    parser.add_argument("--output", default="tests/bench/artifacts/registry.json")
    args = parser.parse_args()
    reports = run_all(args.quiet_window_receipt, args.benchmark)
    command = ["python3", "-B", "-m", "bridge.tests.bench.run", "--output", str(output_path(args.output).relative_to(ROOT))]
    if args.quiet_window_receipt:
        command.extend(["--quiet-window-receipt", "<provided; content hash recorded>"])
    for benchmark in args.benchmark or []:
        command.extend(["--benchmark", benchmark])
    overall_exit = 2 if any(r["status"] == "BLOCK" for r in reports) else (3 if any(r["status"] == "INCONCLUSIVE" for r in reports) else 0)
    for result in reports:
        result["invocation"] = command
        result["invocation_exit_code"] = overall_exit
    digest = write_reports(reports, args.output)
    counts = {status: sum(r["status"] == status for r in reports) for status in ("PASS", "BLOCK", "INCONCLUSIVE")}
    print(f"bench registry: PASS={counts['PASS']} BLOCK={counts['BLOCK']} INCONCLUSIVE={counts['INCONCLUSIVE']}; sha256={digest}")
    return 2 if counts["BLOCK"] else (3 if counts["INCONCLUSIVE"] else 0)


if __name__ == "__main__":
    sys.exit(main())
