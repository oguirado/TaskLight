"""Portable locking contract tests; fake backends run in fresh interpreters."""
import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[4]

# Import all test machinery before injecting msvcrt: subprocess itself probes it.
PRELUDE = """
import errno, importlib, json, os, sys, tempfile, time, types
from pathlib import Path
from unittest import mock
calls = []
attempts = []
template = json.loads(Path('fixtures/plan/templates.v1.json').read_text())['templates'][0]
opening = dict(kind='plan.open', template_id=template['id'], template_hash=template['hash'],
               title='Oracle plan', brief={'goal': 'Deliver'}, phase='start')
templates = {template['id']: template}
fcntl = types.ModuleType("fcntl")
fcntl.LOCK_EX, fcntl.LOCK_UN = 2, 8
fcntl.flock = lambda fd, mode: calls.append((fd, mode))
msvcrt = types.ModuleType("msvcrt")
msvcrt.LK_LOCK, msvcrt.LK_UNLCK = 1, 0
msvcrt.locking = lambda fd, mode, count: calls.append(
    (fd, mode, count, os.lseek(fd, 0, os.SEEK_CUR)))
"""
POSIX = """
sys.modules['fcntl'] = fcntl
sys.modules['msvcrt'] = msvcrt
from bridge.room import _lock
acquire = mock.patch.object(_lock, 'lock_exclusive', wraps=_lock.lock_exclusive).start()
release_adapter = mock.patch.object(_lock, 'unlock', wraps=_lock.unlock).start()
"""
WINDOWS = """
sys.modules['fcntl'] = None
sys.modules['msvcrt'] = msvcrt
from bridge.room import _lock
"""


