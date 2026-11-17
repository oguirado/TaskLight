"""Shared terminal cleanup with separate, replayable completion receipts.

Lifecycle persistence precedes cleanup. Every retry uses the original terminal
Lamport boundary and rechecks current plan, run, ownership and claim identities.
No task completion or plan creation is implied by termination.
"""
import contextlib
from contextvars import ContextVar
import hashlib
import json
import os
import time

from bridge.room import store


class Pending(store.RoomError):
    """Keep transport deduplication pending until cleanup can be certified."""

    def __init__(self, receipt):
        super().__init__("internal", "terminal cleanup incomplete; replay the exact lifecycle operation")
        self.receipt = receipt


class _BudgetExpired(BaseException):
    pass


class _Budget:
    expiration = _BudgetExpired

    def __init__(self):
        self.end = time.monotonic() + 2.0

    def check(self):
        if time.monotonic() >= self.end:
            raise self.expiration()


_budget = ContextVar("terminal_cleanup_budget", default=None)


@contextlib.contextmanager
def budget(deadline):
    """Let a harness hook share its invocation budget with the handler."""
    token = _budget.set(deadline)
    try:
        yield
    finally:
        _budget.reset(token)


def room_directory(room, *, create=False):
    """Use the same room bootstrap policy for every lifecycle transport."""
    if create:
        return store._ensure_dirs(None, room)
    directory = store._room_dir(None, room)
    if not os.path.isdir(directory):
        raise store.RoomError("no_room", "room does not exist")
    return directory


def _digest(parts):
    canonical = json.dumps(parts, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def _generation(projection, args, lamport):
    if not isinstance(projection, dict):
        return None
    plan = projection.get("plan")
    agents = projection.get("agent_lifecycle")
    if not isinstance(plan, dict) or plan.get("state") != "active" or not isinstance(agents, dict):
        return None
    lifecycle = agents.get(args["agent"])
    if (not isinstance(lifecycle, dict) or lifecycle.get("run_id") != args["run_id"]
            or lifecycle.get("lifecycle") != args["state"]):
        return None
    opened = plan.get("opened_lamport")
    return opened if _integer(opened) and opened < lamport else None


def _eligible(task, args, lamport):
    return (isinstance(task, dict) and isinstance(task.get("id"), str) and bool(task["id"])
            and task.get("assignee") == args["agent"]
            and task.get("state") in ("pending", "active", "blocked")
            and _integer(task.get("claim_lamport")) and task["claim_lamport"] < lamport
            and _integer(task.get("rev")))


def _cleanup(app, args, event_id, lamport, deadline):
    def projection():
        deadline.check()
        result = app.dispatch("plan_get", {"room": args["room"], "agent": args["agent"]})
        return result.get("untrusted") if isinstance(result, dict) else None

    try:
        initial = projection()
    except app.RoomError as exc:
        if exc.code == "no_plan":
            return "complete"
        raise
    opened = _generation(initial, args, lamport)
    if opened is None or not isinstance(initial.get("tasks"), list):
        return "skipped"
    # Capture identities, never historical revisions. Replay reconstructs the
    # remaining pre-terminal claims from the current projection and original L.
    claims = [(task["id"], task["claim_lamport"]) for task in initial["tasks"]
              if _eligible(task, args, lamport)]
    for task_id, claim in claims:
        op_id = _digest(["release", args["room"], args["agent"], args["run_id"],
                         event_id, opened, task_id, claim])
        retries = 0
        while True:
            current = projection()
            if _generation(current, args, lamport) != opened:
                return "skipped"
            tasks = current.get("tasks")
            if not isinstance(tasks, list):
                return "skipped"
            task = next((t for t in tasks if isinstance(t, dict) and t.get("id") == task_id), None)
            if not _eligible(task, args, lamport) or task["claim_lamport"] != claim:
                break
            release = {"room": args["room"], "agent": args["agent"], "task_id": task_id,
                       "base_rev": task["rev"], "claim_lamport": claim, "op_id": op_id}
            deadline.check()
            try:
                app.dispatch("task_release", release)
            except app.RoomError as exc:
                if (exc.code == "stale_rev" and retries < 3
                        and time.monotonic() + 0.2 < deadline.end):
                    retries += 1
                    continue
                # Continue independent claims, then certify the final projection.
            break

    current = projection()
    if _generation(current, args, lamport) != opened:
        return "skipped"
    tasks = current.get("tasks")
    if not isinstance(tasks, list):
        return "skipped"
    return "pending" if any(_eligible(task, args, lamport) for task in tasks) else "complete"


def terminal(app, args, event_id, lamport, deadline=None):
    """Return cleanup status independently of the committed lifecycle receipt.

    A pending receipt calls for exact replay. Completion is reconstructed from
    the journal-backed projection, so a crash needs no separate progress file.
    """
    deadline = deadline or _budget.get() or _Budget()
    receipt = {"id": _digest(["cleanup", args["room"], args["agent"],
                               args["run_id"], lamport]), "status": "pending"}
    try:
        receipt["status"] = _cleanup(app, args, event_id, lamport, deadline)
    except deadline.expiration:
        pass
    except Exception as exc:
        receipt["code"] = getattr(exc, "code", "internal")
    return receipt
