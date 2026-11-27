"""Force the non-POSIX filesystem branch while running tests on POSIX."""

from contextlib import ExitStack, contextmanager
from importlib import import_module
import os
import stat
from types import SimpleNamespace
from unittest.mock import patch


class PrivatePermissionsOracle:
    def verify_directory(self, path):
        info = os.stat(path)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError

    def verify_file(self, fd):
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise PermissionError

    def create_directory(self, path):
        os.mkdir(path, 0o700)

    def create_file(self, path):
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)


@contextmanager
def windows_filesystem(reparse=None, *, alias=None):
    from bridge.ctx import paths

    open_file = os.open
    lstat = os.lstat

    def native_path(path):
        if alias is not None:
            alternate, canonical = map(os.fspath, alias)
            path = os.fspath(path)
            if path == alternate or path.startswith(alternate + os.sep):
                return canonical + path[len(alternate):]
        return path

    class WindowsPath:
        def __getattr__(self, name):
            return getattr(os.path, name)

        @staticmethod
        def realpath(path, **kwargs):
            return os.path.realpath(native_path(path), **kwargs)

    def stat_entry(path, *args, **kwargs):
        info = lstat(native_path(path), *args, **kwargs)
        if reparse is None or os.fspath(path) != os.fspath(reparse):
            return info
        return SimpleNamespace(st_mode=info.st_mode,
                               st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)

    @contextmanager
    def pin(path, directory):
        fd = open_file(native_path(path), os.O_RDONLY)
        try:
            yield fd
        finally:
            os.close(fd)

    hidden = {"getuid", "geteuid", "O_DIRECTORY", "O_NOFOLLOW",
              "O_NONBLOCK", "O_CLOEXEC"}

    def open_without_dir_fd(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is not None:
            raise NotImplementedError("dir_fd")
        return open_file(path, flags, mode)

    class WindowsOS:
        def __getattr__(self, name):
            if name in hidden:
                raise AttributeError(name)
            return getattr(os, name)

        name = "nt"
        path = WindowsPath()
        supports_dir_fd = frozenset()
        lstat = staticmethod(stat_entry)
        open = staticmethod(open_without_dir_fd)

    from bridge.models import _windows_acl, cli, store
    from bridge.room import family
    from bridge.room.ext import artifact, export

    with ExitStack() as stack:
        ctx_modules = tuple(import_module('bridge.ctx.' + name)
                            for name in ('census', 'find', 'state'))
        for module in (paths, *ctx_modules, cli, store, family, artifact, export):
            stack.enter_context(patch.object(module, "os", WindowsOS()))
        stack.enter_context(patch.object(paths, "_open_windows_handle", pin))
        stack.enter_context(patch.object(_windows_acl, "PrivatePermissions", PrivatePermissionsOracle))
        yield
