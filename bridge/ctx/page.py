import errno
import hashlib
import os
import stat

from .envelope import respond
from .limits import PAGE_BYTES_MAX, PAGE_LINES_MAX
from .paths import open_file_confined

_EMPTY_SHA = hashlib.sha256(b"").hexdigest()


def _data(path, frm, lines, total, nxt, digest, cut, lossy):
    return {"path": path, "from": frm, "lines": lines,
            "total_lines": total, "next": nxt, "sha256": digest,
            "line_cut": cut, "lossy": lossy}


def _base(path, frm):
    return _data(path, frm, [], 0, None, _EMPTY_SHA, False, False)


def page(path: str, from_line: int, roots, expect_sha256: str | None = None):
    try:
        if not isinstance(path, str) or type(from_line) is not int:
            return respond("page", 2, _base(path if isinstance(path, str) else "",
                                            from_line if type(from_line) is int else 0))
        if expect_sha256 is not None and not isinstance(expect_sha256, str):
            return respond("page", 2, _base(path, from_line))
        resolved = roots.resolve(path)
        if resolved is None:
            return respond("page", 2, _base(path, from_line))
        if from_line < 1:
            return respond("page", 2, _base(path, from_line))
        try:
            fd = open_file_confined(resolved, roots)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return respond("page", 2, _base(path, from_line))
            return respond("page", 7, _base(path, from_line))
        try:
            st = os.fstat(fd)
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            return respond("page", 7, _base(path, from_line))
        if not stat.S_ISREG(st.st_mode):
            try:
                os.close(fd)
            except OSError:
                pass
            return respond("page", 2, _base(path, from_line))
        try:
            with os.fdopen(fd, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return respond("page", 2, _base(path, from_line))
            return respond("page", 7, _base(path, from_line))
        digest = hashlib.sha256(raw).hexdigest()
        try:
            text = raw.decode("utf-8")
            lossy = False
        except UnicodeDecodeError:
            text = raw.decode("utf-8", "replace")
            lossy = True
        if text == "":
            all_lines = []
        else:
            all_lines = text.split("\n")
            if text.endswith("\n"):
                all_lines = all_lines[:-1]
        total = len(all_lines)
        if expect_sha256 is not None and expect_sha256 != digest:
            return respond("page", 4,
                           _data(path, from_line, [], total, None, digest, False,
                                 lossy))
        if from_line > total + 1:
            return respond("page", 2,
                           _data(path, from_line, [], total, None, digest, False,
                                 lossy))
        lines = []
        size = 0
        cut = False
        idx = from_line - 1
        while idx < total and len(lines) < PAGE_LINES_MAX:
            line = all_lines[idx]
            width = len(line.encode("utf-8")) + 1
            if size + width <= PAGE_BYTES_MAX:
                lines.append(line)
                size += width
                idx += 1
            elif lines:
                break
            else:
                truncated = line.encode("utf-8")[:PAGE_BYTES_MAX - 1].decode(
                    "utf-8", "ignore")
                lines.append(truncated)
                cut = True
                idx += 1
                break
        nxt = idx + 1 if idx < total else None
        return respond("page", 0,
                       _data(path, from_line, lines, total, nxt, digest, cut,
                             lossy))
    except Exception as exc:
        return respond("page", 2, {"error": type(exc).__name__})
