"""Frozen fixture-domain full reader; deterministic clocks and observable work.

The reference never invokes a production reader, projector, or validator. Its
fixture domain is heartbeat, the four message acts, and memory.set operations.
Unsupported fixture schemas stop the reference instead of silently guessing.
"""
import builtins
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import sys
import socket
import tempfile
import time
import unittest
from unittest import mock

from bridge.room import store
from bridge.room.ext import events as extension


# A-FLK1: Preserve real sleeps only for direct stdlib wait callers. Product
# sleeps still fail, including product callbacks reached through stdlib frames.
_REAL_SLEEP = time.sleep


def _sleep_guard(message="real sleep forbidden"):
    def guarded_sleep(delay):
        caller_globals = sys._getframe(1).f_globals
        if any(caller_globals is vars(sys.modules[name])
               for name in ("subprocess", "threading", "selectors")
               if name in sys.modules):
            return _REAL_SLEEP(delay)
        raise AssertionError(message)
    return guarded_sleep


HERE = Path(__file__).resolve().parent
FIELDS = ('id', 'room', 'agent', 'act', 'text', 'ts', 'lamport', 'op', 'to', 're')
REQUIRED = FIELDS[:7]


def event(n, *, room='demo', agent='worker-a', act='heartbeat', text='literal', **extra):
    return dict(id='e-%016x' % n, room=room, agent=agent, act=act,
                text=text, ts=1700000000000 + n, lamport=n, **extra)


def fixture():
    return [event(1), event(2, act='op', text='', op={
        'kind': 'memory.set', 'section': 'notes', 'text': 'literal memory',
        'base_rev': 0, 'op_id': 'memory_02'}),
        event(3, agent='harness', act='question', to='exec-a'),
        event(4, agent='exec-a', act='ack', to='harness', re='e-0000000000000003')]


