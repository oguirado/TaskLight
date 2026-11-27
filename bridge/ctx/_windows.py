"""Windows kernel operations for confined filesystem access."""

from contextlib import contextmanager
import errno
import os


def _kernel():
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    def bind(name, result, *args):
        function = getattr(kernel, name)
        function.restype = result
        function.argtypes = args
        return function

    return ctypes, wintypes, bind


def _last_error(ctypes):
    code = ctypes.get_last_error()
    if code in (2, 3):
        return FileNotFoundError(errno.ENOENT, "filesystem entry is missing")
    if code in (5, 32, 33):
        return PermissionError(errno.EACCES, "filesystem entry cannot be pinned")
    return OSError(errno.EIO, "Windows filesystem operation failed (error %d)" % code)


@contextmanager
def open_handle(path, directory):
    import msvcrt

    ctypes, types, bind = _kernel()
    create = bind("CreateFileW", types.HANDLE, types.LPCWSTR, types.DWORD,
                  types.DWORD, types.LPVOID, types.DWORD, types.DWORD, types.HANDLE)
    close = bind("CloseHandle", types.BOOL, types.HANDLE)
    drive_type = bind("GetDriveTypeW", types.UINT, types.LPCWSTR)
    attributes = bind("GetFileInformationByHandleEx", types.BOOL, types.HANDLE,
                      ctypes.c_int, types.LPVOID, types.DWORD)

    # The sharing checks used for pinning must be enforced by a local filesystem.
    if drive_type(os.path.splitdrive(path)[0] + os.sep) != 3:  # DRIVE_FIXED
        raise OSError(errno.ENOTSUP, "confinement requires a local fixed drive")

    access = 0x80 if directory else 0x80000000  # FILE_READ_ATTRIBUTES / GENERIC_READ
    sharing = 3  # FILE_SHARE_READ | FILE_SHARE_WRITE (no FILE_SHARE_DELETE)
    flags = 0x00200000 | 0x02000000  # OPEN_REPARSE_POINT | BACKUP_SEMANTICS
    handle = create(path, access, sharing, None, 3, flags, None)  # OPEN_EXISTING
    if handle == ctypes.c_void_p(-1).value:
        raise _last_error(ctypes)
    try:
        info = (types.DWORD * 2)()
        if not attributes(handle, 9, info, ctypes.sizeof(info)):  # FileAttributeTagInfo
            raise _last_error(ctypes)
        if info[0] & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
            raise OSError(errno.ELOOP, "reparse point refused")
        if bool(info[0] & 0x10) != directory:  # FILE_ATTRIBUTE_DIRECTORY
            raise OSError(errno.ENOTDIR if directory else errno.EISDIR,
                          "unexpected filesystem entry type")
        if directory:
            yield None
        else:
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            handle = None  # the file descriptor now owns the handle
            try:
                yield fd
            finally:
                os.close(fd)
    finally:
        if handle is not None:
            close(handle)
