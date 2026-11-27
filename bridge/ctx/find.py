from contextlib import ExitStack
import errno
import os
import stat
import time

from .envelope import respond
from .limits import (FIND_DEADLINE_MS, FIND_FILE_MAX, FIND_K_MAX,
                     FIND_TERMS_MAX, SNIPPET_MAX)
from .paths import confined_directory, is_link


def _base():
    return {"hits": [], "complete": False, "scanned": 0, "skipped": 0,
            "binary": 0}


def find(terms, root: str, k: int, roots, deadline_ms: int = FIND_DEADLINE_MS,
         monotonic=None):
    try:
        if (not isinstance(terms, list) or type(k) is not int
                or not isinstance(root, str) or type(deadline_ms) is not int):
            return respond("find", 2, _base())
        if not 1 <= k <= FIND_K_MAX:
            return respond("find", 2, _base())
        if not 1 <= len(terms) <= FIND_TERMS_MAX:
            return respond("find", 2, _base())
        for t in terms:
            if not isinstance(t, str) or t == "":
                return respond("find", 2, _base())
        resolved = roots.resolve(root)
        if resolved is None:
            return respond("find", 2, _base())
        uniq = []
        seen = set()
        for t in terms:
            folded = t.casefold()
            if folded not in seen:
                seen.add(folded)
                uniq.append((t, folded))
        clock = monotonic if monotonic is not None else time.monotonic
        start = clock()
        hits = []
        scanned = 0
        skipped = 0
        binary = 0
        present = set()
        timed_out = False

        def _expired() -> bool:
            return (clock() - start) * 1000 > deadline_ms

        directories = ExitStack()
        try:
            root_dir = directories.enter_context(confined_directory(resolved, roots))
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return respond("find", 2, _base())
            if exc.errno == errno.EACCES or exc.errno == errno.EPERM:
                data = {"hits": [], "complete": False, "scanned": 0,
                        "skipped": 1, "binary": 0}
                return respond("find", 0, data)
            return respond("find", 7, _base())

        def _recurse(dir_str, directory):
            nonlocal timed_out, scanned, skipped, binary
            if _expired():
                timed_out = True
                return
            try:
                names = directory.names()
            except OSError:
                skipped += 1
                return
            entries = []
            for name in sorted(names):
                try:
                    st = directory.stat(name)
                except OSError:
                    skipped += 1
                    continue
                if is_link(st):
                    continue
                kind = stat.S_IFMT(st.st_mode)
                entries.append((name, st, kind))
            dir_names = [n for n, _s, k in entries if k == stat.S_IFDIR]
            file_names = [(n, s) for n, s, k in entries if k != stat.S_IFDIR]
            for name, st in file_names:
                if _expired():
                    timed_out = True
                    return
                full = os.path.join(dir_str, name)
                if not stat.S_ISREG(st.st_mode):
                    skipped += 1
                    continue
                if st.st_size > FIND_FILE_MAX:
                    skipped += 1
                    continue
                try:
                    fd = directory.open_file(name)
                except OSError:
                    skipped += 1
                    continue
                try:
                    fst = os.fstat(fd)
                except OSError:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    skipped += 1
                    continue
                if not stat.S_ISREG(fst.st_mode) or fst.st_size > FIND_FILE_MAX:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    skipped += 1
                    continue
                try:
                    with os.fdopen(fd, "rb") as fh:
                        raw = fh.read()
                except OSError:
                    skipped += 1
                    continue
                if b"\x00" in raw[:8192]:
                    binary += 1
                    continue
                scanned += 1
                text = raw.decode("utf-8", "replace")
                for number, line in enumerate(text.split("\n"), 1):
                    folded_line = line.casefold()
                    cover = 0
                    for _orig, folded in uniq:
                        if folded in folded_line:
                            cover += 1
                            present.add(folded)
                    if cover:
                        hits.append({"path": full, "line": number,
                                     "cover": cover,
                                     "snippet": line.rstrip("\r")[:SNIPPET_MAX]})
                if _expired():
                    timed_out = True
                    return
            for name in dir_names:
                if timed_out:
                    return
                if name == ".git":
                    continue
                child = ExitStack()
                try:
                    child_dir = child.enter_context(directory.subdir(name))
                except OSError:
                    skipped += 1
                    continue
                try:
                    _recurse(os.path.join(dir_str, name), child_dir)
                finally:
                    child.close()
                if timed_out:
                    return

        try:
            _recurse(resolved, root_dir)
        finally:
            directories.close()
        if not timed_out and _expired():
            timed_out = True
        hits.sort(key=lambda h: (-h["cover"], h["path"], h["line"]))
        hits = hits[:k]
        complete = not skipped and not timed_out
        data = {"hits": hits, "complete": complete, "scanned": scanned,
                "skipped": skipped, "binary": binary}
        if complete:
            data["absent"] = [orig for orig, folded in uniq
                              if folded not in present]
        return respond("find", 124 if timed_out else 0, data)
    except Exception as exc:
        return respond("find", 2, {"error": type(exc).__name__})