class LockOracle(unittest.TestCase):
    def run_code(self, code):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('PYTHON', 'CW_'))}
        result = subprocess.run(
            [sys.executable, '-B', '-c', PRELUDE + textwrap.dedent(code)],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_m1_posix_exclusive_and_unlock(self):
        self.run_code(POSIX + """
with tempfile.TemporaryFile() as f:
    f.write(b'abcdef')
    f.seek(3)
    _lock.lock_exclusive(f.fileno())
    _lock.unlock(f.fileno())
    assert calls == [(f.fileno(), fcntl.LOCK_EX), (f.fileno(), fcntl.LOCK_UN)], calls
    assert f.tell() == 3
""")

    def test_m1_importlib_prefers_fcntl(self):
        self.run_code("""
sys.modules['fcntl'] = fcntl
sys.modules['msvcrt'] = msvcrt
real_import = importlib.import_module
def tracked(name, *args, **kwargs):
    attempts.append(name)
    return real_import(name, *args, **kwargs)
with mock.patch.object(importlib, 'import_module', side_effect=tracked):
    from bridge.room import _lock
with tempfile.TemporaryFile() as f:
    _lock.lock_exclusive(f.fileno())
    _lock.unlock(f.fileno())
assert 'fcntl' in attempts, attempts
assert 'msvcrt' not in attempts, attempts
assert [c[1] for c in calls] == [2, 8], calls
""")

    def test_m1_posix_errors_propagate(self):
        self.run_code(POSIX + """
failure = OSError(errno.EBADF, 'invalid descriptor')
def fail(*args):
    raise failure
fcntl.flock = fail
for operation in (_lock.lock_exclusive, _lock.unlock):
    try:
        operation(-1)
    except OSError as exc:
        assert exc is failure
    else:
        raise AssertionError('lock error swallowed')
""")

    def test_m1_windows_byte_zero_and_position(self):
        self.run_code(WINDOWS + """
with tempfile.TemporaryFile() as f:
    f.write(b'abcdef')
    f.seek(4)
    _lock.lock_exclusive(f.fileno())
    assert f.tell() == 4
    f.seek(2)
    _lock.unlock(f.fileno())
    assert f.tell() == 2
    assert calls == [(f.fileno(), 1, 1, 0), (f.fileno(), 0, 1, 0)], calls
""")

    def test_m1_windows_empty_lockfile(self):
        self.run_code(WINDOWS + """
with tempfile.TemporaryFile() as f:
    _lock.lock_exclusive(f.fileno())
    _lock.unlock(f.fileno())
    assert f.tell() == 0
    assert calls == [(f.fileno(), 1, 1, 0), (f.fileno(), 0, 1, 0)], calls
""")

    def test_m1_windows_retries_contention_without_waiting(self):
        self.run_code(WINDOWS + """
def contended(fd, mode, count):
    calls.append((fd, mode, count, os.lseek(fd, 0, os.SEEK_CUR)))
    if mode == msvcrt.LK_LOCK and len(calls) < 4:
        raise OSError(errno.EACCES, 'lock busy')
msvcrt.locking = contended
with mock.patch.object(time, 'sleep', return_value=None):
    with tempfile.TemporaryFile() as f:
        f.write(b'abcdef')
        f.seek(5)
        _lock.lock_exclusive(f.fileno())
        assert f.tell() == 5
        _lock.unlock(f.fileno())
        assert f.tell() == 5
        assert calls == [(f.fileno(), 1, 1, 0)] * 4 + [(f.fileno(), 0, 1, 0)], calls
""")

    def test_m1_windows_unlock_error_restores_position(self):
        self.run_code(WINDOWS + """
failure = OSError(errno.EBADF, 'unlock failed')
def fail(fd, mode, count):
    assert (mode, count, os.lseek(fd, 0, os.SEEK_CUR)) == (0, 1, 0)
    raise failure
msvcrt.locking = fail
with tempfile.TemporaryFile() as f:
    f.write(b'abcdef')
    f.seek(3)
    try:
        _lock.unlock(f.fileno())
    except OSError as exc:
        assert exc is failure
    else:
        raise AssertionError('unlock error swallowed')
    assert f.tell() == 3
""")

    def test_a1_windows_store_post(self):
        self.run_code(WINDOWS + """
from bridge.room import store
with tempfile.TemporaryDirectory() as home:
    event = store.post('oracle', 'alice', 'heartbeat', 'hello', home=home, clock=lambda: 1234)
    events, malformed = store.read('oracle', home=home)
    assert events == [event] and malformed == 0
assert len(calls) == 2, calls
assert calls[0][1:] == (1, 1, 0) and calls[1][1:] == (0, 1, 0), calls
assert calls[0][0] == calls[1][0]
""")

    def test_a2_no_backend_fails_closed(self):
        self.run_code("""
sys.modules['fcntl'] = None
sys.modules['msvcrt'] = None
try:
    importlib.import_module('bridge.room._lock')
except ImportError as exc:
    message = str(exc).lower()
    assert 'lock' in message and ('backend' in message or ('fcntl' in message and 'msvcrt' in message)), message
else:
    raise AssertionError('missing locking backends must prevent import')
""")

    @unittest.skipUnless(sys.platform.startswith('linux'), 'A3 requires Linux')
    def test_a3_two_process_posts(self):
        # Probe the required real adapter before the process-level contract.
        from bridge.room import _lock, store
        with tempfile.TemporaryFile() as f:
            _lock.lock_exclusive(f.fileno())
            _lock.unlock(f.fileno())
        script = """
import sys
from bridge.room import store
sys.stdin.buffer.read(1)
for i in range(50):
    store.post('oracle', sys.argv[2], 'heartbeat', str(i), home=sys.argv[1], clock=lambda: 1234)
"""
        with tempfile.TemporaryDirectory() as home:
            children = []
            try:
                for agent in ('alice', 'bob'):
                    children.append(subprocess.Popen(
                        [sys.executable, '-B', '-c', script, home, agent], cwd=ROOT,
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
                for child in children:
                    child.stdin.write(b'x')
                    child.stdin.flush()
                for child in children:
                    out, err = child.communicate(timeout=20)
                    self.assertEqual(child.returncode, 0, (out + err).decode())
                events, malformed = store.read('oracle', home=home)
                self.assertEqual(malformed, 0)
                self.assertEqual(len(events), 100)
                self.assertEqual(len({e['id'] for e in events}), 100)
                lamports = [e['lamport'] for e in events]
                self.assertTrue(all(a < b for a, b in zip(lamports, lamports[1:])))
                self.assertEqual({a: sum(e['agent'] == a for e in events)
                                  for a in ('alice', 'bob')}, {'alice': 50, 'bob': 50})
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=5)

    def test_a4_store_has_no_fcntl_import(self):
        source = (ROOT / 'bridge/room/store.py').read_text(encoding='utf-8')
        forbidden = []
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                forbidden.extend(n.name for n in node.names if n.name == 'fcntl')
            elif isinstance(node, ast.ImportFrom) and node.module == 'fcntl':
                forbidden.append(node.module)
        self.assertEqual(forbidden, [], 'store must import the portable adapter')

    def test_m2_both_store_paths_lock_and_unlock(self):
        self.run_code(POSIX + """
from bridge.room import store
for batch in (False, True):
    calls.clear()
    acquire.reset_mock()
    release_adapter.reset_mock()
    with tempfile.TemporaryDirectory() as home:
        if batch:
            store.post_ops('oracle', 'alice', [opening], home=home, clock=lambda: 1234, templates=templates)
        else:
            store.post('oracle', 'alice', 'heartbeat', '', home=home, clock=lambda: 1234)
    assert [c[1] for c in calls] == [2, 8], calls
    assert acquire.call_count == release_adapter.call_count == 1
    assert calls[0][0] == calls[1][0]
""")

    def test_m2_acquisition_failure_never_writes_or_unlocks(self):
        self.run_code(POSIX + """
from bridge.room import store
failure = OSError(errno.EACCES, 'acquisition denied')
def fail(fd):
    calls.append(('acquire', fd))
    raise failure
with mock.patch.object(_lock, 'lock_exclusive', side_effect=fail), mock.patch.object(_lock, 'unlock') as release:
    for batch in (False, True):
        with tempfile.TemporaryDirectory() as home:
            try:
                if batch:
                    store.post_ops('oracle', 'alice', [opening], home=home, clock=lambda: 1234, templates=templates)
                else:
                    store.post('oracle', 'alice', 'heartbeat', '', home=home, clock=lambda: 1234)
            except OSError as exc:
                assert exc is failure
            else:
                raise AssertionError('acquisition failure swallowed')
            assert store.read('oracle', home=home)[0] == []
    release.assert_not_called()
assert len(calls) == 2, calls
for _, fd in calls:
    try:
        os.fstat(fd)
    except OSError as exc:
        assert exc.errno == errno.EBADF
    else:
        raise AssertionError('lock descriptor leaked')
""")

    def test_m2_critical_failure_releases_both_paths(self):
        self.run_code(POSIX + """
from bridge.room import store
failure = OSError(errno.EIO, 'critical-section failure')
for batch in (False, True):
    calls.clear()
    acquire.reset_mock()
    release_adapter.reset_mock()
    with tempfile.TemporaryDirectory() as home, mock.patch.object(os, 'fsync', side_effect=failure):
        try:
            if batch:
                store.post_ops('oracle', 'alice', [opening], home=home, clock=lambda: 1234, templates=templates)
            else:
                store.post('oracle', 'alice', 'heartbeat', '', home=home, clock=lambda: 1234)
        except store.RoomError as exc:
            assert exc.code == 'internal'
        else:
            raise AssertionError('critical failure swallowed')
        assert store.read('oracle', home=home)[0] == []
    assert [c[1] for c in calls] == [2, 8], calls
    assert acquire.call_count == release_adapter.call_count == 1
""")

    def test_m2_unlock_oserror_is_preserved(self):
        self.run_code(POSIX + """
from bridge.room import store
real_flock = fcntl.flock
def fail_unlock(fd, mode):
    real_flock(fd, mode)
    if mode == fcntl.LOCK_UN:
        raise OSError(errno.EIO, 'unlock failed')
fcntl.flock = fail_unlock
for batch in (False, True):
    calls.clear()
    acquire.reset_mock()
    release_adapter.reset_mock()
    with tempfile.TemporaryDirectory() as home:
        if batch:
            result = store.post_ops('oracle', 'alice', [opening], home=home, clock=lambda: 1234, templates=templates)
        else:
            result = store.post('oracle', 'alice', 'heartbeat', '', home=home, clock=lambda: 1234)
        assert result
        assert len(store.read('oracle', home=home)[0]) == 1
    assert [c[1] for c in calls] == [2, 8], calls
    assert acquire.call_count == release_adapter.call_count == 1
""")
