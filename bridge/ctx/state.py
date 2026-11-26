import errno
import hashlib
import os
import stat
import subprocess
import sys

from .envelope import respond
from .limits import GIT_TIMEOUT_S


class _GitRace(Exception):
    pass


class _GitFail(Exception):
    pass


def _fd_path(fd: int):
    if not sys.platform.startswith("linux"):
        return None
    path = "/proc/self/fd/%d" % fd
    try:
        os.stat(path)
    except OSError:
        return None
    return path


def _git_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["GIT_ATTR_NOSYSTEM"] = "1"
    env["GIT_ATTR_NOGLOBAL"] = "1"
    env["GIT_TRACE"] = "0"
    env["GIT_TRACE2_EVENT"] = ""
    env["GIT_TRACE2_PERF"] = ""
    env["GIT_TRACE2_NORMAL"] = ""
    return env


def _read_rel(dir_fd: int, parts: list) -> bytes:
    """Read the file at relative parts from dir_fd, O_NOFOLLOW per component."""
    chain: list = []
    cur = dir_fd
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                          | os.O_CLOEXEC, dir_fd=cur)
            chain.append(nxt)
            cur = nxt
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW
                          | os.O_CLOEXEC, dir_fd=cur)
        try:
            with os.fdopen(file_fd, "rb") as fh:
                return fh.read()
        except BaseException:
            try:
                os.close(file_fd)
            except OSError:
                pass
            raise
    finally:
        for f in chain:
            try:
                os.close(f)
            except OSError:
                pass


def _first_line(raw: bytes) -> str:
    return raw.decode("utf-8", "replace").split("\n", 1)[0].strip()


def _parse_gitdir(raw: bytes):
    line = _first_line(raw)
    if not line.startswith("gitdir:"):
        return None
    target = line[len("gitdir:"):].strip()
    return target or None


def _resolve_inside(roots, base: str, value: str):
    if not value or value.startswith("#"):
        return None
    if os.path.isabs(value):
        cand = os.path.normpath(value)
    else:
        cand = os.path.normpath(os.path.join(base, value))
    resolved = roots.resolve(cand)
    if resolved is None:
        return None
    return resolved


def _check_alternates(roots, dir_fd: int, dir_abs: str):
    """None ok; raises _GitRace when an alternate points outside roots."""
    try:
        raw = _read_rel(dir_fd, ["objects", "info", "alternates"])
    except FileNotFoundError:
        return
    except NotADirectoryError:
        return
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise _GitRace
        return
    base = os.path.join(dir_abs, "objects")
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if _resolve_inside(roots, base, line) is None:
            raise _GitRace


def _check_commondir(roots, gitdir_fd: int, gitdir_abs: str):
    """Validate the `commondir` redirect, if present. Raises _GitRace."""
    raw = None
    try:
        raw = _read_rel(gitdir_fd, ["commondir"])
    except FileNotFoundError:
        raw = None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise _GitRace
    if raw is not None:
        value = _first_line(raw)
        if value:
            common = _resolve_inside(roots, gitdir_abs, value)
            if common is None:
                raise _GitRace
            _check_alternates_at(roots, common)
    _check_alternates(roots, gitdir_fd, gitdir_abs)


def _check_alternates_at(roots, dir_abs: str):
    try:
        from .paths import open_dir_confined
        fd = open_dir_confined(dir_abs, roots)
    except OSError:
        return
    try:
        _check_alternates(roots, fd, dir_abs)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _blob_hash(content: bytes, fmt: str) -> str:
    h = hashlib.new("sha256" if fmt == "sha256" else "sha1")
    h.update(b"blob %d\0" % len(content))
    h.update(content)
    return h.hexdigest()


