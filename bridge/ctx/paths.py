import errno
import os
import stat
from contextlib import ExitStack, contextmanager

from ._windows import open_handle as _open_windows_handle


def _chain_has_link(path: str) -> bool:
    cur = ""
    for part in path.split(os.sep):
        if part == "":
            continue
        cur = os.path.join(cur, part) if cur else os.path.join(os.sep, part)
        if os.path.islink(cur):
            return True
    return False


def _within(child: str, root: str) -> bool:
    """True when `child` (absolute, normalised) is `root` or inside it.

    Handles drive roots and case-insensitive path comparisons.
    """
    if os.name != "nt":
        if root == os.sep:
            return child.startswith(os.sep)
        return child == root or child.startswith(root + os.sep)
    try:
        return os.path.normcase(os.path.commonpath((child, root))) == os.path.normcase(root)
    except ValueError:
        return False


class Roots:
    def __init__(self, roots: tuple[str, ...]) -> None:
        if os.name == "nt":
            canonical = []
            for root in roots:
                try:
                    canonical.append(windows_realpath(root))
                except (OSError, ValueError):
                    continue
            self.roots = tuple(canonical)
        else:
            self.roots = tuple(os.path.realpath(r) for r in roots)

    def resolve(self, p: str) -> str | None:
        if not isinstance(p, str) or p == "":
            return None
        if os.name == "nt":
            try:
                rp = windows_realpath(p)
            except (OSError, ValueError):
                return None
            return rp if any(_within(rp, root) for root in self.roots) else None
        ap = os.path.abspath(p)
        rp = os.path.realpath(ap)
        matched = False
        for root in self.roots:
            if _within(rp, root):
                matched = True
                break
        if not matched:
            return None
        if _chain_has_link(ap):
            return None
        return ap


def _match_root(resolved: str, roots):
    for root in roots.roots:
        if resolved == root:
            return (root, "")
        if _within(resolved, root):
            return (root, resolved[len(root):])
    return None


def _parts(rel: str) -> list:
    return [p for p in rel.split(os.sep) if p not in ("", ".")]


def _open_root_pinned(root: str) -> int:
    """Open `root` (absolute) component-wise from "/" with O_NOFOLLOW.

    Every intermediate component is checked, so an allowed root whose
    ancestor was replaced by a symlink after `Roots.resolve` fails with
    ELOOP instead of being followed into an outside directory.
    """
    try:
        root_fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY
                          | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        root_fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    chain = [root_fd]
    cur = root_fd
    try:
        for part in _parts(root):
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                          | os.O_CLOEXEC, dir_fd=cur)
            chain.append(nxt)
            cur = nxt
    except BaseException:
        for f in chain:
            try:
                os.close(f)
            except OSError:
                pass
        raise
    for f in chain[:-1]:
        try:
            os.close(f)
        except OSError:
            pass
    return cur


def open_dir_confined(resolved: str, roots) -> int:
    m = _match_root(resolved, roots)
    if m is None:
        raise OSError(errno.ENOENT, "no root")
    root, rel = m
    root_fd = _open_root_pinned(root)
    try:
        chain = [root_fd]
        cur = root_fd
        for part in _parts(rel):
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                          | os.O_CLOEXEC, dir_fd=cur)
            chain.append(nxt)
            cur = nxt
    except BaseException:
        for f in chain:
            try:
                os.close(f)
            except OSError:
                pass
        raise
    for f in chain[:-1]:
        try:
            os.close(f)
        except OSError:
            pass
    return cur


def open_file_confined(resolved: str, roots) -> int:
    if os.name == "nt":
        root = next((root for root in roots.roots if _within(resolved, root)), None)
        if root is None or os.path.normcase(resolved) == os.path.normcase(root):
            raise OSError(errno.ELOOP, "file outside allowed roots")
        with windows_directory(os.path.dirname(resolved)) as directory:
            return directory.open_file(os.path.basename(resolved))
    m = _match_root(resolved, roots)
    if m is None:
        raise OSError(errno.ENOENT, "no root")
    root, rel = m
    parts = _parts(rel)
    root_fd = _open_root_pinned(root)
    chain = [root_fd]
    cur = root_fd
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                          | os.O_CLOEXEC, dir_fd=cur)
            chain.append(nxt)
            cur = nxt
        if not parts:
            raise OSError(errno.EISDIR, "dir")
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                       | os.O_CLOEXEC, dir_fd=cur)
    finally:
        for f in chain:
            try:
                os.close(f)
            except OSError:
                pass


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _unsafe_windows_path(path):
    """Reject Win32 device aliases and alternate data streams."""
    path = os.fspath(path)
    if not isinstance(path, str) or "\x00" in path:
        return True
    drive, rest = os.path.splitdrive(path)
    if drive and (len(drive) != 2 or drive[1] != ":" or not os.path.isabs(path)):
        return True
    for part in rest.replace("\\", "/").split("/"):
        if part in ("", ".", ".."):
            continue
        stem = part.split(".")[0].rstrip().upper()
        if (part.endswith((" ", ".")) or any(ord(c) < 32 or c in ':*?"<>|' for c in part)
                or stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
                or (stem.startswith(("COM", "LPT")) and stem[3:] in "123456789¹²³"
                    and len(stem) == 4)):
            return True
    return False


