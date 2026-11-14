import errno
import os
import stat

from .envelope import respond
from .limits import CENSUS_ENTRIES_MAX, CENSUS_TOP
from .paths import open_dir_confined


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
        try:
            root_fd = open_dir_confined(resolved, roots)
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

        def _recurse(dir_str, dir_fd):
            nonlocal entries, files, nbytes, complete, stopped
            if stopped:
                return
            try:
                names = os.listdir(dir_fd)
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
                    st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISLNK(st.st_mode):
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
                try:
                    child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY
                                       | os.O_NOFOLLOW | os.O_CLOEXEC,
                                       dir_fd=dir_fd)
                except OSError:
                    complete = False
                    continue
                try:
                    _recurse(os.path.join(dir_str, name), child_fd)
                finally:
                    try:
                        os.close(child_fd)
                    except OSError:
                        pass

        try:
            _recurse(resolved, root_fd)
        finally:
            try:
                os.close(root_fd)
            except OSError:
                pass
        items.sort(key=lambda item: (-item[1], item[0]))
        largest = [{"path": path, "bytes": size}
                   for path, size in items[:CENSUS_TOP]]
        return respond("census", 0,
                       {"files": files, "bytes": nbytes, "by_ext": by_ext,
                        "largest": largest, "complete": complete})
    except Exception as exc:
        return respond("census", 2, {"error": type(exc).__name__})
