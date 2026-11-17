"""Fail-closed paired measurement and public, independently recomputable reports."""
from contextlib import contextmanager
import fcntl
import math
import os
from pathlib import Path
import platform
import time

from .fixtures import ROOT, encoded, sha

WARMUPS = 5
OBSERVATIONS = 30
MEMORY_FLOOR = 20 * 1024**3
LOAD_CEILING = 18
STOP_LOAD = 24
BASELINE = "4528625acafa5e435c4b34b6d1fd6adfacee6dd3"


def percentile(values, p):
    if not values:
        return None
    if not 0 < p <= 1 or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("invalid percentile observations")
    return sorted(values)[math.ceil(p*len(values))-1]


def telemetry():
    try:
        load = os.getloadavg()[1]
    except (OSError, AttributeError):
        load = None
    memory = None
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                memory = int(line.split()[1])*1024
                break
    except (OSError, ValueError, IndexError):
        pass
    return {"load5": load, "mem_available_bytes": memory}


def admission(reading, quiet, locked):
    if not quiet:
        return "AUSENTE: valid orchestrator quiet-window receipt"
    if not locked:
        return "AUSENTE: exclusive timing lock"
    load, memory = reading.get("load5"), reading.get("mem_available_bytes")
    if isinstance(load, bool) or not isinstance(load, (int, float)) or not math.isfinite(load) or load < 0:
        return "AUSENTE: load5 telemetry"
    if isinstance(memory, bool) or not isinstance(memory, int) or memory < 0:
        return "AUSENTE: MemAvailable telemetry"
    if memory < MEMORY_FLOOR:
        return "MemAvailable below 20 GiB stop boundary"
    if load > STOP_LOAD:
        return "load5 above 24 stop boundary"
    if load >= LOAD_CEILING:
        return "load5 at or above 18; timing is INCONCLUSIVE"
    return None


def read_receipt(path):
    import json
    if path is None:
        return None
    try:
        raw = Path(path).read_bytes()
        receipt = json.loads(raw)
        expires = receipt.get("expires_at")
        if (receipt.get("schema") != "tasklight-bench/quiet-window-v1" or
                receipt.get("granted") is not True or receipt.get("exclusive") is not True or
                receipt.get("verification_running") is not False or
                isinstance(expires, bool) or not isinstance(expires, (int, float)) or
                not math.isfinite(expires) or expires <= time.time()):
            return None
        return {"sha256": sha(raw), "expires_at": expires}
    except (OSError, ValueError, AttributeError):
        return None


@contextmanager
def timing_lock():
    path = ROOT / "tests" / "bench" / ".scratch" / "timing.lock"
    path.parent.mkdir(exist_ok=True)
    with path.open("a+b") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def report(benchmark, variant, manifest=None, reason=None):
    manifest = manifest or {}
    sides = {"base": None, "candidate": None}
    return {"schema": "tasklight-bench/v1", "benchmark": benchmark, "variant": variant,
            "status": "INCONCLUSIVE", "reason": reason,
            "base": "working-copy-self", "candidate": "working-copy-self",
            "reference_revision": BASELINE, "revision_provenance": "reference only; executed sources identified by hashes",
            "comparison": "repeatability; no speedup claim", "seed": manifest.get("seed"),
            "fixture_sha256": manifest.get("fixture_sha256"), "journal_bytes": manifest.get("journal_bytes"),
            "event_count": manifest.get("event_count"), "samples_ms": sides.copy(),
            "p50_ms": sides.copy(), "p95_ms": sides.copy(), "p99_ms": sides.copy(),
            "peak_rss_bytes": sides.copy(), "load5": [],
            "correctness": {"ok": None, "expected": None, "actual": None},
            "counts": None, "bytes_per_committed_event": None,
            "warmups": WARMUPS, "observations_per_side": OBSERVATIONS,
            "clock": {"python": "time.perf_counter_ns", "typescript": "process.hrtime.bigint"},
            "runtimes": {"python": platform.python_version()}, "browser": {"version": None, "viewport": None,
                "reason": "AUSENTE: real browser runner"},
            "process_scope": {}, "pair_records": [], "authoritative": False,
            "completed_warmups": {"base": 0, "candidate": 0},
            "completed_observations": {"base": 0, "candidate": 0},
            "units": {"samples_ms": "milliseconds", "peak_rss_bytes": "bytes", "load5": "five-minute load average"}}


def validate_reply(value, expected, fixture_hash, minimum_work):
    """Expected data belongs to the registry, never to an untrusted adapter."""
    actual = value.get("actual")
    same = encoded(actual) == encoded(expected)
    work = value.get("work_units")
    worked = isinstance(work, int) and not isinstance(work, bool) and work >= minimum_work > 0
    match = value.get("fixture_sha256") == fixture_hash
    return {"ok": same and worked and match, "expected": expected, "actual": actual,
            "checks": {"frozen_expectation": same, "measured_work": worked, "fixture_identity": match}}