def encoded(items):
    return b''.join(json.dumps(e, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                    + b'\n' for e in items)


def project(items):
    return [{k: copy.deepcopy(e[k]) for k in FIELDS if k in e} for e in items]


def accepted(e):
    """Snapshot of the cited store acceptance rules for the fixture domain."""
    if not isinstance(e, dict):
        return False
    if not isinstance(e.get('id'), str) or not re.fullmatch(r'e-[0-9a-f]{16}', e['id']):
        return False
    if any(type(e.get(k)) is not int for k in ('lamport', 'ts')):
        return False
    for key, pattern in (('room', r'[a-z0-9][a-z0-9-]{0,47}'),
                         ('agent', r'[a-z0-9][a-z0-9._-]{0,47}')):
        if not isinstance(e.get(key), str) or not re.fullmatch(pattern, e[key]):
            return False
    act = e.get('act')
    acts = {'open', 'plan', 'step', 'question', 'answer', 'handoff', 'ack',
            'heartbeat', 'verdict', 'close', 'op'}
    if not isinstance(act, str) or act not in acts or not isinstance(e.get('text'), str):
        return False
    try:
        if len(e['text'].encode('utf-8')) > 4096:
            return False
    except UnicodeError:
        return False
    if 're' in e and e['re'] is not None and not isinstance(e['re'], str):
        return False
    if 'to' in e and e['to'] is not None:
        if not isinstance(e['to'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,47}', e['to']):
            return False
    evidence = e.get('evidence')
    if evidence is not None:
        if not isinstance(evidence, list) or len(evidence) > 8:
            return False
        if any(not isinstance(x, dict) or not isinstance(x.get('path'), str)
               or not isinstance(x.get('sha256'), str) for x in evidence):
            return False
    if act != 'op' and 'op' in e:
        return False
    if act == 'op':
        op = e.get('op')
        if not isinstance(op, dict) or 'plan' in e or 'step' in e:
            return False
        if abs(e['lamport']) > 9007199254740991 or abs(e['ts']) > 8640000000000000:
            return False
        # This independent oracle deliberately stops on unexercised op schemas.
        if op.get('kind') != 'memory.set':
            raise AssertionError('extend frozen reference before adding another op schema')
        if op != fixture()[1]['op']:
            raise AssertionError('extend frozen reference before changing the operation fixture')
    if act in ('plan', 'step'):
        raise AssertionError('plan/step fixtures belong to their existing validation suites')
    if 'plan' in e or 'step' in e:
        return False
    return act not in ('answer', 'ack') or 're' in e


def full_read(data, room='demo', after_lamport=0, limit=100, acts=None, ops=None):
    """Independent complete-byte scan: no production reads, caches or helpers."""
    items = []
    for raw in data.split(b'\n')[:-1]:
        if not raw.strip():
            continue
        try:
            e = json.loads(raw.decode('utf-8'))
        except (UnicodeError, ValueError):
            continue
        if accepted(e) and e['room'] == room:
            items.append(e)
    head = max((e['lamport'] for e in items), default=0)
    if after_lamport > head:
        return result([], head, head, resync=True)
    selected = [e for e in sorted(items, key=lambda e: e['lamport'])
                if e['lamport'] > after_lamport
                and (acts is None or e['act'] in acts)
                and (ops is None or isinstance(e.get('op'), dict) and e['op'].get('kind') in ops)]
    page = selected[:limit]
    more = len(selected) > len(page)
    return result(project(page), page[-1]['lamport'] if more else head, head, more)


def result(events, next_after, head, has_more=False, resync=False):
    return dict(events=events, next_after=next_after, head=head, has_more=has_more, resync=resync)


def footprint(home):
    if not home.exists():
        return None
    return {str(p.relative_to(home)): (p.stat().st_mode, p.stat().st_ino,
            p.stat().st_mtime_ns, p.read_bytes() if p.is_file() else None)
            for p in [home, *sorted(home.rglob('*'))]}


@contextlib.contextmanager
def bound_replacements(pairs):
    """Also patch already-bound imports; helper names are not an implementation contract."""
    aliases = [(m, name, replacement)
               for key, m in list(sys.modules.items()) if m is not None and key.startswith('bridge.room')
               for name, value in list(vars(m).items())
               for original, replacement in pairs if value is original]
    with contextlib.ExitStack() as stack:
        for m, name, replacement in aliases:
            stack.enter_context(mock.patch.object(m, name, replacement))
        yield


class Clock:
    def __init__(self, on_sleep=None):
        self.now = 0.0
        self.sleeps = []
        self.calls = 0
        self.on_sleep = on_sleep

    def monotonic(self):
        self.calls += 1
        if self.calls > 2000:
            raise AssertionError('wait did not terminate under a bounded fake clock')
        return self.now

    def sleep(self, delay):
        if not 0 < delay <= 30 or len(self.sleeps) >= 1000:
            raise AssertionError('invalid or unbounded fake-clock sleep')
        self.sleeps.append(delay)
        self.now = round(self.now + delay, 12)
        if self.on_sleep:
            self.on_sleep(len(self.sleeps))


@contextlib.contextmanager
def fake_time(clock):
    with bound_replacements([(time.monotonic, clock.monotonic), (time.sleep, clock.sleep)]), \
         mock.patch.object(time, 'monotonic', clock.monotonic), \
         mock.patch.object(time, 'sleep', clock.sleep), \
         mock.patch.object(time, 'time', side_effect=AssertionError('deadline must use monotonic time')):
        yield clock


class _FileProbe:
    def __init__(self, stream, meter):
        self.stream, self.meter = stream, meter

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def __enter__(self):
        self.stream.__enter__()
        return self

    def __exit__(self, *args):
        return self.stream.__exit__(*args)

    def __iter__(self):
        return self

    def __next__(self):
        value = self.readline()
        if not value:
            raise StopIteration
        return value

    def read(self, *args):
        return self.meter.add(self.stream.read(*args))

    def read1(self, *args):
        return self.meter.add(self.stream.read1(*args))

    def readinto1(self, buffer):
        n = self.stream.readinto1(buffer)
        self.meter.bytes_read += n or 0
        return n

    def readline(self, *args):
        return self.meter.add(self.stream.readline(*args))

    def readlines(self, *args):
        values = self.stream.readlines(*args)
        for value in values:
            self.meter.add(value)
        return values

    def readinto(self, buffer):
        n = self.stream.readinto(buffer)
        self.meter.bytes_read += n or 0
        return n


class WorkMeter:
    """Actual UTF-8/JSON attempts and validation, including outside _read_all.

    Count each stage separately, then take their maximum to avoid double-counting
    one record. Invalid UTF-8 attempts count even when JSON is never invoked.
    I/O covers builtin/io opens (including Path), os.read and os.pread.
    """
    def __init__(self, path, on_decode=None):
        self.path = Path(path).resolve()
        self.bytes_read = self.utf8 = self.json = self.validations = 0
        self.on_decode = on_decode
        self.busy = False

    @property
    def records(self):
        return max(self.utf8, self.json, self.validations)

    def snapshot(self):
        return self.bytes_read, self.records

    def add(self, data):
        self.bytes_read += len(data.encode('utf-8') if isinstance(data, str) else data)
        return data

    def tracks(self, path):
        if isinstance(path, int):
            try:
                a, b = os.fstat(path), self.path.stat()
                return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
            except OSError:
                return False
        try:
            return Path(os.fsdecode(path)).resolve() == self.path
        except (TypeError, ValueError):
            return False

    def profile(self, frame, kind, value):
        if self.busy:
            return
        if kind == 'call' and frame.f_code is json.JSONDecoder.raw_decode.__code__:
            self.json += 1
        if kind == 'call' and frame.f_code is self.validation_code:
            self.validations += 1
        if kind == 'c_call' and getattr(value, '__name__', '') == 'decode':
            raw = getattr(value, '__self__', None)
            if (isinstance(raw, bytes) and raw.strip()
                    and frame.f_globals.get('__name__', '') != 'os'):
                self.utf8 += max(1, sum(bool(x.strip()) for x in raw.split(b'\n')))
                if self.on_decode:
                    self.busy = True
                    try:
                        self.on_decode(self.utf8)
                    finally:
                        self.busy = False

    def __enter__(self):
        self.stack = contextlib.ExitStack()
        self.validation_code = getattr(getattr(store, '_is_valid_event', None), '__code__', None)
        replacements = []
        for module, attr in ((builtins, 'open'), (io, 'open')):
            original = getattr(module, attr)
            def opened(path, *args, _original=original, **kwargs):
                stream = _original(path, *args, **kwargs)
                return _FileProbe(stream, self) if self.tracks(path) else stream
            replacements.append((original, opened))
            self.stack.enter_context(mock.patch.object(module, attr, opened))
        for attr in ('read', 'pread'):
            if not hasattr(os, attr):
                continue
            original = getattr(os, attr)
            def fetched(fd, *args, _original=original):
                value = _original(fd, *args)
                return self.add(value) if self.tracks(fd) else value
            replacements.append((original, fetched))
            self.stack.enter_context(mock.patch.object(os, attr, fetched))
        self.stack.enter_context(bound_replacements(replacements))
        self.previous_profile = sys.getprofile()
        sys.setprofile(self.profile)
        return self

    def __exit__(self, *args):
        sys.setprofile(self.previous_profile)
        self.stack.close()


class OracleCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fixture-', dir=HERE)
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'home'
        self.path = self.home / 'rooms/demo/events.jsonl'
        self.events = fixture()
        patch = mock.patch.dict(os.environ, {'CW_HOME': str(self.home)})
        patch.start()
        self.addCleanup(patch.stop)
        ids = iter('%016x' % n for n in range(1, 10001))
        for p in (mock.patch.object(store.secrets, 'token_hex', side_effect=lambda _: next(ids)),
                  mock.patch.object(time, 'time', return_value=1700000000.0),
                  mock.patch.object(time, 'monotonic', side_effect=Clock().monotonic),
                  mock.patch.object(time, 'sleep', new=_sleep_guard()),
                  mock.patch.object(store._lock.time, 'monotonic', return_value=0.0),
                  mock.patch.object(store._lock.time, 'sleep', new=_sleep_guard("real lock sleep forbidden")),
                  mock.patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')),
                  mock.patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden'))):
            p.start()
            self.addCleanup(p.stop)

    def seed(self, items=None, raw=None, path=None):
        target = path or self.path
        target.parent.mkdir(parents=True, exist_ok=True)
        data = raw if raw is not None else encoded(self.events if items is None else items)
        self.assertLess(len(data), store.CAP, 'fixture must remain below the journal cap')  # A-C4m: 16 MiB cap
        target.write_bytes(data)
        return target.read_bytes()

    def append(self, data):
        with self.path.open('ab') as f:
            f.write(data)

    def request(self, **kwargs):
        args = dict(room='demo', agent='reader', after_lamport=0)
        args.update(kwargs)
        return extension.handler(args)

    def check_oracle(self, **kwargs):
        path = self.home / 'rooms' / kwargs.get('room', 'demo') / 'events.jsonl'
        data = path.read_bytes() if path.exists() else b''
        expected = full_read(data, **{k: v for k, v in kwargs.items()
                                    if k in ('room', 'after_lamport', 'limit', 'acts', 'ops')})
        actual = self.request(**kwargs)
        self.assertEqual(actual, expected)
        return actual
