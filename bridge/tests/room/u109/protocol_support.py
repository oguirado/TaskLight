"""Real adapter fixtures: fixed clocks/IDs, forbidden sockets/sleeps, scratch only."""
import copy
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack, contextmanager, redirect_stdout
from unittest.mock import patch
from bridge.room import app, mcp


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
ROOT = HERE.parents[3]
BASE = 1700000000000


def journal(home):
    p = Path(home) / 'rooms/demo/events.jsonl'
    return p.read_bytes() if p.exists() else b''


@contextmanager
def deterministic(home, request):
    ids = itertools.count()
    nonce = json.dumps(request, sort_keys=True) + ':' + str(len(journal(home).splitlines()))
    def token_hex(n):
        return hashlib.sha256((nonce + ':' + str(next(ids))).encode()).hexdigest()[:2*n]
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {'CW_HOME': str(home), 'PYTHONDONTWRITEBYTECODE': '1'}))
        stack.enter_context(patch.object(time, 'time', return_value=BASE / 1000))
        stack.enter_context(patch.object(time, 'sleep', new=_sleep_guard()))
        stack.enter_context(patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')))
        stack.enter_context(patch.object(secrets, 'token_hex', side_effect=token_hex))
        yield


def snapshot(home):
    with patch.dict(os.environ, {'CW_HOME': str(home)}):
        projection = app._fold('demo')
    raw = journal(home)
    events = [json.loads(line) for line in raw.splitlines()]
    head = max((e['lamport'] for e in events), default=0)
    return {'journal': raw, 'head': head, 'projection': projection}


class ProtocolCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='case-', dir=HERE)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.homes = {name: self.tmp / name for name in ('mcp', 'cli')}
        template = json.loads((ROOT / 'fixtures/plan/templates.v1.json').read_text())['templates'][0]
        for home in self.homes.values():
            folder = home / 'templates'
            folder.mkdir(parents=True)
            (folder / (template['id'] + '.json')).write_text(json.dumps(template))
        self.counter = itertools.count(1)
        self.proof = self.tmp / 'proof.txt'
        self.proof.write_text('deterministic evidence\n')

    def raw_call(self, adapter, tool, args):
        request = [tool, args]
        home = self.homes[adapter]
        if adapter == 'mcp':
            output = io.StringIO()
            with deterministic(home, request), redirect_stdout(output):
                mcp._handle(1, 'tools/call', {'name': tool, 'arguments': args})
            lines = output.getvalue().splitlines()
            self.assertEqual(len(lines), 1)
            reply = json.loads(lines[0])
            self.assertNotIn('error', reply, 'valid MCP request must reach application dispatch')
            result = reply['result']
            payload = json.loads(result['content'][0]['text'])
            self.assertEqual(result.get('isError'), payload.get('ok') is False)
            return payload
        env = {k: v for k, v in os.environ.items() if not k.startswith('CW_')}
        env.update(CW_HOME=str(home), PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.run([sys.executable, '-B', '-m', 'bridge.tests.room.u109.cli_probe'],
                               input=json.dumps(request), text=True, capture_output=True,
                               cwd=ROOT, env=env, timeout=10)
        self.assertEqual(child.stderr, '')
        self.assertIn(child.returncode, (0, 3), child.stdout)
        self.assertEqual(len(child.stdout.splitlines()), 1)
        payload = json.loads(child.stdout)
        self.assertEqual(child.returncode, 3 if payload.get('ok') is False else 0)
        return payload

    def call(self, tool, args=None, *, code=None, contains=(), replay=False, **fields):
        args = dict(args or {}, **fields)
        args.setdefault('room', 'demo')
        if tool != 'plan_get':
            args.setdefault('agent', 'alice')
        if tool not in ('plan_get', 'close_task'):
            args.setdefault('op_id', 'call-' + str(next(self.counter)).zfill(8))
        before = {a: snapshot(h) for a, h in self.homes.items()}
        payloads = {a: self.raw_call(a, tool, copy.deepcopy(args)) for a in self.homes}
        after = {a: snapshot(h) for a, h in self.homes.items()}
        self.assertEqual(payloads['mcp'], payloads['cli'], 'MCP/CLI decoded code/detail or receipt differs')
        self.assertEqual(after['mcp'], after['cli'], 'MCP/CLI projections or journals differ')
        value = payloads['mcp']
        if code is not None:
            self.assertEqual(value.get('code'), code, 'missing lifecycle decision, not a fixture error')
            self.assertIs(value.get('ok'), False)
            self.assertIsInstance(value.get('detail'), str)
            self.assertTrue(value['detail'])
            for text in contains:
                self.assertIn(text.lower(), value['detail'].lower())
            self.assertEqual(after, before, 'rejected call changed bytes, head, revisions or projection')
            return value
        self.assertNotIn('code', value, value)
        if tool != 'close_task':
            self.assertEqual(set(value), {'untrusted'})
        if replay:
            self.assertEqual(after, before, 'replay appended or affected a subsequent claim')
            self.assertIs(value['untrusted'].get('replayed'), True)
        return value.get('untrusted', value)

    def create(self, *, count=1, strict=False, deps=True, single=False):
        if strict:
            self.call('memory_set', section='notes', text='Decision', base_rev=0)
        def task(key, depends):
            return dict(key=key, title='Action', type='action', phase='start', accept='Pass' if strict else '', deps=depends,
                        microtasks=[{'text': 'Check', 'accept': ''} for _ in range(count)])
        value = self.call('plan_create', template_id='neutral', title='Plan', brief={'goal': 'Deliver'},
                          tasks=[task('first', [])] + ([] if single else [task('second', ['first'] if deps else [])]), strict=strict)
        self.assertEqual(value['ids'], {'first': 'T01'} if single else {'first': 'T01', 'second': 'T02'})

    def projection(self):
        return snapshot(self.homes['mcp'])['projection']

    def task(self, tid='T01'):
        return next(t for t in self.projection()['tasks'] if t['id'] == tid)

    def claim(self, tid='T01', agent='alice'):
        return self.call('task_claim', task_id=tid, agent=agent)

    def micro(self, state, mid='T01.M01', agent='alice', **kw):
        return self.call('microtask_set', id=mid, state=state, agent=agent, **kw)

    def edit(self, tid='T01', **kw):
        return self.call('task_update', task_id=tid, base_rev=self.task(tid)['rev'], **kw)