def paired(benchmark, variant, manifest, expected, minimum_work, base, candidate, *,
           quiet=False, locked=False, reader=telemetry, receipt=None, authoritative=False):
    result = report(benchmark, variant, manifest)
    result["samples_ms"] = {"base": [], "candidate": []}
    result["authoritative"] = authoritative
    rss = {"base": [], "candidate": []}
    telemetry_missing = False
    callbacks = {"base": base, "candidate": candidate}
    last_reading = None
    def guard(stage):
        nonlocal last_reading
        try:
            last_reading = reader()
        except Exception:
            last_reading = {"load5": None, "mem_available_bytes": None}
        if not isinstance(last_reading, dict):
            last_reading = {"load5": None, "mem_available_bytes": None}
        result["load5"].append({"stage": stage, **last_reading})
        valid_receipt = quiet and (receipt is None or receipt["expires_at"] > time.time())
        reason = admission(last_reading, valid_receipt, locked)
        if reason and result["status"] != "BLOCK":
            result["reason"] = reason
        return reason
    def execute(side, measured):
        nonlocal telemetry_missing
        try:
            value = callbacks[side]()
            correctness = validate_reply(value, expected, manifest["fixture_sha256"], minimum_work)
        except Exception as exc:
            result["reason"] = f"infrastructure failure: {type(exc).__name__}"
            receipt = getattr(exc, "execution", None)
            if receipt is not None:
                result.setdefault("execution_failures", []).append({"side": side, "measured": measured, **receipt})
            return None
        result["correctness"] = correctness
        if not correctness["ok"]:
            result.update(status="BLOCK", reason="frozen correctness, work or fixture identity failed")
            return None
        if measured:
            elapsed = value.get("elapsed_ms")
            if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0:
                result["reason"] = "AUSENTE: monotonic elapsed milliseconds"
                return None
            result["samples_ms"][side].append(elapsed)
            peak = value.get("peak_rss_bytes")
            if isinstance(peak, bool) or not isinstance(peak, int) or peak <= 0:
                telemetry_missing = True
            else:
                rss[side].append(peak)
            result["process_scope"][side] = value.get("process_scope")
            if value.get("runtime"):
                result["runtimes"]["node"] = value["runtime"]
        else:
            result["completed_warmups"][side] += 1
        return value
    def finalize():
        if result["status"] != "PASS":
            result["authoritative"] = False
        for side in ("base", "candidate"):
            values = result["samples_ms"][side]
            result["completed_observations"][side] = len(values)
            for name, p in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99)):
                result[name][side] = percentile(values, p)
            result["peak_rss_bytes"][side] = max(rss[side]) if rss[side] else None
            if not values:
                result["samples_ms"][side] = None
        return result
    # No callback, including a warmup, starts before admission.
    if guard("admission"):
        return finalize()
    for warmup in range(WARMUPS):
        for side in (("base", "candidate") if warmup % 2 == 0 else ("candidate", "base")):
            if guard(f"warmup-{warmup}-{side}-before") or execute(side, False) is None:
                return finalize()
            if guard(f"warmup-{warmup}-{side}-after"):
                return finalize()
    for index in range(OBSERVATIONS):
        order = ["base", "candidate"] if index % 2 == 0 else ["candidate", "base"]
        pair = {"index": index, "order": order, "load_before": None, "load_after": None, "sides": {}}
        result["pair_records"].append(pair)
        if guard(f"pair-{index}-before"):
            pair["load_before"] = last_reading
            return finalize()
        pair["load_before"] = last_reading
        for side in order:
            value = execute(side, True)
            if value is not None:
                pair["sides"][side] = {k: v for k, v in value.items() if k not in ("actual", "expected")}
            violation = guard(f"pair-{index}-{side}-after")
            pair["load_after"] = last_reading
            if value is None or violation:
                return finalize()
        # Explicitly retain before/after evidence for every complete or partial pair.
        if guard(f"pair-{index}-after"):
            pair["load_after"] = last_reading
            return finalize()
        pair["load_after"] = last_reading
    if telemetry_missing:
        result["reason"] = "AUSENTE: peak RSS telemetry"
        return finalize()
    result.update(status="PASS", reason="self-paired repeatability baseline; no speedup claim")
    return finalize()


def validate_report(value):
    """Reject malformed or falsely complete artifacts before writing them."""
    import json
    contract = json.loads((ROOT/"tests"/"bench"/"report.schema.json").read_text())
    if any(k not in value for k in contract["required"]):
        raise ValueError("missing required report field")
    if value["status"] not in ("PASS", "BLOCK", "INCONCLUSIVE"):
        raise ValueError("invalid report status")
    if not isinstance(value["reason"], str) or not value["reason"]:
        raise ValueError("missing report reason")
    for side in ("base", "candidate"):
        samples = value["samples_ms"][side]
        if samples is not None and (not isinstance(samples, list) or not samples):
            raise ValueError("unavailable samples must be null")
        for name, p in (("p50_ms", .5), ("p95_ms", .95), ("p99_ms", .99)):
            if value[name][side] != percentile(samples, p):
                raise ValueError("percentiles disagree with raw observations")
        peak = value["peak_rss_bytes"][side]
        if peak is not None and (isinstance(peak, bool) or not isinstance(peak, int) or peak <= 0):
            raise ValueError("invalid peak RSS")
        if value["status"] == "PASS":
            if (samples is None or len(samples) != OBSERVATIONS or peak is None or
                    value.get("completed_warmups", {}).get(side) != WARMUPS):
                raise ValueError("PASS without complete measurements")
    if value["status"] == "PASS":
        correct = value["correctness"]
        if correct["ok"] is not True or encoded(correct["actual"]) != encoded(correct["expected"]):
            raise ValueError("PASS without frozen correctness")
        if not value["load5"] or any(admission(r, True, True) for r in value["load5"]):
            raise ValueError("PASS without quiet measured telemetry")
    return value
