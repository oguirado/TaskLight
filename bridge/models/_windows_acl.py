"""Owner-only Windows filesystem permissions."""

from contextlib import contextmanager
import errno
import os


def available():
    return os.name == "nt"


class PrivatePermissions:
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes = ctypes
        self.types = wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.security = ctypes.WinDLL("advapi32", use_last_error=True)
        self.token_user = self._current_user()

    def _bind(self, library, name, result, *args):
        function = getattr(library, name)
        function.restype = result
        function.argtypes = args
        return function

    def _current_user(self):
        c, w = self.ctypes, self.types
        process = self._bind(self.kernel, "GetCurrentProcess", w.HANDLE)
        close = self._bind(self.kernel, "CloseHandle", w.BOOL, w.HANDLE)
        open_token = self._bind(self.security, "OpenProcessToken", w.BOOL,
                                w.HANDLE, w.DWORD, c.POINTER(w.HANDLE))
        get_token = self._bind(self.security, "GetTokenInformation", w.BOOL,
                               w.HANDLE, c.c_int, w.LPVOID, w.DWORD, c.POINTER(w.DWORD))
        token, size = w.HANDLE(), w.DWORD()
        if not open_token(process(), 8, c.byref(token)):  # TOKEN_QUERY
            self._refuse()
        try:
            get_token(token, 1, None, 0, c.byref(size))  # TokenUser
            if not size.value:
                self._refuse()
            user = c.create_string_buffer(size.value)
            if not get_token(token, 1, user, size, c.byref(size)):
                self._refuse()
            return user
        finally:
            close(token)

    def _user_sid(self):
        # TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first field is PSID.
        return self.ctypes.c_void_p.from_buffer(self.token_user)

    def _free(self, pointer):
        w = self.types
        self._bind(self.kernel, "LocalFree", w.HANDLE, w.HANDLE)(pointer)

    @staticmethod
    def _refuse():
        raise PermissionError(errno.EACCES, "cannot establish owner-only filesystem permissions")

    def verify_directory(self, path):
        self._verify(path, named=True)

    def verify_file(self, fd):
        import msvcrt

        self._verify(msvcrt.get_osfhandle(fd), named=False)

    def _verify(self, entry, *, named):
        c, w = self.ctypes, self.types
        pointer = c.POINTER(c.c_void_p)
        query = self._bind(self.security,
                           "GetNamedSecurityInfoW" if named else "GetSecurityInfo",
                           w.DWORD, w.LPCWSTR if named else w.HANDLE, c.c_int,
                           w.DWORD, pointer, pointer, pointer, pointer, pointer)
        equal_sid = self._bind(self.security, "EqualSid", w.BOOL, w.LPVOID, w.LPVOID)
        control = self._bind(self.security, "GetSecurityDescriptorControl", w.BOOL,
                             w.LPVOID, c.POINTER(w.WORD), c.POINTER(w.DWORD))
        get_ace = self._bind(self.security, "GetAce", w.BOOL, w.LPVOID, w.DWORD, pointer)

        class ACL(c.Structure):
            _fields_ = [("revision", w.BYTE), ("reserved", w.BYTE),
                        ("size", w.WORD), ("count", w.WORD), ("reserved2", w.WORD)]

        owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        # SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
        if query(entry, 1, 5, c.byref(owner), None, c.byref(dacl), None,
                 c.byref(descriptor)):
            self._refuse()
        try:
            flags, revision = w.WORD(), w.DWORD()
            user = self._user_sid()
            if (not owner or not dacl or not equal_sid(owner, user)
                    or not control(descriptor, c.byref(flags), c.byref(revision))
                    or not (flags.value & 0x1000)):  # SE_DACL_PROTECTED
                self._refuse()
            count = ACL.from_address(dacl.value).count
            for index in range(count):
                ace = c.c_void_p()
                if (not get_ace(dacl, index, c.byref(ace))
                        or c.c_ubyte.from_address(ace.value).value != 0
                        or not equal_sid(c.c_void_p(ace.value + 8), user)):
                    # Only ACCESS_ALLOWED_ACE entries for the owner are admitted.
                    self._refuse()
        finally:
            self._free(descriptor)

    @contextmanager
    def _creation_attributes(self):
        c, w = self.ctypes, self.types
        sid_string = self._bind(self.security, "ConvertSidToStringSidW", w.BOOL,
                                w.LPVOID, c.POINTER(w.LPWSTR))
        descriptor_from_string = self._bind(
            self.security, "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            w.BOOL, w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.POINTER(w.DWORD))

        class SecurityAttributes(c.Structure):
            _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p),
                        ("inherit", w.BOOL)]

        owner = w.LPWSTR()
        if not sid_string(self._user_sid(), c.byref(owner)):
            self._refuse()
        descriptor = c.c_void_p()
        try:
            sddl = "O:{sid}D:P(A;;FA;;;{sid})".format(sid=owner.value)
            if not descriptor_from_string(sddl, 1, c.byref(descriptor), None):
                self._refuse()
        finally:
            self._free(c.cast(owner, c.c_void_p))
        try:
            attributes = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor.value, False)
            yield c.byref(attributes)
        finally:
            self._free(descriptor)

    def create_directory(self, path):
        w = self.types
        create = self._bind(self.kernel, "CreateDirectoryW", w.BOOL, w.LPCWSTR, w.LPVOID)
        with self._creation_attributes() as attributes:
            if not create(path, attributes):
                self._creation_error()

    def create_file(self, path):
        import msvcrt

        c, w = self.ctypes, self.types
        create = self._bind(self.kernel, "CreateFileW", w.HANDLE, w.LPCWSTR,
                            w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE)
        with self._creation_attributes() as attributes:
            # GENERIC_WRITE, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | OPEN_REPARSE_POINT
            handle = create(path, 0x40000000, 0, attributes, 1, 0x00200080, None)
            if handle == c.c_void_p(-1).value:
                self._creation_error()
            try:
                return msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
            except BaseException:
                self._bind(self.kernel, "CloseHandle", w.BOOL, w.HANDLE)(handle)
                raise

    def _creation_error(self):
        if self.ctypes.get_last_error() in (80, 183):
            raise FileExistsError(errno.EEXIST, "filesystem entry already exists")
        self._refuse()