def _prefixes(path):
    parts = []
    parent, name = os.path.split(path)
    while name:
        parts.append(path)
        path = parent
        parent, name = os.path.split(path)
    yield path
    yield from reversed(parts)


def windows_realpath(path):
    """Canonicalize a path after rejecting links in its existing prefixes."""
    if _unsafe_windows_path(path):
        raise OSError(errno.EINVAL, "invalid Windows filesystem path")
    absolute = os.path.abspath(path)
    checked = []
    for prefix in _prefixes(absolute):
        try:
            info = os.lstat(prefix)
        except FileNotFoundError:
            if not checked:
                raise
            break
        if is_link(info):
            raise OSError(errno.ELOOP, "symlink or reparse point refused")
        checked.append((prefix, info))

    existing = checked[-1][0]
    canonical = os.path.realpath(existing, strict=True)
    if os.path.normcase(canonical) != os.path.normcase(existing):
        # An alternate spelling must identify the same entries along the entire chain.
        resolved = tuple(_prefixes(canonical))
        if len(resolved) != len(checked):
            raise OSError(errno.ELOOP, "filesystem entry was redirected")
        for (_, info), prefix in zip(checked, resolved):
            actual = os.lstat(prefix)
            if is_link(actual) or not os.path.samestat(info, actual):
                raise OSError(errno.ELOOP, "filesystem entry was redirected")
    if existing != absolute:
        return os.path.join(canonical, os.path.relpath(absolute, existing))
    return canonical


def _assert_canonical(path):
    if (is_link(os.lstat(path))
            or os.path.normcase(os.path.realpath(path, strict=True)) != os.path.normcase(path)):
        raise OSError(errno.ELOOP, "filesystem entry is not canonical")


@contextmanager
def _pin_windows(path, directory):
    info = os.lstat(path)
    if is_link(info):
        raise OSError(errno.ELOOP, "symlink or reparse point refused")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise OSError(errno.ENOTDIR if directory else errno.EINVAL,
                      "unexpected filesystem entry type")
    with _open_windows_handle(path, directory) as fd:
        _assert_canonical(path)
        if not directory and not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError(errno.EINVAL, "not a regular file")
        yield fd


class _WindowsDirectory:
    def __init__(self, path):
        self.path = path

    def entry(self, name):
        if (name in ("", ".", "..") or os.path.basename(name) != name
                or _unsafe_windows_path(name)):
            raise OSError(errno.EINVAL, "invalid filesystem entry name")
        return os.path.join(self.path, name)

    def names(self):
        return os.listdir(self.path)

    def stat(self, name):
        return os.lstat(self.entry(name))

    def open_file(self, name):
        with _pin_windows(self.entry(name), False) as fd:
            return os.dup(fd)

    @contextmanager
    def subdir(self, name):
        path = self.entry(name)
        with _pin_windows(path, True):
            yield _WindowsDirectory(path)


class _PosixDirectory:
    def __init__(self, fd):
        self.fd = fd

    def names(self):
        return os.listdir(self.fd)

    def stat(self, name):
        return os.stat(name, dir_fd=self.fd, follow_symlinks=False)

    def open_file(self, name):
        return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                       dir_fd=self.fd)

    @contextmanager
    def subdir(self, name):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=self.fd)
        try:
            yield _PosixDirectory(fd)
        finally:
            _close_directory(fd)


def _close_directory(fd):
    try:
        os.close(fd)
    except OSError:
        pass


@contextmanager
def windows_directory(path, *, create=None):
    """Keep every ancestor pinned while an absolute pathname is in use."""
    if _unsafe_windows_path(path) or not os.path.isabs(path):
        raise OSError(errno.EINVAL, "invalid absolute directory path")
    with ExitStack() as stack:
        for prefix in _prefixes(path):
            try:
                stack.enter_context(_pin_windows(prefix, True))
            except FileNotFoundError:
                if create is None or os.path.dirname(prefix) == prefix:
                    raise
                try:
                    create(prefix)
                except FileExistsError:
                    pass
                stack.enter_context(_pin_windows(prefix, True))
        yield _WindowsDirectory(path)


@contextmanager
def confined_directory(resolved, roots):
    if os.name == "nt":
        if not any(_within(resolved, root) for root in roots.roots):
            raise OSError(errno.ELOOP, "directory outside allowed roots")
        with windows_directory(resolved) as directory:
            yield directory
    else:
        fd = open_dir_confined(resolved, roots)
        try:
            yield _PosixDirectory(fd)
        finally:
            _close_directory(fd)
