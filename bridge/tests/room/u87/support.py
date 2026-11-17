"""Transport-neutral fixtures; no production dispatcher name is prescribed."""
import ast
import copy
import importlib
import inspect
import io
import itertools
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import unittest
import importlib.abc
import importlib.util
import sys
import tempfile
import time
import types
from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]

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
APP = ROOT / "bridge/room/app.py"
TOOLS = (
    'post_status', 'post_plan', 'post_step', 'close_task', 'read_inbox',
    'wait_inbox', 'list_templates', 'get_template', 'plan_create', 'plan_get',
    'plan_check', 'plan_phase', 'plan_close', 'task_add', 'task_update',
    'task_claim', 'task_release', 'microtask_add', 'microtask_set', 'next_work',
    'memory_set', 'memory_get',
)
REQUIRED = {
    'post_status': {'room', 'agent', 'text'},
    'post_plan': {'room', 'agent', 'title', 'steps'},
    'post_step': {'room', 'agent', 'index', 'state'},
    'close_task': {'room', 'agent', 'outcome'},
    'read_inbox': {'room', 'agent'}, 'wait_inbox': {'room', 'agent'},
    'list_templates': set(), 'get_template': {'template_id'},
    'plan_create': {'room', 'agent', 'template_id', 'title', 'brief', 'tasks'},
    'plan_get': {'room'}, 'plan_check': {'room'},
    'plan_phase': {'room', 'agent', 'phase', 'base_rev'},
    'plan_close': {'room', 'agent', 'base_rev'},
    'task_add': {'room', 'agent', 'title', 'type', 'phase', 'accept'},
    'task_update': {'room', 'agent', 'task_id', 'base_rev'},
    'task_claim': {'room', 'agent', 'task_id'},
    'task_release': {'room', 'agent', 'task_id'},
    'microtask_add': {'room', 'agent', 'task_id', 'text', 'base_rev'},
    'microtask_set': {'room', 'agent', 'id', 'state'},
    'next_work': {'room', 'agent'},
    'memory_set': {'room', 'agent', 'section', 'text', 'base_rev'},
    'memory_get': {'room'},
}


def require_application():
    """Expose the supplied scaffold error without freezing its provisional API.

    Only literal, whole-body scaffold functions are called. Real functions are
    never probed with invented arguments. No export name or return type is fixed.
    """
    app = importlib.import_module('bridge.room.app')
    for node in ast.parse(inspect.getsource(app)).body:
        if not isinstance(node, ast.FunctionDef):
            continue
        body = list(node.body)
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
            body.pop(0)
        if len(body) != 1 or not isinstance(body[0], ast.Raise):
            continue
        exc = body[0].exc
        if (isinstance(exc, ast.Call) and isinstance(exc.func, ast.Name)
                and exc.func.id == 'NotImplementedError' and len(exc.args) == 1
                and isinstance(exc.args[0], ast.Constant) and exc.args[0].value == 'U87 stub'):
            fn = getattr(app, node.name)
            positional, keywords = [], {}
            for p in inspect.signature(fn).parameters.values():
                if p.default is not inspect.Parameter.empty:
                    continue
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD):
                    positional.append(None)
                elif p.kind == p.KEYWORD_ONLY:
                    keywords[p.name] = None
            fn(*positional, **keywords)


def task(key='first', **changes):
    result = dict(key=key, title='Action', type='action', phase='start', accept='Pass',
                  microtasks=[{'text': 'Check', 'accept': 'Pass'}])
    result.update(changes)
    return result


def create_args(**changes):
    result = dict(room='demo', agent='worker', template_id='neutral', title='Plan',
                  brief={'goal': 'Deliver'}, tasks=[task()])
    result.update(changes)
    return result


def tree_bytes(home):
    home = Path(home)
    return {str(p.relative_to(home)): p.read_bytes()
            for p in home.rglob('*') if p.is_file()}


def journal(home):
    return {p: value for p, value in tree_bytes(home).items() if p.endswith('/events.jsonl')}


@contextmanager
def deterministic(home):
    ids, ticks = itertools.count(1), itertools.count()
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {'CW_HOME': str(home), 'PYTHONDONTWRITEBYTECODE': '1'}))
        stack.enter_context(patch.object(time, 'time', return_value=1700000000.0))
        stack.enter_context(patch.object(time, 'monotonic', side_effect=lambda: next(ticks)))
        stack.enter_context(patch.object(time, 'sleep', new=_sleep_guard()))
        stack.enter_context(patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')))
        stack.enter_context(patch.object(secrets, 'token_hex', side_effect=lambda n: format(next(ids), '0%dx' % (2*n))))
        yield


class BaseCase(unittest.TestCase):
    def setUp(self):
        scratch = HERE / '.scratch'
        scratch.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='case-', dir=scratch)
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.home = self.tmp / 'home'
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(deterministic(self.home))


