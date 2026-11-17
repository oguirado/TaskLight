"""Portable exclusive interprocess locking for room-store descriptors."""

import errno
import importlib
import math
import os
import time as _time

try:
    _backend = importlib.import_module("fcntl")
    _posix = True
except ImportError:
    try:
        _backend = importlib.import_module("msvcrt")
        _posix = False
    except ImportError as exc:
        raise ImportError(
            "Room locking requires a locking backend: fcntl or msvcrt"
        ) from exc


LOCK_TIMEOUT_S = 1.0


class _LockTiming:
    # Keep lock timing independent of application-wide clock/sleep overrides.
    monotonic = staticmethod(_time.monotonic)
    sleep = staticmethod(_time.sleep)


time = _LockTiming()


def _windows_lock(fd, mode):
    position = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        _backend.locking(fd, mode, 1)
    finally:
        os.lseek(fd, position, os.SEEK_SET)


def lock_exclusive(fd, timeout_s: float = LOCK_TIMEOUT_S):
    """Acquire an exclusive lock within a monotonic, nonblocking deadline."""
    if not math.isfinite(timeout_s) or timeout_s < 0:
        raise ValueError("invalid lock timeout")
    deadline = time.monotonic() + timeout_s
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError("room lock timeout")
        try:
            if _posix:
                _backend.flock(fd, _backend.LOCK_EX | _backend.LOCK_NB)
            else:
                _windows_lock(fd, _backend.LK_NBLCK)
            return
        except OSError as exc:
            contention = (errno.EAGAIN, errno.EWOULDBLOCK)
            if not _posix:
                contention += (errno.EACCES, errno.EDEADLK)
            if (not isinstance(exc, InterruptedError) and exc.errno != errno.EINTR
                    and exc.errno not in contention
                    and not (not _posix and isinstance(exc, PermissionError))):
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("room lock timeout") from exc
            time.sleep(min(0.005, remaining))


def unlock(fd):
    """Release the descriptor's lock without changing its file position."""
    if _posix:
        _backend.flock(fd, _backend.LOCK_UN)
    else:
        _windows_lock(fd, _backend.LK_UNLCK)
