"""Silent, local lifecycle entry with durable replay and fenced task cleanup."""

import time

_ENTRY_STARTED = time.monotonic()

import contextlib
import hashlib
import json
import os
import signal
import sys

_INPUT_MAX = 65536
_SECONDS = 2.0
_REQUIRED = {"event_id", "room", "agent", "state", "run_id"}
_OPTIONAL = {"swarm": 128, "harness": 128, "reason": 512}
_STATES = {"deployed", "alive", "finished", "failed"}


class _Expired(BaseException):
    """Escape storage's broad Exception handlers without interrupting writes."""


class _Deadline:
    expiration = _Expired

    def __init__(self, started=None, reserve=0.0):
        self.end = (time.monotonic() if started is None else started) + _SECONDS - reserve
        self.waiting = False
        self.timer = False
        self.lock_module = None

    def check(self):
        if time.monotonic() >= self.end:
            raise _Expired()

    def _alarm(self, signum, frame):
        # Outside a wait, defer expiry to the next budget check. In particular,
        # an acquired journal lock protects an uninterrupted commit and fsync.
        if self.waiting:
            raise _Expired()

    def __enter__(self):
        self.check()
        if os.name == "posix" and hasattr(signal, "setitimer"):
            self.old_handler = signal.signal(signal.SIGALRM, self._alarm)
            try:
                self.old_timer = signal.setitimer(signal.ITIMER_REAL,
                                                 self.end - time.monotonic())
            except BaseException:
                signal.signal(signal.SIGALRM, self.old_handler)
                raise
            self.timer = True
        return self

    @contextlib.contextmanager
    def wait(self):
        self.waiting = True
        try:
            # Set the interruptible flag before checking time: an alarm between
            # the check and the actual wait must not be lost or deferred.
            self.check()
            yield
        finally:
            self.waiting = False

    def guard_locks(self, module):
        # Only the lock acquisition waits are interruptible. No outer lock is
        # taken, and dispatch keeps ownership of each complete transaction.
        self.lock_module = module
        self.old_lock = module.lock_exclusive

        def acquire(fd):
            with self.wait():
                return self.old_lock(fd)

        module.lock_exclusive = acquire

    def __exit__(self, *exc):
        if self.lock_module is not None:
            self.lock_module.lock_exclusive = self.old_lock
        if self.timer:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.old_handler)
            if self.old_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, *self.old_timer)


def _error(code, detail=None):
    result = {"ok": False, "code": code}
    if detail:
        result["detail"] = detail
    return result


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("invalid JSON constant")


def _parse(raw):
    if not isinstance(raw, bytes) or len(raw) > _INPUT_MAX:
        raise ValueError("invalid input size or type")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                       parse_constant=_invalid_constant)
    if (not isinstance(value, dict) or not _REQUIRED <= value.keys()
            or value.keys() - (_REQUIRED | _OPTIONAL.keys())):
        raise ValueError("missing or unknown fields")
    # Reject escaped lone surrogates, including in metadata that does not enter
    # the operation digest. All persisted strings must remain UTF-8 encodable.
    for item in value.values():
        if isinstance(item, str):
            item.encode("utf-8")
    return value


def _digest(parts):
    canonical = json.dumps(parts, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _execute(raw, deadline):
    try:
        value = _parse(raw)
    except (ValueError, UnicodeError, RecursionError):
        return _error("bad_args")
    deadline.check()
    # Import within the invocation budget, with no provider or adapter imports.
    from bridge.room import app, _lock
    from bridge.room import store
    from bridge.room.ext import cleanup

    committed = None
    try:
        deadline.check()
        store._check_room(value["room"])
        store._check_agent(value["agent"])
        for key in ("event_id", "run_id", "state"):
            if not isinstance(value[key], str) or not value[key]:
                raise store.RoomError("bad_op", key + " must be a nonempty string")
        if value["state"] not in _STATES:
            raise store.RoomError("bad_op", "invalid lifecycle state")
        for key, maximum in _OPTIONAL.items():
            if key in value and (not isinstance(value[key], str) or not value[key]
                                 or len(value[key]) > maximum):
                raise store.RoomError("bad_op", "invalid " + key)
        args = {key: item for key, item in value.items() if key != "event_id"}
        args["op_id"] = _digest(["lifecycle", value["room"], value["agent"],
                                 value["run_id"], value["event_id"]])
        deadline.guard_locks(_lock)
        deadline.check()
        with cleanup.budget(deadline):
            cleanup.room_directory(value["room"], create=True)
            result = app.dispatch("agent_lifecycle", args)
        receipt = result.get("untrusted") if isinstance(result, dict) else None
        if not isinstance(receipt, dict) or receipt.get("ok") is not True:
            return result
        committed = result
        lamport = receipt.get("lamport")
        if (value["state"] in ("failed", "finished")
                and cleanup._integer(lamport) and "cleanup" not in receipt):
            # Preserve cleanup when a legacy dispatcher supplies only a lifecycle
            # receipt. The current shared handler already returns both receipts.
            receipt["cleanup"] = cleanup.terminal(
                app, args, value["event_id"], lamport, deadline)
        return result
    except cleanup.Pending as exc:
        # Persistence succeeded even though cleanup must be retried. Preserve
        # both receipts through the callable hook; its executable stays silent.
        return {"untrusted": exc.receipt}
    except _Expired:
        return committed if committed is not None else _error("internal")
    except Exception as exc:
        # A committed lifecycle remains successful if cleanup is incomplete.
        # Exact replay will try the remaining eligible claims again. In
        # particular no_plan means there is no cleanup, not lifecycle failure.
        return committed if committed is not None else app._error_payload(exc)


def run_hook_bytes(raw: bytes) -> dict:
    """Return shared lifecycle receipts/errors; terminal cleanup is resumable."""
    try:
        with _Deadline() as deadline:
            return _execute(raw, deadline)
    except _Expired:
        return _error("internal")
    except Exception:
        return _error("internal")


def main():
    """Read bounded stdin and return silently, regardless of persistence."""
    try:
        # Reserve startup/exit overhead within the overall CLI wall-time budget.
        with _Deadline(_ENTRY_STARTED, reserve=0.2) as deadline:
            with deadline.wait():
                raw = sys.stdin.buffer.read(_INPUT_MAX + 1)
            _execute(raw, deadline)
    except (_Expired, Exception):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