class FutureCase(BaseCase):
    def setUp(self):
        require_application()
        super().setUp()


def write_template(home):
    template = json.loads((ROOT / 'fixtures/plan/templates.v1.json').read_text())['templates'][0]
    directory = Path(home) / 'templates'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / (template['id'] + '.json')).write_text(json.dumps(template), encoding='utf-8')
    return template


def seed_plan(home, count=1, assignee='worker'):
    from bridge.room import store
    template = write_template(home)
    ops = [{'kind': 'plan.open', 'title': 'Plan', 'template_id': 'neutral',
            'template_hash': template['hash'], 'brief': {'goal': 'Deliver'}, 'phase': 'start'}]
    for _ in range(count):
        value = task(assignee=assignee)
        value.pop('key')
        ops.append(dict(kind='task.add', **value))
    store.post_ops('demo', 'worker', ops)


def fixture(home, name):
    from bridge.room import store
    write_template(home)
    common = dict(room='demo', agent='worker')
    if name in TOOLS[:6]:
        store.post('demo', 'worker', 'plan', 'Legacy', plan={'title': 'Legacy', 'steps': [{'text': 'Step'}]})
        store.post('demo', 'peer', 'heartbeat', 'Inbox', to='worker')
        return {
            'post_status': dict(common, text='Ready'),
            'post_plan': dict(common, title='Legacy', steps=[{'text': 'Step', 'accept': 'Pass'}]),
            'post_step': dict(common, index=1, state='done', outcome='Pass', took='1m'),
            'close_task': dict(common, outcome='Verified'),
            'read_inbox': common,
            'wait_inbox': dict(common, timeout_s=0),
        }[name]
    if name == 'list_templates':
        return {}
    if name == 'get_template':
        return {'template_id': 'neutral'}
    if name == 'plan_create':
        return create_args()
    seed_plan(home, assignee=None if name == 'task_claim' else 'worker')
    values = {
        'plan_get': {'room': 'demo'}, 'plan_check': {'room': 'demo'},
        'plan_phase': dict(common, phase='finish', base_rev=1),
        'plan_close': dict(common, outcome='Complete', base_rev=1),
        'task_add': dict(common, **{k: v for k, v in task().items() if k != 'key'}),
        'task_update': dict(common, task_id='T01', base_rev=2, title='Changed'),
        'task_claim': dict(common, task_id='T01'),
        'task_release': dict(common, task_id='T01'),
        'microtask_add': dict(common, task_id='T01', base_rev=2, text='Second', accept='Pass'),
        'microtask_set': dict(common, id='T01.M01', state='active'),
        'next_work': common,
        'memory_set': dict(common, section='notes', text='Decision', base_rev=0),
        'memory_get': {'room': 'demo'},
    }
    return values[name]


class AdapterOutput(io.StringIO):
    def write(self, text):
        frame = sys._getframe(1)
        while frame is not None:
            assert frame.f_code.co_filename != str(APP), 'application performed stdout I/O'
            frame = frame.f_back
        return super().write(text)


def cli_call(argv):
    out, err = AdapterOutput(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            rc = importlib.import_module('bridge.room.__main__').main(argv)
        except SystemExit as exc:
            rc = exc.code
    raw = out.getvalue()
    assert raw.endswith('\n') and len(raw.splitlines()) == 1, 'exactly one newline-terminated JSON object required'
    value = json.loads(raw)
    assert isinstance(value, dict), value
    return rc, value, raw, err.getvalue()


def rpc(method, params=None):
    out = AdapterOutput()
    with redirect_stdout(out):
        importlib.import_module('bridge.room.mcp')._handle(7, method, params)
    lines = out.getvalue().splitlines()
    assert len(lines) == 1, 'exactly one JSON-RPC response required'
    value = json.loads(lines[0])
    assert value.get('jsonrpc') == '2.0' and value.get('id') == 7, value
    return value


def call(adapter, name, args):
    with ExitStack() as stack:
        stack.enter_context(patch('builtins.input', side_effect=AssertionError('application read stdin')))
        stack.enter_context(patch.object(sys.stdin, 'read', side_effect=AssertionError('application read stdin')))
        stack.enter_context(patch.object(sys.stdin, 'readline', side_effect=AssertionError('application read stdin')))
        return _call(adapter, name, args)


def _call(adapter, name, args):
    if adapter == 'cli':
        rc, payload, _, _ = cli_call(['call', name, '--json', json.dumps(args)])
        return rc, payload
    reply = rpc('tools/call', {'name': name, 'arguments': args})
    assert 'result' in reply, reply
    result = reply['result']
    assert result['content'][0]['type'] == 'text', result
    assert isinstance(result.get('isError'), bool), result
    return (3 if result['isError'] else 0), json.loads(result['content'][0]['text'])


def child(*args, stdin=b''):
    result = subprocess.run([sys.executable, '-B', *args], input=stdin, capture_output=True,
                            cwd=ROOT, env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))  # A-U87e: no timeout; Popen.wait(timeout) polls with the patched time.sleep under load. Bounded by the vitest wrapper and unittest runner.
    assert len(result.stdout) + len(result.stderr) <= 1024*1024, 'child output exceeded oracle bound'
    return result


