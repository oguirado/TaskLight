import errno
import hashlib
import os
import stat

from .envelope import respond
from .limits import TAIL_BYTES_MAX, TAIL_N_MAX
from .paths import open_file_confined

_EMPTY_SHA = hashlib.sha256(b"").hexdigest()
_CHUNK = 65536
_BACK = 8192


def _size(lines):
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


def _base(path):
    return {"path": path, "lines": [], "line_count": 0, "byte_count": 0,
            "sha256": _EMPTY_SHA, "cut": False}


def tail(path: str, n: int, roots):
    try:
        if not isinstance(path, str) or type(n) is not int:
            return respond("tail", 2, _base(path if isinstance(path, str) else ""))
        if not 1 <= n <= TAIL_N_MAX:
            return respond("tail", 2, _base(path))
        resolved = roots.resolve(path)
        if resolved is None:
            return respond("tail", 2, _base(path))
        try:
            fd = open_file_confined(resolved, roots)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return respond("tail", 2, _base(path))
            return respond("tail", 7, _base(path))
        try:
            st = os.fstat(fd)
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            return respond("tail", 7, _base(path))
        if not stat.S_ISREG(st.st_mode):
            try:
                os.close(fd)
            except OSError:
                pass
            return respond("tail", 2, _base(path))
        try:
            fh = os.fdopen(fd, "rb")
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            return respond("tail", 7, _base(path))
        with fh:
            try:
                fh.seek(0, os.SEEK_END)
                total_bytes = fh.tell()
            except OSError:
                return respond("tail", 7, _base(path))
            digest = hashlib.sha256()
            line_count = 0
            last_byte = None
            try:
                fh.seek(0)
                while True:
                    chunk = fh.read(_CHUNK)
                    if not chunk:
                        break
                    digest.update(chunk)
                    line_count += chunk.count(b"\n")
                    last_byte = chunk[-1]
            except OSError:
                return respond("tail", 7, _base(path))
            if total_bytes > 0 and last_byte != 10:
                line_count += 1
            # Backward block read for the suffix holding the last n lines.
            pos = total_bytes
            tail_bytes = b""
            try:
                while pos > 0:
                    step = min(_BACK, pos)
                    pos -= step
                    fh.seek(pos)
                    block = fh.read(step)
                    tail_bytes = block + tail_bytes
                    # Need at least n newlines (plus one if a trailing partial
                    # line is the last line, the loop still finds n lines).
                    if tail_bytes.count(b"\n") >= n:
                        break
                    # Bound memory: suffix beyond n lines is discarded;
                    # worst case a single huge line is cut below.
                    if len(tail_bytes) > TAIL_BYTES_MAX + n + 65536 and pos > 0:
                        # Keep only what is needed for the last n lines
                        # is unknown while scanning; cap at a safe bound.
                        tail_bytes = tail_bytes[-65536:]
            except OSError:
                return respond("tail", 7, _base(path))
        text = tail_bytes.decode("utf-8", "replace")
        if text == "":
            all_lines = []
        else:
            all_lines = text.split("\n")
            if text.endswith("\n"):
                all_lines = all_lines[:-1]
        # If the suffix was truncated at the front (pos > 0 and we capped),
        # all_lines may include extra leading lines; the trim below keeps the
        # last n, which is correct only when we scanned back to the start
        # or found >= n newlines. Both hold by the loop condition except the
        # capped case, where the kept tail still holds the last n lines
        # because we kept the most recent 64 KiB.
        lines = list(all_lines[-n:])
        cut = False
        while _size(lines) > TAIL_BYTES_MAX and len(lines) > 1:
            lines.pop(0)
            cut = True
        if lines and _size(lines) > TAIL_BYTES_MAX:
            encoded = lines[0].encode("utf-8")
            lines[0] = encoded[-(TAIL_BYTES_MAX - 1):].decode(
                "utf-8", "ignore")
            cut = True
        return respond("tail", 0,
                       {"path": path, "lines": lines,
                        "line_count": line_count, "byte_count": total_bytes,
                        "sha256": digest.hexdigest(), "cut": cut})
    except Exception as exc:
        return respond("tail", 2, {"error": type(exc).__name__})