def _worktree_differs(repo_fd: int, rel_path: str, index_entry, fmt: str) -> bool:
    mode, expected = index_entry
    parts = [p for p in rel_path.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return True
    chain: list = []
    cur = repo_fd
    try:
        for part in parts[:-1]:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                              | os.O_CLOEXEC, dir_fd=cur)
            except OSError:
                return True
            chain.append(nxt)
            cur = nxt
        if mode == "120000":
            try:
                target = os.readlink(parts[-1], dir_fd=cur)
            except OSError:
                return True
            return _blob_hash(target.encode("utf-8", "surrogateescape"),
                              fmt) != expected
        if mode == "160000":
            try:
                st = os.stat(parts[-1], dir_fd=cur, follow_symlinks=False)
            except OSError:
                return True
            return not stat.S_ISDIR(st.st_mode)
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                         | os.O_CLOEXEC, dir_fd=cur)
        except OSError:
            return True
        h = hashlib.new("sha256" if fmt == "sha256" else "sha1")
        try:
            st = os.fstat(fd)
            h.update(b"blob %d\0" % st.st_size)
            with os.fdopen(fd, "rb") as fh:
                while True:
                    chunk = fh.read(65536)
                    if not chunk:
                        break
                    h.update(chunk)
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            return True
        return h.hexdigest() != expected
    finally:
        for f in chain:
            try:
                os.close(f)
            except OSError:
                pass


def _compute_dirty(run, repo_fd: int, fmt: str) -> int:
    index: dict = {}
    conflicts: set = set()
    out = run(["ls-files", "--stage", "-z"])
    for entry in out.split("\0"):
        if not entry:
            continue
        try:
            meta, path = entry.split("\t", 1)
            mode, sha, stage = meta.split()
        except ValueError:
            continue
        if stage != "0":
            conflicts.add(path)
            continue
        index[path] = (mode, sha)
    head_map: dict = {}
    out = run(["ls-tree", "-r", "-z", "HEAD"])
    for entry in out.split("\0"):
        if not entry:
            continue
        try:
            meta, path = entry.split("\t", 1)
            mode, typ, sha = meta.split()
        except ValueError:
            continue
        if typ == "tree":
            continue
        head_map[path] = sha
    changed: set = set(conflicts)
    for path in set(index) | set(head_map):
        im = index.get(path)
        hm = head_map.get(path)
        if im is None or hm is None or im[1] != hm:
            changed.add(path)
            continue
        if _worktree_differs(repo_fd, path, im, fmt):
            changed.add(path)
    return len(changed)


def _now(proc_root: str, now_s) -> int:
    if now_s is not None:
        return now_s
    try:
        with open(os.path.join(proc_root, "uptime"), "r") as fh:
            return int(float(fh.read().split()[0]))
    except Exception:
        return 0