@contextmanager
def dispatch_spy(name, args):
    seen = set()
    previous = sys.getprofile()

    def profile(frame, event, arg):
        if event != 'call' or frame.f_code.co_filename != str(APP):
            return
        values = list(frame.f_locals.values())
        if any(v == name for v in values if isinstance(v, str)) and any(v == args for v in values if isinstance(v, dict)):
            seen.add(frame.f_code)

    sys.setprofile(profile)
    try:
        yield seen
    finally:
        sys.setprofile(previous)


def assert_shared(*observed):
    assert observed and set.intersection(*observed), 'both adapters must enter the same application dispatcher'


def assert_error(result, code, detail=None):
    rc, payload = result
    assert rc == 3, result
    assert payload.get('ok') is False and payload.get('code') == code, result
    assert 'untrusted' not in payload, payload
    assert set(payload) <= {'ok', 'code', 'detail'}, payload
    if detail is not None:
        assert payload.get('detail') == detail, 'detail differs: %r' % payload


def kind(schema, expected):
    declared = schema.get('type')
    if declared == expected or isinstance(declared, list) and expected in declared:
        return schema
    for keyword in ('anyOf', 'oneOf'):
        for branch in schema.get(keyword, []):
            try:
                return kind(branch, expected)
            except AssertionError:
                pass
    raise AssertionError('schema must expose type %s: %r' % (expected, schema))


def assert_structural(schema, value):
    """Interpret only the published JSON Schema vocabulary exercised by U87."""
    for keyword in ('anyOf', 'oneOf'):
        if keyword in schema:
            matches = 0
            for branch in schema[keyword]:
                try:
                    assert_structural(branch, value)
                    matches += 1
                except AssertionError:
                    pass
            assert matches >= 1 if keyword == 'anyOf' else matches == 1, (keyword, value)
    for branch in schema.get('allOf', []):
        assert_structural(branch, value)
    actual = ('null' if value is None else 'boolean' if isinstance(value, bool)
              else 'object' if isinstance(value, dict) else 'array' if isinstance(value, list)
              else 'string' if isinstance(value, str) else 'integer' if isinstance(value, int) else 'number')
    if 'type' in schema:
        types_ = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        assert actual in types_ or actual == 'integer' and 'number' in types_, ('type', value, schema)
    if 'enum' in schema:
        assert value in schema['enum'], ('enum', value)
    if isinstance(value, dict):
        assert set(schema.get('required', [])) <= set(value), ('required', value)
        properties = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            assert set(value) <= set(properties), ('additionalProperties', value)
        for key in value.keys() & properties.keys():
            assert_structural(properties[key], value[key])
    elif isinstance(value, list):
        assert len(value) >= schema.get('minItems', 0), 'minItems'
        assert len(value) <= schema.get('maxItems', float('inf')), 'maxItems'
        if schema.get('uniqueItems'):
            assert len({json.dumps(v, sort_keys=True) for v in value}) == len(value), 'uniqueItems'
        if 'items' in schema:
            for item in value:
                assert_structural(schema['items'], item)
    elif isinstance(value, str):
        assert len(value) >= schema.get('minLength', 0), 'minLength'
        assert len(value) <= schema.get('maxLength', float('inf')), 'maxLength'


def assert_micro_array(schema):
    array = kind(schema, 'array')
    kind(schema, 'null')
    assert array.get('maxItems') == 12, array
    micro = kind(array.get('items', {}), 'object')
    assert micro.get('additionalProperties') is False, micro
    assert set(micro.get('required', [])) == {'text'}, micro
    properties = micro.get('properties', {})
    assert set(properties) == {'text', 'accept'}, properties
    text = kind(properties['text'], 'string')
    assert text.get('minLength') == 1 and text.get('maxLength') == 80, text
    accept = kind(properties['accept'], 'string')
    assert accept.get('maxLength') == 160, accept
    with_assertion = False
    try:
        kind(properties['accept'], 'null')
        with_assertion = True
    except AssertionError:
        pass
    assert not with_assertion, 'null acceptance must not be advertised'


