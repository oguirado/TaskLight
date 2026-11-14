import errno
import os
import stat  # noqa: F401  (kept for parity with callers)


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

    Handles root == "/" where the naive prefix would be "//".
    """
    if root == os.sep:
        return child.startswith(os.sep)
    return child == root or child.startswith(root + os.sep)


class Roots:
    def __init__(self, roots: tuple[str, ...]) -> None:
        self.roots = tuple(os.path.realpath(r) for r in roots)

    def resolve(self, p: str) -> str | None:
        if not isinstance(p, str) or p == "":
            return None
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