def _git_facts(target: str, roots):
    resolved = roots.resolve(target)
    if resolved is None:
        return respond("state", 2, {"facts": {}})
    from .paths import open_dir_confined
    try:
        repo_fd = open_dir_confined(resolved, roots)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return respond("state", 2, {"facts": {}})
        return respond("state", 7, {"facts": {}})
    gitdir_fd = None
    try:
        try:
            repo_ident = (os.fstat(repo_fd).st_dev, os.fstat(repo_fd).st_ino)
            dot_st = os.stat(".git", dir_fd=repo_fd, follow_symlinks=False)
        except OSError:
            return respond("state", 7, {"facts": {}})
        if stat.S_ISLNK(dot_st.st_mode):
            return respond("state", 2, {"facts": {}})
        if stat.S_ISDIR(dot_st.st_mode):
            gitdir_abs = os.path.join(resolved, ".git")
            try:
                gitdir_fd = os.open(".git", os.O_RDONLY | os.O_DIRECTORY
                                    | os.O_NOFOLLOW | os.O_CLOEXEC,
                                    dir_fd=repo_fd)
            except OSError as exc:
                if exc.errno == errno.ELOOP:
                    return respond("state", 2, {"facts": {}})
                return respond("state", 7, {"facts": {}})
            _check_commondir(roots, gitdir_fd, gitdir_abs)
        elif stat.S_ISREG(dot_st.st_mode):
            try:
                raw = _read_rel(repo_fd, [".git"])
            except OSError as exc:
                if exc.errno == errno.ELOOP:
                    return respond("state", 2, {"facts": {}})
                return respond("state", 7, {"facts": {}})
            value = _parse_gitdir(raw)
            if value is None:
                return respond("state", 2, {"facts": {}})
            gitdir_abs = _resolve_inside(roots, resolved, value)
            if gitdir_abs is None:
                return respond("state", 2, {"facts": {}})
            try:
                gitdir_fd = open_dir_confined(gitdir_abs, roots)
            except OSError as exc:
                if exc.errno == errno.ELOOP:
                    return respond("state", 2, {"facts": {}})
                return respond("state", 7, {"facts": {}})
            _check_commondir(roots, gitdir_fd, gitdir_abs)
        else:
            return respond("state", 2, {"facts": {}})
        gitdir_ident = (os.fstat(gitdir_fd).st_dev, os.fstat(gitdir_fd).st_ino)
        repo_p = _fd_path(repo_fd) or resolved
        gitdir_p = _fd_path(gitdir_fd) or gitdir_abs

        def _check_pinned() -> None:
            for path, ident in ((resolved, repo_ident),
                                (gitdir_abs, gitdir_ident)):
                try:
                    if os.path.islink(path):
                        raise _GitRace
                    now = os.stat(path)
                    if (now.st_dev, now.st_ino) != ident:
                        raise _GitRace
                except _GitRace:
                    raise
                except OSError:
                    raise _GitRace

        def _run_git(args: list) -> str:
            _check_pinned()
            argv = ["git", "--no-pager", "--no-optional-locks",
                    "-c", "core.fsmonitor=", "-c", "core.hooksPath=" + os.devnull,
                    "-c", "core.untrackedCache=false",
                    "-C", repo_p, "--git-dir", gitdir_p, "--work-tree",
                    repo_p] + args
            os.set_inheritable(repo_fd, True)
            os.set_inheritable(gitdir_fd, True)
            try:
                proc = subprocess.run(argv, capture_output=True, text=True,
                                      timeout=GIT_TIMEOUT_S, env=_git_env(),
                                      close_fds=False)
            finally:
                os.set_inheritable(repo_fd, False)
                os.set_inheritable(gitdir_fd, False)
            _check_pinned()
            if proc.returncode != 0:
                raise _GitFail
            return proc.stdout

        try:
            branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]).strip()
            if branch == "HEAD":
                branch = ""
            head = _run_git(["rev-parse", "HEAD"]).strip()
            fmt = "sha1"
            try:
                fmt = _run_git(["rev-parse", "--show-object-format"]).strip() \
                    or "sha1"
            except _GitFail:
                fmt = "sha1"
            dirty = _compute_dirty(_run_git, repo_fd, fmt)
        except _GitRace:
            return respond("state", 2, {"facts": {}})
        except (FileNotFoundError, subprocess.TimeoutExpired, _GitFail):
            return respond("state", 124, {"facts": {}})
        return respond("state", 0,
                       {"facts": {"kind": "git", "branch": branch,
                                  "head": head, "dirty": dirty}})
    except _GitRace:
        return respond("state", 2, {"facts": {}})
    finally:
        if gitdir_fd is not None:
            try:
                os.close(gitdir_fd)
            except OSError:
                pass
        try:
            os.close(repo_fd)
        except OSError:
            pass


def state(target: str, roots, proc_root: str = "/proc", now_s: int | None = None):
    try:
        if not isinstance(target, str) or not isinstance(proc_root, str):
            return respond("state", 2, {"facts": {}})
        if now_s is not None and type(now_s) is not int:
            return respond("state", 2, {"facts": {}})
        if target.startswith("pid:"):
            pid_text = target[4:]
            if not pid_text.isdigit():
                return respond("state", 2, {"facts": {}})
            pid = int(pid_text)
            if proc_root == "/proc":
                proc_available = (sys.platform.startswith("linux")
                                  and os.path.isfile(os.path.join(proc_root, "stat")))
            else:
                proc_available = os.path.isdir(proc_root)
            if not proc_available:
                return respond("state", 7, {"facts": {}, "capability": "procfs_unavailable"})
            base = os.path.join(proc_root, str(pid))
            try:
                with open(os.path.join(base, "stat"), "r") as fh:
                    stat_text = fh.read()
                with open(os.path.join(base, "status"), "r") as fh:
                    status_text = fh.read()
            except OSError:
                return respond("state", 7, {"facts": {}})
            cut = stat_text.rfind(")")
            fields = stat_text[cut + 2:].split()
            start_ticks = int(fields[19])
            rss = 0
            for line in status_text.splitlines():
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
            try:
                clk = os.sysconf("SC_CLK_TCK")
            except Exception:
                clk = 100
            runtime = _now(proc_root, now_s) - start_ticks // clk
            return respond("state", 0,
                           {"facts": {"kind": "pid", "alive": True,
                                      "rss_kib": rss, "runtime_s": runtime}})
        return _git_facts(target, roots)
    except Exception:
        return respond("state", 2, {"facts": {}})