def assert_schemas(tools):
    schemas = {t['name']: t['inputSchema'] for t in tools}
    for name, expected in REQUIRED.items():
        schema = kind(schemas[name], 'object')
        assert set(schema.get('required', [])) == expected, (name, schema)
        assert expected <= set(schema.get('properties', {})), (name, schema)
    create = schemas['plan_create']['properties']
    brief = kind(create['brief'], 'object')
    assert not brief.get('required'), 'brief keys are selected by template'
    tasks = kind(create['tasks'], 'array')
    assert tasks.get('minItems') == 1 and tasks.get('maxItems') == 40, tasks
    item = kind(tasks.get('items', {}), 'object')
    assert item.get('additionalProperties') is False, item
    assert set(item.get('required', [])) == {'key', 'title', 'type', 'phase'}, item
    props = item.get('properties', {})
    assert set(props) == {'key', 'title', 'type', 'phase', 'accept', 'deps', 'assignee', 'estimate', 'microtasks'}, props
    for name in ('key', 'type', 'phase'):
        kind(props[name], 'string')
    for fields in (props, schemas['task_add']['properties']):
        title = kind(fields['title'], 'string')
        assert title.get('minLength') == 1 and title.get('maxLength') == 120, title
        assert kind(fields['accept'], 'string').get('maxLength') == 160
        deps = kind(fields['deps'], 'array')
        assert deps.get('maxItems') == 8 and deps.get('uniqueItems') is True, deps
        kind(deps.get('items', {}), 'string')
        kind(fields['assignee'], 'string')
        kind(fields['assignee'], 'null')
        assert kind(fields['estimate'], 'string').get('maxLength') == 32
        kind(fields['estimate'], 'null')
        assert_micro_array(fields['microtasks'])
    standalone = schemas['microtask_add']['properties']
    # A-U140r1: SPEC_U140 (review B3) adds the optional plan-generation fence to mutation tools.
    fence = standalone.get('expected_opened_lamport')
    assert fence is None or (fence.get('type') == 'integer' and fence.get('minimum') == 1), fence
    assert set(standalone) - {'expected_opened_lamport'} == {'room', 'agent', 'task_id', 'text', 'accept', 'base_rev', 'op_id'}
    assert kind(standalone['text'], 'string').get('minLength') == 1
    assert kind(standalone['text'], 'string').get('maxLength') == 80
    assert kind(standalone['accept'], 'string').get('maxLength') == 160
    for name in ('plan_create', 'task_add', 'microtask_add'):
        assert schemas[name].get('additionalProperties') is False, (name, schemas[name])


class ProbeFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, outcome='ok'):
        self.outcome = outcome

    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'bridge.room.ext.events':
            return importlib.util.spec_from_loader(fullname, self)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        from bridge.room.ext import register
        from bridge.room.store import RoomError

        def handler(args):
            if self.outcome == 'room':
                raise RoomError('stale_rev', 'probe')
            if self.outcome == 'internal':
                raise RuntimeError('u87 private exception text')
            return {'probe': True}

        descriptor = {'name': 'u87_probe', 'description': 'Test-only extension.',
                      'inputSchema': {'type': 'object', 'properties': {}, 'required': []}}
        register(descriptor, handler)
        module.handler = handler


def fresh_probe(home, order, outcome):
    finder = ProbeFinder(outcome)
    sys.meta_path.insert(0, finder)
    try:
        with deterministic(home):
            write_template(home)
            if order == 'cli-first':
                cli_discovery = cli_call(['tools'])
                cli_loaded_mcp = 'bridge.room.mcp' in sys.modules
                mcp_discovery = rpc('tools/list')['result']
            else:
                mcp_discovery = rpc('tools/list')['result']
                cli_discovery = cli_call(['tools'])
                cli_loaded_mcp = 'bridge.room.mcp' in sys.modules
            from bridge.room import ext
            ext.load()
            ext.load()
            assert rpc('tools/list')['result'] == mcp_discovery, 'repeated loads duplicated discovery'
            duplicate_rejected = False
            try:
                ext.register({'name': 'u87_probe'}, lambda args: {})
            except ValueError:
                duplicate_rejected = True
            cli_rc, cli_value, _, cli_stderr = cli_call(['call', 'u87_probe', '--json', '{}'])
            return {'cli_discovery': cli_discovery[:2], 'mcp_discovery': mcp_discovery,
                    'cli_loaded_mcp': cli_loaded_mcp, 'duplicate_rejected': duplicate_rejected,
                    'cli_probe': (cli_rc, cli_value), 'mcp_probe': call('mcp', 'u87_probe', {}),
                    'cli_stderr': cli_stderr}
    finally:
        sys.meta_path.remove(finder)


