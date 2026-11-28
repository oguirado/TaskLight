"""Bounded subprocess-pipe reads for integration tests."""
from functools import lru_cache
import os
import select
import time


@lru_cache(maxsize=1)
def _windows_pipe_api():
    import ctypes
    from ctypes import wintypes

    peek = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe
    peek.argtypes = (wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                     wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD)
    peek.restype = wintypes.BOOL
    return peek


def read_pipe(fd, size, deadline):
    """Return bytes, b'' at EOF, or None when the monotonic deadline expires."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None
    if os.name != "nt":
        return os.read(fd, size) if select.select([fd], [], [], remaining)[0] else None

    import ctypes
    from ctypes import wintypes
    import msvcrt

    peek = _windows_pipe_api()
    handle = msvcrt.get_osfhandle(fd)
    available = wintypes.DWORD()
    while remaining > 0:
        if not peek(handle, None, 0, None, ctypes.byref(available), None):
            error = ctypes.get_last_error()
            if error in (109, 232, 233):  # broken, closing or disconnected pipe
                return b""
            raise ctypes.WinError(error)
        if available.value:
            return os.read(fd, min(size, available.value))
        time.sleep(min(0.01, remaining))
        remaining = deadline - time.monotonic()
    return None
