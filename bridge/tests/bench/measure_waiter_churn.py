"""Pair independent waiter processes on identical journal workloads."""
import argparse
from contextlib import ExitStack
from fractions import Fraction  # A-R52RW
import hashlib
from itertools import accumulate
import json
import multiprocessing
import os
from pathlib import Path
import resource
import signal
from statistics import median
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch


CAP_SHA256 = "af82737d7e67970859f1148a3b65960344050ea12b4f7e62ab93d9ae48730aa0"
PAIR_COUNT = 5
SYNC_LIMIT = 30
ROOT = Path(__file__).resolve().parents[3]


class TrialError(ValueError):
    """A failed measurement precondition or an incorrect waiter reply."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def append(path, data):
    with path.open("ab") as stream:
        stream.write(data)


def clock_for(schedule, ready, published):
    clock = SimpleNamespace(now=0.0, step=0, sleeps=0, path_start_ns=None)

    def sleep(seconds):
        clock.sleeps += 1
        if clock.sleeps > 1000 or not 0 < seconds <= 1:
            raise TrialError("invalid or unbounded polling")
        target = clock.now + seconds
        if clock.step < len(schedule) and schedule[clock.step] <= target:
            clock.now = schedule[clock.step]
            ready.wait(SYNC_LIMIT)
            published.wait(SYNC_LIMIT)
            clock.step += 1
            clock.path_start_ns = time.process_time_ns()
        else:
            clock.now = target

    clock.monotonic = lambda: clock.now
    clock.monotonic_ns = lambda: round(clock.now * 1_000_000_000)
    clock.sleep = sleep
    return clock


# A-R52RW: count full folds, rows and checked journal bytes at each publication.
def meter_waiter(patches, waiter, store, clock, journal_sizes):
    folds = [0] * len(journal_sizes)
    meter = {"folds_by_publication": folds, "fold_rows": 0, "checked_bytes": 0}
    from bridge.plan.fold import fold_plan

    def counted_fold(events, *args, **kwargs):
        folds[clock.step] += 1
        meter["fold_rows"] += len(events)
        return fold_plan(events, *args, **kwargs)

    patches.enter_context(patch.object(sys.modules[fold_plan.__module__], "fold_plan", counted_fold))
    for name, value in vars(waiter).copy().items():
        if value is fold_plan:
            patches.enter_context(patch.object(waiter, name, counted_fold))

    def count_checked(owner, name):
        original = getattr(owner, name)

        def checked(*args, **kwargs):
            result = original(*args, **kwargs)
            if result is not None:
                # A successful suffix check also reads the entire prior prefix.
                meter["checked_bytes"] += journal_sizes[clock.step]
            return result

        patches.enter_context(patch.object(owner, name, checked))

    count_checked(store, "read_checked")
    if hasattr(waiter, "_read_journal_suffix"):
        count_checked(waiter, "_read_journal_suffix")
    return meter


def waiter_process(tree, home, spec, ready, published, last_publication, pipe):
    try:
        sys.path.insert(0, tree)
        os.environ["CW_HOME"] = home
        for name in ("CW_AGENT", "CW_ROLE", "CW_SESSION_AGENT", "CW_SESSION_ROLE"):
            os.environ.pop(name, None)
        from bridge.room import app, store
        from bridge.room.ext import waiter

        templates = json.dumps(store._load_templates(), sort_keys=True).encode()
        variants = {"python": sys.version, "cap_bytes": store.CAP,
                    "template_sha256": digest(templates),
                    "store_sha256": digest(Path(store.__file__).read_bytes())}
        journal_sizes = spec["journal_sizes"]
        if journal_sizes[-1] > store.CAP:
            raise TrialError("workload exceeds the active journal cap")
        clock = clock_for(spec["schedule"], ready, published)
        # Files and synchronization are real. Publishing a scheduled write
        # advances a virtual clock without introducing time-based races.
        with ExitStack() as patches:
            for name in ("monotonic", "monotonic_ns", "sleep"):
                original = getattr(time, name)
                replacement = getattr(clock, name)
                for alias, value in vars(waiter).copy().items():
                    if value is original:
                        patches.enter_context(patch.object(waiter, alias, replacement))
                patches.enter_context(patch.object(time, name, replacement))
            meter = meter_waiter(patches, waiter, store, clock, journal_sizes)
            cpu_start = time.process_time_ns()
            wall_start = time.perf_counter_ns()
            reply = app.dispatch("wait_agents", spec["args"])
            wall_end = time.perf_counter_ns()
            cpu_end = time.process_time_ns()
        if clock.step != len(spec["schedule"]) or reply.get("untrusted") != spec["reply"]:
            raise TrialError("waiter did not return the expected complete reply")
        if not meter["folds_by_publication"][0] or not meter["checked_bytes"]:
            raise TrialError("initial fold or checked byte count is absent")
        pipe.send({
            "cpu_start_ns": cpu_start, "cpu_end_ns": cpu_end,
            "monotonic_start_ns": wall_start, "monotonic_end_ns": wall_end,
            "last_publication_cpu_start_ns": clock.path_start_ns,
            "last_publication_monotonic_ns": last_publication.value if spec["chunks"] else None,
            "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "waiter_sha256": digest(Path(waiter.__file__).read_bytes()), "inputs": variants,
            **meter,
        })
    except Exception as exc:
        # Report only the failure class for arbitrary checkout exceptions.
        pipe.send({"error": str(exc) if isinstance(exc, TrialError) else type(exc).__name__})
    finally:
        pipe.close()


def trial(tree, home, spec):
    journal_path = Path(home) / "rooms" / spec["args"]["room"] / "events.jsonl"
    context = multiprocessing.get_context("fork")
    ready = context.Barrier(spec["waiters"] + 1)
    published = context.Barrier(spec["waiters"] + 1)
    # A-R52RW: check actual sizes and timestamp the last write before waiters resume.
    last_publication = context.Value("Q", 0, lock=False)
    initial_size = journal_path.stat().st_size
    if initial_size != spec["journal_sizes"][0]:
        raise TrialError("journal size mismatch before publication")
    children = []
    try:
        for _ in range(spec["waiters"]):
            receiver, sender = context.Pipe(duplex=False)
            process = context.Process(
                target=waiter_process,
                args=(tree, home, spec, ready, published, last_publication, sender))
            process.start()
            sender.close()
            children.append((process, receiver))
        final_size = initial_size
        for index, chunk in enumerate(spec["chunks"], 1):
            ready.wait(SYNC_LIMIT)
            append(journal_path, chunk.encode())
            if index == len(spec["chunks"]):
                last_publication.value = time.perf_counter_ns()
                final_size = journal_path.stat().st_size
                if final_size != spec["journal_sizes"][-1]:
                    raise TrialError("journal size mismatch after final publication")
            published.wait(SYNC_LIMIT)
        intervals = []
        for process, receiver in children:
            if not receiver.poll(SYNC_LIMIT):
                raise TrialError("waiter failed to finish within the process bound")
            try:
                sample = receiver.recv()
            except EOFError:
                raise TrialError("waiter sample is missing") from None
            if "error" in sample:
                raise TrialError(sample["error"])
            process.join(SYNC_LIMIT)
            if process.exitcode != 0:
                raise TrialError("waiter did not exit cleanly")
            intervals.append(sample)
        if journal_path.stat().st_size != final_size:
            raise TrialError("journal size changed before the trial finished")
        return {"intervals": intervals, "initial_journal_bytes": initial_size,
                "final_journal_bytes": final_size}
    finally:
        for process, receiver in children:
            receiver.close()
            if process.is_alive():
                process.kill()
            process.join()


def workloads(cap_bytes):
    from bridge.room.store import RoomError, _check_room
    from bridge.tests.bench.fixtures import event, journal

    hot_room = "waiter-churn"
    head = 10_000
    hot = journal(event(lamport, room=hot_room) for lamport in range(1, head + 1))
    beats = [journal([event(head + i, room=hot_room)]).decode() for i in range(1, 9)]
    terminal = event(head + 2, room=hot_room, agent="worker", act="op",
                     op={"kind": "agent.lifecycle", "state": "finished",
                         "run_id": "bench-run", "op_id": "bench-finish"})
    deployment = event(head + 1, room=hot_room, agent="worker", act="op",
                       op={"kind": "agent.lifecycle", "state": "deployed",
                           "run_id": "bench-run", "op_id": "bench-deploy"})
    cap_rows = [json.loads(line) for line in cap_bytes.split(b"\n")[:-1] if line.strip()]
    rooms = {row["room"] for row in cap_rows}
    if len(rooms) != 1:
        raise TrialError("pinned cap fixture must contain one room")
    cap_room = rooms.pop()
    try:
        _check_room(cap_room)
    except RoomError:
        raise TrialError("pinned cap fixture has an invalid room slug") from None
    cap_head = max(row["lamport"] for row in cap_rows)

    return {
        "concurrent_heartbeat": (hot, beats, [0.11 + i * 0.1 for i in range(len(beats))],
                                 4, {"room": hot_room, "since_lamport": head},
                                 {"events": [], "cursor": head + len(beats), "timed_out": True}),
        "cold_full": (cap_bytes, [], [], 1,
                      {"room": cap_room, "since_lamport": cap_head},
                      {"events": [], "cursor": cap_head, "timed_out": True}),
        "invalidated": (hot + journal([terminal]), [journal([deployment]).decode()], [0.25],
                        1, {"room": hot_room, "since_lamport": head + 1},
                        {"events": [{"agent": "worker", "state": "finished",
                                     "run_id": "bench-run", "parent": None,
                                     "lamport": head + 2}], "cursor": head + 2}),
    }


# A-R52RW: resize only the generator's synthetic text padding for this store cap.
def near_cap_workloads(cap):
    from bridge.tests.bench import waiter_fixture as fixture
    from bridge.tests.bench.fixtures import journal

    prefix = fixture.build_journal()
    if len(prefix) != fixture.JOURNAL_BYTES or digest(prefix) != fixture.FIXTURE_SHA256:
        raise TrialError("near-cap prefix generator does not match its pin")
    schedule, suffix = zip(*fixture.scheduled_writes())
    chunks = [journal([row]).decode() for row in suffix]
    initial_size = cap - sum(len(chunk.encode()) for chunk in chunks)
    rows = [json.loads(line) for line in prefix.splitlines()]
    messages = [row for row in rows if row["act"] in ("heartbeat", "question")]
    padding, remainder = divmod(initial_size - len(prefix), len(messages))
    for index, row in enumerate(messages):
        text = row["text"]
        amount = padding + (index < remainder)
        if amount < 0:
            if -amount > len(text) - len(text.rstrip("x")):
                raise TrialError("store cap is too small for the near-cap fixture")
            row["text"] = text[:amount]
        else:
            row["text"] += "x" * amount
    initial = journal(rows)
    if len(initial) != initial_size:
        raise TrialError("near-cap prefix did not reserve the exact suffix length")

    args = {"room": fixture.ROOM, "since_lamport": fixture.HEAD,
            "timeout_s": schedule[-1] + 1, "agents": ["worker"],
            "parent": "coordinator", "states": ["finished"]}
    head = suffix[-1]["lamport"]
    reply = {"events": [{"agent": "worker", "run_id": "scheduled-run", "state": "finished",
                         "parent": {"agent": "coordinator", "run_id": None},
                         "lamport": head}], "cursor": head}
    idle_reply = {"events": [], "cursor": fixture.HEAD, "timed_out": True}
    return {
        "near_cap_heartbeat_1": (initial, chunks, schedule, 1, args, reply),
        "near_cap_heartbeat_4": (initial, chunks, schedule, 4, args, reply),
        "near_cap_no_write_1": (initial, [], [], 1, args, idle_reply),
        "near_cap_no_write_4": (initial, [], [], 4, args, idle_reply),
    }


def measure(tree, scratch, workload):
    from bridge.tests.bench.harness import telemetry

    initial, chunks, schedule, waiters, args, reply = workload
    # A-R52RW: preserve per-waiter intervals and aggregate only complete samples.
    journal_sizes = list(accumulate((len(chunk.encode()) for chunk in chunks),
                                    initial=len(initial)))
    spec = {"chunks": chunks, "schedule": schedule, "waiters": waiters,
            "args": {"timeout_s": 1, **args}, "reply": reply, "journal_sizes": journal_sizes}
    with tempfile.TemporaryDirectory(dir=scratch, prefix="waiter-churn-") as home:
        journal_path = Path(home) / "rooms" / args["room"] / "events.jsonl"
        journal_path.parent.mkdir(parents=True)
        journal_path.write_bytes(initial)
        scratch_device = journal_path.stat().st_dev
        before = telemetry()
        command = [sys.executable, "-B", str(Path(__file__).resolve()), "--trial", str(tree), home]
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True, start_new_session=True) as process:
            try:
                output, _ = process.communicate(json.dumps(spec), timeout=2 * SYNC_LIMIT + 10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise TrialError("fresh trial exceeded the process bound") from None
        after = telemetry()
    try:
        trial_result = json.loads(output) if output else {}
    except ValueError:
        raise TrialError("fresh trial sample is unreadable") from None
    samples = trial_result.get("intervals") if isinstance(trial_result, dict) else None
    if process.returncode or not isinstance(samples, list) or len(samples) != waiters:
        failure = trial_result.get("error") if isinstance(trial_result, dict) else None
        raise TrialError(failure or "fresh trial samples are missing")
    if any(value is None for reading in (before, after) for value in reading.values()):
        raise TrialError("load or available-memory telemetry is absent")
    fields = ("cpu_start_ns", "cpu_end_ns", "monotonic_start_ns", "monotonic_end_ns",
              "peak_rss_bytes", "fold_rows", "checked_bytes")
    if chunks:
        fields += ("last_publication_cpu_start_ns", "last_publication_monotonic_ns")
    if any(not isinstance(sample, dict) or not isinstance(sample.get("inputs"), dict)
           or any(type(sample.get(field)) is not int for field in fields)
           or not isinstance(sample.get("folds_by_publication"), list)
           or len(sample["folds_by_publication"]) != len(journal_sizes)
           or any(type(count) is not int or count < 0 for count in sample["folds_by_publication"])
           for sample in samples):
        raise TrialError("incomplete waiter measurement sample")
    if [trial_result.get("initial_journal_bytes"), trial_result.get("final_journal_bytes")] != [
            journal_sizes[0], journal_sizes[-1]]:
        raise TrialError("verified journal sizes are missing or inconsistent")
    inputs = samples[0]["inputs"]
    if any(sample["inputs"] != inputs for sample in samples):
        raise TrialError("waiters used different runtime, store, templates or cap")
    complete = hashlib.sha256(initial)
    for chunk in chunks:
        complete.update(chunk.encode())
    heartbeat_count = len(chunks) - bool(chunks and not reply.get("timed_out"))
    return {
        "inputs": {**inputs, "scratch_device": scratch_device,
                   "initial_sha256": digest(initial), "final_sha256": complete.hexdigest(),
                   "initial_journal_bytes": trial_result["initial_journal_bytes"],
                   "largest_journal_bytes": trial_result["final_journal_bytes"],
                   "schedule": schedule, "waiters": waiters},
        "before": before, "after": after, "intervals": samples,
        "expected_reply": reply,
        "heartbeat_repeat_folds": sum(sum(item["folds_by_publication"][1:heartbeat_count + 1])
                                      for item in samples),
        "aggregate_cpu_ns": sum(item["cpu_end_ns"] - item["cpu_start_ns"] for item in samples),
        "last_publication_cpu_ns": sum(
            item["cpu_end_ns"] - item["last_publication_cpu_start_ns"]
            for item in samples
        ) if chunks else None,
        "slowest_terminal_latency_ns": max(
            item["monotonic_end_ns"] - item["last_publication_monotonic_ns"] for item in samples
        ) if chunks and not reply.get("timed_out") else None,
        "peak_rss_bytes": max(item["peak_rss_bytes"] for item in samples),
    }


def paired(name, baseline, candidate, scratch, workload):
    # A-R52RW: use exact paired ratios for inclusive one-sided limits.
    inputs = None
    trees = {"baseline": baseline, "candidate": candidate}
    cpu_metric = "last_publication_cpu_ns" if name == "invalidated" else "aggregate_cpu_ns"
    concurrent = name in ("concurrent_heartbeat", "near_cap_heartbeat_4")
    heartbeat = concurrent or name == "near_cap_heartbeat_1"
    regression_limit = -Fraction(1, 10)
    metrics = {
        "cpu": (cpu_metric, Fraction(1, 5) if concurrent else regression_limit),
        "peak_rss": ("peak_rss_bytes", regression_limit),
    }
    if name == "near_cap_heartbeat_4":
        metrics["slowest_terminal_latency"] = ("slowest_terminal_latency_ns", regression_limit)
    report = {"pairs": [], "cpu_metric": cpu_metric, "passed": False}
    report.update({f"median_paired_{label}_improvement": None for label in metrics})
    try:
        for index in range(PAIR_COUNT):
            order = ("baseline", "candidate") if index % 2 == 0 else ("candidate", "baseline")
            pair = {"order": order}
            report["pairs"].append(pair)
            for side in order:
                try:
                    observation = measure(trees[side], scratch, workload)
                except TrialError as exc:
                    raise TrialError(f"{side}: {exc}") from None
                if not isinstance(observation, dict) or not isinstance(observation.get("inputs"), dict):
                    raise TrialError(f"{side}: missing trial sample")
                pair[side] = observation
                if inputs is None:
                    inputs = observation["inputs"]
                if observation["inputs"] != inputs:
                    raise TrialError("paired inputs differ in fixture, runtime, store, cap, templates or scratch medium")
                for metric, _ in metrics.values():
                    value = observation.get(metric)
                    if type(value) is not int or value <= 0:
                        raise TrialError(f"{side}: {metric} must be a positive sample")
                if heartbeat and side == "candidate":
                    repeats = observation.get("heartbeat_repeat_folds")
                    if type(repeats) is not int or repeats < 0:
                        raise TrialError("candidate: missing heartbeat repeat fold count")
    except TrialError as exc:
        report["hold_reason"] = str(exc)
        return report

    report["passed"] = True
    for label, (metric, limit) in metrics.items():
        improvement = median(
            1 - Fraction(pair["candidate"][metric], pair["baseline"][metric])
            for pair in report["pairs"])
        report[f"median_paired_{label}_improvement"] = float(improvement)
        report["passed"] &= improvement >= limit
    if heartbeat:
        repeats = sum(pair["candidate"]["heartbeat_repeat_folds"] for pair in report["pairs"])
        report["candidate_heartbeat_repeat_folds"] = repeats
        report["passed"] &= repeats == 0
    return report


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--trial":
        try:
            print(json.dumps(trial(sys.argv[2], sys.argv[3], json.load(sys.stdin))))
        except Exception as exc:
            print(json.dumps({"error": str(exc) if isinstance(exc, TrialError) else type(exc).__name__}))
            return 1
        return 0

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--cap-fixture", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, default=Path(__file__).resolve().parent)
    # A-R52WF: admit and label a replacement only under an explicit digest.
    parser.add_argument("--fixture-sha256", default=CAP_SHA256, metavar="HEX",
                        help="expected SHA-256 for the supplied cap fixture")
    args = parser.parse_args()
    fixture_sha256 = args.fixture_sha256.lower()
    sys.path.insert(0, str(ROOT))
    try:
        if sys.platform != "linux":
            raise TrialError("this runner requires Linux process and RSS accounting")
        for tree in (args.baseline, args.candidate):
            if not (tree / "bridge" / "room" / "ext" / "waiter.py").is_file():
                raise TrialError("both checkout roots must contain the registered waiter")
        if not args.cap_fixture.is_file():
            raise TrialError("AUSENTE — pinned cap fixture bytes")
        data = args.cap_fixture.read_bytes()
        if len(fixture_sha256) != 64 or any(c not in "0123456789abcdef" for c in fixture_sha256):
            raise TrialError("--fixture-sha256 must be a 64-digit hexadecimal SHA-256")
        if digest(data) != fixture_sha256:
            raise TrialError("pinned cap fixture SHA-256 mismatch")
        # A-R52RW: derive the near-cap workload from the compared store.
        baseline, candidate = args.baseline.resolve(), args.candidate.resolve()
        active_cap = int(subprocess.check_output(
            [sys.executable, "-B", "-c", "from bridge.room.store import CAP; print(CAP)"],
            cwd=baseline, timeout=SYNC_LIMIT))
        matrix = workloads(data)
        matrix.update(near_cap_workloads(active_cap))
        reports = {
            name: paired(name, baseline, candidate, args.scratch.resolve(), workload)
            for name, workload in matrix.items()
        }
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        message = str(exc) if isinstance(exc, TrialError) else type(exc).__name__
        parser.exit(1, f"Measurement stopped: {message}\n")
    if fixture_sha256 != CAP_SHA256:
        for report in reports.values():
            report.update(replacement_fixture=True, cap_fixture_sha256=fixture_sha256)
            for pair in report["pairs"]:
                pair.update(replacement_fixture=True, cap_fixture_sha256=fixture_sha256)
    print(json.dumps({"cap_fixture_sha256": fixture_sha256, "workloads": reports,
                      "runner_sha256": digest(Path(__file__).read_bytes())}, indent=2))
    return 0 if all(report["passed"] for report in reports.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
