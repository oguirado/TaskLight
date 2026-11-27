from contextlib import ExitStack
import errno
import os
import stat

from .envelope import respond
from .limits import CENSUS_ENTRIES_MAX, CENSUS_TOP
from .paths import confined_directory, is_link


def _base():
    return {"files": 0, "bytes": 0, "by_ext": {}, "largest": [],
            "complete": False}


def census(dir: str, roots):
    try:
        if not isinstance(dir, str):
            return respond("census", 2, _base())
        resolved = roots.resolve(dir)
        if resolved is None:
            return respond("census", 2, _base())
        directories = ExitStack()
        try:
            root_dir = directories.enter_context(confined_directory(resolved, roots))
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                return respond("census", 2, _base())
            if exc.errno == errno.EACCES or exc.errno == errno.EPERM:
                return respond("census", 0, _base())
            return respond("census", 7, _base())
        entries = 0
        files = 0
        nbytes = 0
        by_ext: dict[str, int] = {}
        items = []
        complete = True
        stopped = False

        def _recurse(dir_str, directory):
            nonlocal entries, files, nbytes, complete, stopped
            if stopped:
                return
            try:
                names = directory.names()
            except OSError:
                complete = False
                return
            entries += len(names)
            if entries > CENSUS_ENTRIES_MAX:
                complete = False
                stopped = True
                return
            entries_by_name = []
            for name in sorted(names):
                try:
                    st = directory.stat(name)
                except OSError:
                    continue
                if is_link(st):
                    continue
                entries_by_name.append((name, st))
            for name, st in entries_by_name:
                if stopped:
                    return
                if stat.S_ISDIR(st.st_mode):
                    pass
                elif stat.S_ISREG(st.st_mode):
                    full = os.path.join(dir_str, name)
                    size = st.st_size
                    files += 1
                    nbytes += size
                    suffix = os.path.splitext(name)[1]
                    ext = suffix[1:].lower() if suffix.startswith(".") else ""
                    by_ext[ext] = by_ext.get(ext, 0) + 1
                    items.append((full, size))
            for name, st in entries_by_name:
                if stopped:
                    return
                if not stat.S_ISDIR(st.st_mode):
                    continue
                if name == ".git":
                    continue
                child = ExitStack()
                try:
                    child_dir = child.enter_context(directory.subdir(name))
                except OSError:
                    complete = False
                    continue
                try:
                    _recurse(os.path.join(dir_str, name), child_dir)
                finally:
                    child.close()

        try:
            _recurse(resolved, root_dir)
        finally:
            directories.close()
        items.sort(key=lambda item: (-item[1], item[0]))
        largest = [{"path": path, "bytes": size}
                   for path, size in items[:CENSUS_TOP]]
        return respond("census", 0,
                       {"files": files, "bytes": nbytes, "by_ext": by_ext,
                        "largest": largest, "complete": complete})
    except Exception as exc:
        return respond("census", 2, {"error": type(exc).__name__})
