"""M1/A1: fake deadlines and real process contention, guarded against blocking."""
import errno
import inspect
import multiprocessing
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.room import _lock, store
from bridge.tests.room.u121.support import BEAT, RoomCase, memory


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, delay):
        assert 0 < delay <= 0.005, "backoff must be positive and bounded by 5 ms"
        self.sleeps.append(delay)
        self.now += delay
        assert len(self.sleeps) <= 250, "retry exceeded bounded fake deadline"


def hold_lock(path, pipe):
    fd = os.open(path, os.O_RDWR)
    try:
        if _lock._posix:
            _lock._backend.flock(fd, _lock._backend.LOCK_EX)
        else:
            _lock._backend.locking(fd, _lock._backend.LK_LOCK, 1)
        pipe.send("held")
        pipe.recv()
    finally:
        os.close(fd)
        pipe.close()


def fd_count():
    """Count open descriptors without assuming a Linux procfs mount."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        current = kernel.GetCurrentProcess
        current.argtypes = ()
        current.restype = wintypes.HANDLE
        count_handles = kernel.GetProcessHandleCount
        count_handles.argtypes = (wintypes.HANDLE, wintypes.LPDWORD)
        count_handles.restype = wintypes.BOOL
        count = wintypes.DWORD()
        if not count_handles(current(), ctypes.byref(count)):
            raise ctypes.WinError(ctypes.get_last_error())
        return count.value
    for probe in (Path(os.sep) / "proc" / "self" / "fd",
                  Path(os.sep) / "dev" / "fd"):
        try:
            return len(os.listdir(probe))
        except OSError:
            continue
    # Last resort on systems without descriptor directory mounts: probe each
    # descriptor up to the soft limit with fstat.
    import resource
    soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    ceiling = min(soft if soft != resource.RLIM_INFINITY else 4096, 4096)
    total = 0
    for fd in range(ceiling):
        try:
            os.fstat(fd)
        except OSError:
            continue
        total += 1
    return total


class LockTests(RoomCase):
    def fake_lock(self, *, windows=False, errors=(), contention=None, timeout=None):
        clock = FakeClock()
        calls = []
        sequence = iter(errors)
        backend = SimpleNamespace(LOCK_EX=2, LOCK_NB=4, LOCK_UN=8,
                                  LK_LOCK=1, LK_NBLCK=2, LK_UNLCK=0)
        def attempt(fd, mode, *width):
            calls.append((mode, width))
            expected = backend.LK_NBLCK if windows else backend.LOCK_EX | backend.LOCK_NB
            self.assertEqual(mode, expected, "blocking lock flag used")
            if windows:
                self.assertEqual(width, (1,), "Windows must lock exactly one byte")
            try:
                exc = next(sequence)
            except StopIteration:
                exc = contention
            if exc:
                raise exc
        backend.flock = backend.locking = attempt
        fd = os.open(self.path.with_name("events.lock"), os.O_RDWR)
        try:
            os.lseek(fd, 7, os.SEEK_SET)
            with patch.object(_lock, "_backend", backend), patch.object(_lock, "_posix", not windows), \
                 patch.object(_lock.time, "monotonic", side_effect=clock.monotonic), \
                 patch.object(_lock.time, "sleep", side_effect=clock.sleep):
                caught = None
                try:
                    if timeout is None:
                        _lock.lock_exclusive(fd)
                    else:
                        self.assertIn("timeout_s", inspect.signature(_lock.lock_exclusive).parameters)
                        _lock.lock_exclusive(fd, timeout_s=timeout)
                except (OSError, TimeoutError) as exc:
                    caught = exc
            self.assertEqual(os.lseek(fd, 0, os.SEEK_CUR), 7, "lock changed caller file position")
            return clock, calls, caught
        finally:
            os.close(fd)

    def test_m1_timeout_constant_and_optional_parameter(self):
        self.assertEqual(getattr(_lock, "LOCK_TIMEOUT_S", None), 1.0)
        param = inspect.signature(_lock.lock_exclusive).parameters.get("timeout_s")
        self.assertIsNotNone(param, "timeout_s is absent")
        self.assertEqual(param.default, 1.0)

    def test_a1_posix_nonblocking_interruptions_then_success(self):
        clock, calls, caught = self.fake_lock(errors=[InterruptedError(errno.EINTR, "interrupt"),
                                        BlockingIOError(errno.EAGAIN, "busy"),
                                        BlockingIOError(errno.EWOULDBLOCK, "busy")])
        self.assertIsNone(caught)
        self.assertEqual(len(calls), 4)
        self.assertLessEqual(clock.now, 1.0)

    def test_a1_windows_nonblocking_permission_and_interruptions(self):
        clock, calls, caught = self.fake_lock(windows=True, errors=[PermissionError(errno.EACCES, "busy"),
                                                 InterruptedError(errno.EINTR, "interrupt")])
        self.assertIsNone(caught)
        self.assertEqual(len(calls), 3)
        self.assertLessEqual(clock.now, 1.0)

    def test_a1_posix_deadline_expires(self):
        clock, calls, caught = self.fake_lock(contention=BlockingIOError(errno.EAGAIN, "busy"))
        self.assertIsInstance(caught, TimeoutError)
        self.assertAlmostEqual(clock.now, 1.0)
        self.assertGreater(len(calls), 1)

    def test_a1_windows_deadline_expires(self):
        clock, _, caught = self.fake_lock(windows=True, contention=PermissionError(errno.EACCES, "busy"))
        self.assertIsInstance(caught, TimeoutError)
        self.assertAlmostEqual(clock.now, 1.0)

    def test_a1_remaining_time_bounds_final_sleep(self):
        clock, _, caught = self.fake_lock(contention=BlockingIOError(errno.EAGAIN, "busy"), timeout=0.012)
        self.assertIsInstance(caught, TimeoutError)
        self.assertAlmostEqual(clock.now, 0.012)
        self.assertAlmostEqual(clock.sleeps[-1], 0.002)

    def test_a1_unrelated_os_error_is_not_retried(self):
        clock, calls, caught = self.fake_lock(errors=[OSError(errno.EIO, "device failure")])
        self.assertIsInstance(caught, OSError)
        self.assertNotIsInstance(caught, TimeoutError)
        self.assertEqual(len(calls), 1)
        self.assertEqual(clock.sleeps, [])

    def test_a1_windows_unrelated_os_error_is_not_retried(self):
        clock, calls, caught = self.fake_lock(windows=True, errors=[OSError(errno.EIO, "device failure")])
        self.assertIsInstance(caught, OSError)
        self.assertNotIsInstance(caught, TimeoutError)
        self.assertEqual(len(calls), 1)
        self.assertEqual(clock.sleeps, [])

    def test_a1_repeated_interruptions_are_deadline_bounded(self):
        clock, _, caught = self.fake_lock(contention=InterruptedError(errno.EINTR, "interrupt"))
        self.assertIsInstance(caught, TimeoutError)
        self.assertAlmostEqual(clock.now, 1.0)

    def store_acquisition_failure(self, batch, failure):
        before = self.snapshot()
        initial_fds = fd_count()
        caught = None
        with patch.object(_lock, "lock_exclusive", side_effect=failure), \
             patch.object(_lock, "unlock") as unlock:
            try:
                self.batch([memory()]) if batch else self.post(BEAT)
            except Exception as exc:
                caught = exc
        # These checks run even if baseline leaks a raw TimeoutError/OSError.
        self.assertEqual(fd_count(), initial_fds, "lock acquisition leaked descriptors")
        unlock.assert_not_called()
        self.assertEqual(self.snapshot(), before)
        self.assertIsInstance(caught, store.RoomError, "lock failure escaped without internal translation")
        self.assertEqual(caught.code, "internal")
        if isinstance(failure, TimeoutError):
            self.assertIn("room lock timeout", str(caught))
        self.batch([memory()]) if batch else self.post(BEAT)

    def real_process_contention(self, batch):
        context = multiprocessing.get_context("fork" if _lock._posix else "spawn")
        parent, child = context.Pipe()
        process = context.Process(target=hold_lock, args=(str(self.path.with_name("events.lock")), child))
        process.start()
        child.close()
        try:
            self.assertTrue(parent.poll(5), "holder failed readiness precondition")
            self.assertEqual(parent.recv(), "held")
            backend = _lock._backend
            method = "flock" if _lock._posix else "locking"
            real_lock = getattr(backend, method)
            clock = FakeClock()

            def guarded(fd, flags, *width):
                if _lock._posix:
                    self.assertTrue(flags & backend.LOCK_NB, "blocking lock flag used under contention")
                else:
                    self.assertEqual((flags, width), (backend.LK_NBLCK, (1,)),
                                     "Windows lock must be nonblocking and one byte wide")
                return real_lock(fd, flags, *width)

            with patch.object(backend, method, side_effect=guarded), \
                 patch.object(_lock.time, "monotonic", side_effect=clock.monotonic), \
                 patch.object(_lock.time, "sleep", side_effect=clock.sleep):
                self.refuse(lambda: self.batch([memory()]) if batch else self.post(BEAT),
                            "internal", "room lock timeout")
            self.assertAlmostEqual(clock.now, 1.0)
        finally:
            parent.send("release")
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
            parent.close()
        self.assertEqual(process.exitcode, 0)
        self.batch([memory()]) if batch else self.post(BEAT)

    def test_a1_real_process_single(self):
        self.real_process_contention(False)

    def test_a1_real_process_batch(self):
        self.real_process_contention(True)


for is_batch in (False, True):
    for label, failure in (("timeout", TimeoutError("expired")), ("os_error", OSError(errno.EIO, "device failure"))):
        def test(self, batch=is_batch, exc=failure):
            self.store_acquisition_failure(batch, exc)
        setattr(LockTests, "test_a1_" + ("batch_" if is_batch else "single_") + label + "_fd_cleanup", test)
