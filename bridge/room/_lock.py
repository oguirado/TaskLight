"""Portable exclusive interprocess locking for room-store descriptors."""

import errno
import importlib
import os
import time

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


def _windows_lock(fd, mode):
    position = os.lseek(fd, 0, os.SEEK_CUR)
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        while True:
            try:
                _backend.locking(fd, mode, 1)
                return
            except OSError as exc:
                if mode != _backend.LK_LOCK or exc.errno not in (
                    errno.EACCES, errno.EAGAIN, errno.EDEADLK
                ):
                    raise
                time.sleep(0.05)
    finally:
        os.lseek(fd, position, os.SEEK_SET)


def lock_exclusive(fd):
    """Acquire an exclusive lock, waiting until a contended lock is available."""
    if _posix:
        _backend.flock(fd, _backend.LOCK_EX)
    else:
        _windows_lock(fd, _backend.LK_LOCK)


def unlock(fd):
    """Release the descriptor's lock without changing its file position."""
    if _posix:
        _backend.flock(fd, _backend.LOCK_UN)
    else:
        _windows_lock(fd, _backend.LK_UNLCK)
