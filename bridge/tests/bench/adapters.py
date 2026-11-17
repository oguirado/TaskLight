"""Real existing-function adapters. Setup and verification surround hot intervals."""
import copy
import json
import multiprocessing
import os
from pathlib import Path
import resource
import subprocess
import time

from bridge.plan.fold import fold_plan
from bridge.room import app, store
from .fixtures import ROOT, BASE_TS, ROOM, encoded, journal, sha, isolated, oracle, concurrency_fixture


def rss_bytes():
    # Linux reports KiB. Scope: this process' lifetime high-water mark.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def snapshot(projection, counts):
    tasks = projection.get("tasks", [])
    rollup = projection.get("rollup", {}) or {}
    return {"title": (projection.get("plan") or {}).get("title"),
            "task_ids": [t["id"] for t in tasks], "states": [t["state"] for t in tasks],
            "owners": [t["assignee"] for t in tasks],
            "claim_lamports": [t["claim_lamport"] for t in tasks],
            "micro_states": [[m["state"] for m in t["microtasks"]] for t in tasks],
            "progress_pct": rollup.get("progress_pct"), "tasks_total": rollup.get("tasks_total"),
            "micro_total": rollup.get("micro_total"), "micro_done": rollup.get("micro_done"),
            "memory": {key: {"text": v["text"], "rev": v["rev"]} for key, v in projection.get("memory", {}).items()},
            "rejections": [{k: r.get(k) for k in ("id", "lamport", "code")} for r in projection.get("rejected", [])],
            "last_lamport": projection.get("last_lamport"), "counts": counts}


def _fold(fixture):
    events = copy.deepcopy(fixture["events"])
    template = copy.deepcopy(fixture["template"])
    start = time.perf_counter_ns()
    projection = fold_plan(events, templates={template["id"]: template})
    elapsed = (time.perf_counter_ns()-start)/1_000_000
    unique_ops = {e["id"] for e in events if e["act"] == "op"}
    rejected = len(projection["rejected"])
    actual = snapshot(projection, {"applied": len(unique_ops)-rejected, "rejected": rejected,
                                  "invalid": 0, "replayed": 0})
    expected = {k: v for k, v in fixture["expected"].items() if k != "ingestion"}
    return {"elapsed_ms": elapsed, "expected": expected, "actual": actual,
            "work_units": len(events), "fixture_sha256": sha(journal(events)),
            "peak_rss_bytes": rss_bytes(), "process_scope": "python-process-lifetime-high-water"}


def fold(fixture):
    with isolated(fixture):
        return _fold(fixture)


def reference_page(events, after, limit=100, acts=None):
    """Generator-owned full-read oracle; does not call the cursor implementation."""
    ordered = sorted(events, key=lambda e: e["lamport"])
    head = ordered[-1]["lamport"] if ordered else 0
    if after > head:
        return {"events": [], "next_after": head, "head": head, "has_more": False, "resync": True}
    matching = [e for e in ordered if e["lamport"] > after and (acts is None or e["act"] in acts)]
    page = matching[:limit]
    more = len(matching) > limit
    keys = ("id", "room", "agent", "act", "text", "ts", "lamport", "op")
    return {"events": [{k: e[k] for k in keys if k in e} for e in page],
            "next_after": page[-1]["lamport"] if more else head, "head": head,
            "has_more": more, "resync": False}


def tail(fixture, variant="latest"):
    events = fixture["events"]
    head = events[-1]["lamport"]
    args = {"room": events[0]["room"], "agent": "alice", "after_lamport": max(0, head-100), "limit": 100}
    if variant == "filtered":
        args.update(after_lamport=0, acts=["question"])
    elif variant == "future":
        args["after_lamport"] = head+1
    expected = {"untrusted": reference_page(events, args["after_lamport"], args["limit"], args.get("acts"))}
    with isolated(fixture):
        # Count parsed records separately from elapsed time; no production instrumentation.
        original = store._read_all
        records = []
        def counted(*a, **kw):
            value = original(*a, **kw)
            records.append(len(value[0]))
            return value
        from unittest.mock import patch
        with patch.object(store, "_read_all", counted):
            app.dispatch("room_events", args)
        start = time.perf_counter_ns()
        actual = app.dispatch("room_events", args)
        elapsed = (time.perf_counter_ns()-start)/1_000_000
        return {"elapsed_ms": elapsed, "actual": actual, "expected": expected,
                "fixture_sha256": fixture["manifest"]["fixture_sha256"], "work_units": 1,
                "peak_rss_bytes": rss_bytes(), "records_parsed": sum(records),
                "process_scope": "python-process-lifetime-high-water"}


def cap_check(fixture, append=None):
    """An adapter swallowing room_full cannot pass this oracle."""
    with isolated(fixture) as home:
        path = home / "rooms" / fixture["events"][0]["room"] / "events.jsonl"
        before = sha(path.read_bytes())
        code = None
        try:
            if append is None:
                store.post(fixture["events"][0]["room"], "alice", "heartbeat", "x"*4096)
            else:
                append()
        except store.RoomError as exc:
            code = exc.code
        actual = {"error": code, "unchanged": sha(path.read_bytes()) == before}
        expected = {"error": "room_full", "unchanged": True}
        return {"ok": actual == expected, "expected": expected, "actual": actual}


def _writer(home, barrier, queue, request, template):
    os.environ["CW_HOME"] = home
    try:
        barrier.wait(timeout=30)
        start = time.perf_counter_ns()
        result = store.post(request["room"], request["agent"], request["act"], request["text"], op=request["op"],
                            templates={template["id"]: template}, clock=lambda: request["ts"])
        elapsed = (time.perf_counter_ns()-start)/1_000_000
        queue.put({"event": result, "elapsed_ms": elapsed, "rss": rss_bytes(), "error": None})
    except Exception as exc:
        queue.put({"event": None, "elapsed_ms": None, "rss": rss_bytes(),
                   "error": getattr(exc, "code", type(exc).__name__)})


def concurrency_check(acks, events, malformed, writers=8):
    errors = [a["error"] for a in acks if a.get("error") is not None]
    ack_ids = [a["event"]["id"] for a in acks if a.get("event") is not None]
    mutations = events[1:]
    committed_ids = [e["id"] for e in mutations]
    actual = {"acknowledged": len(ack_ids), "failures": len(errors), "malformed": malformed,
              "unique_acknowledgements": len(set(ack_ids)), "committed": len(mutations),
              "exactly_once": sorted(ack_ids) == sorted(committed_ids) and len(set(committed_ids)) == writers,
              "ordered": [e["lamport"] for e in events] == list(range(1, writers+2)),
              "unique_mutations": len({e.get("op", {}).get("op_id") for e in mutations})}
    expected = {"acknowledged": writers, "failures": 0, "malformed": 0,
                "unique_acknowledgements": writers, "committed": writers, "exactly_once": True,
                "ordered": True, "unique_mutations": writers}
    return {"ok": actual == expected, "actual": actual, "expected": expected}


def concurrency(fixture, writers=8):
    # One synchronized, real operation per writer. Seed/setup/spawn/join are untimed.
    if "writers" not in fixture:
        fixture = concurrency_fixture(fixture["manifest"]["seed"])
    seed = {"events": fixture["events"]}
    with isolated(seed) as home:
        ctx = multiprocessing.get_context("spawn")
        barrier, queue = ctx.Barrier(writers+1), ctx.Queue()
        processes = [ctx.Process(target=_writer, args=(str(home), barrier, queue, fixture["writers"][i], fixture["template"]))
                     for i in range(writers)]
        acks = []
        try:
            for process in processes:
                process.start()
            barrier.wait(timeout=30)
            for _ in processes:
                acks.append(queue.get(timeout=45))
            for process in processes:
                process.join(timeout=30)
                if process.exitcode != 0:
                    raise RuntimeError("writer process failed")
            events, malformed = store.read(ROOM)
            checked = concurrency_check(acks, events, malformed, writers)
            # Verify the final journal folds, including every acknowledged title.
            projection = fold_plan(events, templates={fixture["template"]["id"]: fixture["template"]})
            checked["actual"]["folded_tasks"] = len(projection["tasks"])
            checked["actual"]["fold_rejections"] = len(projection["rejected"])
            checked["expected"].update(folded_tasks=writers, fold_rejections=0)
            checked["actual"]["mutation_payloads"] = sorted([[e["agent"], e["op"]["title"], e["op"].get("op_id")] for e in events[1:]])
            checked["expected"]["mutation_payloads"] = [[f"writer-{i}", f"Synthetic writer {i}", f"writer_{i:08d}"] for i in range(writers)]
            raw = (home / "rooms" / ROOM / "events.jsonl").read_bytes()
            times = [a["elapsed_ms"] for a in acks if a["elapsed_ms"] is not None]
            return {"elapsed_ms": max(times) if times else None, "ack_samples_ms": times,
                    "actual": checked["actual"], "expected": checked["expected"],
                    "work_units": len(times), "fixture_sha256": fixture["manifest"]["fixture_sha256"],
                    "peak_rss_bytes": max([rss_bytes()] + [a["rss"] for a in acks]),
                    "process_scope": "maximum-single-process-high-water; coordinator-and-writers",
                    "journal_sha256": sha(raw), "committed_bytes": len(raw)-len(journal(seed["events"])),
                    "journal_bytes": len(raw),
                    "bytes_per_committed_event": (len(raw)-len(journal(seed["events"])))/(len(events)-1) if len(events)>1 else None,
                    "counts": {"attempted": writers, "committed": len(events)-1, "failed": writers-len(times)}}
        finally:
            for process in processes:
                if process.pid is not None:
                    if process.is_alive():
                        process.terminate()
                    process.join(timeout=10)
            queue.close()
            queue.join_thread()


class AdapterFailure(RuntimeError):
    """Execution receipt without copying private runtime diagnostics into reports."""
    def __init__(self, command, exit_code, reason, stdout=b"", stderr=b""):
        super().__init__(reason)
        self.execution = {"command": command, "exit_code": exit_code, "reason": reason,
                          "stdout_sha256": sha(stdout), "stderr_sha256": sha(stderr)}


def typescript(fixture, variant):
    command = ["node", "--no-warnings", "--expose-gc", "--experimental-strip-types", "--loader",
               "./tests/bench/loader.mjs", "tests/bench/adapter.ts"]
    try:
        with isolated(fixture):
            result = subprocess.run(command, input=encoded({"fixture": fixture, "variant": variant}),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT,
                                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=180)
    except subprocess.TimeoutExpired as exc:
        raise AdapterFailure(command, None, "typescript adapter timed out", exc.stdout or b"", exc.stderr or b"") from None
    except OSError:
        raise AdapterFailure(command, None, "typescript runtime unavailable") from None
    if result.returncode:
        raise AdapterFailure(command, result.returncode, "typescript adapter failed", result.stdout, result.stderr)
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise AdapterFailure(command, result.returncode, "invalid adapter response", result.stdout, result.stderr) from None
    value["command"] = command
    value["exit_code"] = result.returncode
    return value
