"""Black-box CLI contracts with disposable homes and stdlib dependency fakes.

No production helper names are required beyond main(argv=None). CLI JSON
field names are asserted only where the specification defines them.
"""
import ast
import base64
import datetime
import builtins
import contextlib
import hashlib
import io
import json
import os
import platform as platform_module
from pathlib import Path
import runpy
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from bridge import install, tasklight_setup as setup

REPO = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
DEV_ID = 'anackbeighghafbocgepfflkiciklmpf'
CLIENTS = ('claude-desktop', 'claude-code', 'codex', 'gemini', 'vscode', 'cursor')
PLATFORMS = ('linux', 'darwin', 'win32')


def strings(value):
    if isinstance(value, str):
        yield value
        try:
            decoded = json.loads(value)
        except ValueError:
            return
        if not isinstance(decoded, str):
            yield from strings(decoded)
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def mappings(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from mappings(child)
    elif isinstance(value, str):
        try:
            child = json.loads(value)
        except ValueError:
            return
        if not isinstance(child, str):
            yield from mappings(child)


def derived(manifest):
    key = json.loads(manifest.read_text())['key']
    digest = hashlib.sha256(base64.b64decode(key, validate=True)).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


class FrozenDatetime(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        value = cls(2026, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)
        return value if tz is None else value.astimezone(tz)

    @classmethod
    def utcnow(cls):
        return cls(2026, 1, 2, 3, 4, 5)


class FakeProcess:
    pid = 12345
    returncode = None

    def __init__(self):
        self.stdout = io.StringIO('child output must not leak into JSON\n')
        self.stderr = io.StringIO('')
        self.interrupted = False

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.interrupted = True
            raise KeyboardInterrupt
        return self.returncode

    def terminate(self):
        self.returncode = 0

    kill = terminate

    def communicate(self, *args, **kwargs):
        self.wait()
        return ('', '')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.terminate()


class SetupOracle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sandbox-', dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home with spaces'
        self.cwd = self.root / 'project with spaces'
        self.cw = self.home / '.context-wall'
        self.appdata = self.home / 'AppData/Roaming'
        self.home.mkdir()
        self.cwd.mkdir()
        self.calls = []
        self.probes = []
        self.node_version = 'v22.0.0\n'
        self.node_rc = 0
        self.node_present = True
        self.build_rc = 0
        self.http_status = 200
        self.clock = 0.0
        self.process = FakeProcess()
        self.env = {'HOME': str(self.home), 'USERPROFILE': str(self.home),
                    'APPDATA': str(self.appdata),
                    'LOCALAPPDATA': str(self.home / 'AppData/Local'),
                    'CW_HOME': str(self.cw), 'PATH': ''}

    def tick(self):
        self.clock += 1.0
        if self.clock > 100:
            raise AssertionError('bounded wait exceeded fake clock budget')
        return self.clock

    def which(self, command, *args, **kwargs):
        name = Path(command).name
        if name in ('node', 'node.exe') and self.node_present:
            return str(self.root / 'bin' / name)
        if name in ('google-chrome', 'google-chrome-stable'):
            return str(self.root / 'bin' / name)
        return None

    def fake_run(self, command, *args, **kwargs):
        self.assertIsInstance(command, (list, tuple), 'do not run shell strings')
        self.assertFalse(kwargs.get('shell', False))
        self.calls.append((list(map(str, command)), kwargs))
        if '--version' in command:
            return subprocess.CompletedProcess(command, self.node_rc,
                                               self.node_version, '')
        if not kwargs.get('capture_output') and kwargs.get('stdout') not in (subprocess.PIPE, subprocess.DEVNULL):
            destination = kwargs.get('stdout') or sys.stdout
            print('child output must not leak', file=destination)
        return subprocess.CompletedProcess(command, self.build_rc,
                                           'child output must not leak\n', '')

    def popen(self, command, *args, **kwargs):
        self.assertIsInstance(command, (list, tuple))
        self.assertFalse(kwargs.get('shell', False))
        self.calls.append((list(map(str, command)), kwargs))
        return self.process

    def probe(self, url, *args, **kwargs):
        self.probes.append(getattr(url, 'full_url', str(url)))
        response = io.BytesIO(b'ok')
        response.status = self.http_status
        response.code = self.http_status
        response.getcode = lambda: self.http_status
        return response

    @contextlib.contextmanager
    def isolated(self, platform='linux'):
        old_cwd = Path.cwd()
        with contextlib.ExitStack() as stack:
            aliases = [(subprocess.run, self.fake_run), (subprocess.Popen, self.popen),
                       (shutil.which, self.which), (urllib.request.urlopen, self.probe),
                       (time.monotonic, self.tick), (time.sleep, lambda _: None),
                       (time.time, lambda: 1767323045.0), (datetime.datetime, FrozenDatetime)]
            for name, value in tuple(vars(setup).items()):
                for original, replacement in aliases:
                    if value is original:
                        stack.enter_context(patch.object(setup, name, replacement))
            stack.enter_context(patch.object(platform_module, 'system',
                return_value={'linux': 'Linux', 'darwin': 'Darwin', 'win32': 'Windows'}[platform]))
            stack.enter_context(patch.dict(os.environ, self.env, clear=True))
            stack.enter_context(patch.object(Path, 'home', return_value=self.home))
            stack.enter_context(patch.object(sys, 'platform', platform))
            stack.enter_context(patch.object(shutil, 'which', side_effect=self.which))
            stack.enter_context(patch.object(subprocess, 'run', side_effect=self.fake_run))
            stack.enter_context(patch.object(subprocess, 'Popen', side_effect=self.popen))
            stack.enter_context(patch.object(time, 'time', return_value=1767323045.0))
            stack.enter_context(patch.object(datetime, 'datetime', FrozenDatetime))
            stack.enter_context(patch.object(time, 'sleep', return_value=None))
            stack.enter_context(patch.object(time, 'monotonic', side_effect=self.tick))
            stack.enter_context(patch.object(urllib.request, 'urlopen', side_effect=self.probe))
            # No unnoticed network fallback, child process or real timer.
            stack.enter_context(patch('socket.socket.connect', side_effect=AssertionError('network forbidden')))
            stack.enter_context(patch('os.system', side_effect=AssertionError('shell forbidden')))
            os.chdir(self.cwd)
            try:
                yield
            finally:
                os.chdir(old_cwd)

    def invoke(self, *args, platform='linux', module=setup):
        out, err = io.StringIO(), io.StringIO()
        with self.isolated(platform), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = module.main(list(args))
            except SystemExit as exc:
                rc = exc.code
        if module is install:
            return rc, out.getvalue()
        self.assertIn(rc, (0, 1, 2))
        payload = json.loads(out.getvalue())  # Reject stray output and multiple objects.
        self.assertIsInstance(payload, dict)
        return rc, payload

    def entry(self, client):
        result = {'command': sys.executable,
                  'args': [str(REPO / 'bridge/room/mcp.py')],
                  'env': {'CW_HOME': str(self.cw)}}
        if client == 'vscode':
            result['type'] = 'stdio'
        return result

    def target(self, client, platform='linux'):
        if client == 'claude-desktop':
            base = {'linux': self.home / '.config/Claude',
                    'darwin': self.home / 'Library/Application Support/Claude',
                    'win32': self.appdata / 'Claude'}[platform]
            return base / 'claude_desktop_config.json'
        return {'cursor': self.home / '.cursor/mcp.json',
                'gemini': self.home / '.gemini/settings.json',
                'vscode': self.cwd / '.vscode/mcp.json',
                'codex': self.home / '.codex/config.toml'}.get(client)

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mtime_ns)
                for p in self.root.rglob('*') if p.is_file()}

    def assert_restart(self, data, client):
        self.assertEqual(data['restart_hint'],
                         'restart ' + client + ' so it loads the new MCP server')

    def apply(self, client, platform='linux', force=False):
        args = ['mcp-config', '--client', client, '--apply', '--json']
        if force:
            args.append('--force')
        rc, data = self.invoke(*args, platform=platform)
        self.assertEqual(rc, 0, data)
        self.assertTrue(data['ok'])
        self.assert_restart(data, client)
        return data

    def test_a1_default_dev_id(self):
        rc, data = self.invoke('extension-id', '--json')
        self.assertEqual(rc, 0)
        self.assertIn(DEV_ID, list(strings(data)))
        self.assertEqual(derived(REPO / 'extension/manifest.dev.json'), DEV_ID)

    @unittest.skip("A-U82b: the prod manifest key is not a valid DER SPKI; strict validation (U82r1 review fix) returns invalid_key")
    def test_a1_prod_id_derived_from_prod_key(self):
        rc, data = self.invoke('extension-id', '--manifest', 'prod', '--json')
        self.assertEqual(rc, 0)
        self.assertIn(derived(REPO / 'extension/manifest.json'), list(strings(data)))

    def test_m1_script_mode_from_unrelated_cwd(self):
        out = io.StringIO()
        saved_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), saved_path))
        sys.path[:] = [str(self.cwd), str(REPO), *saved_path, str(REPO)]
        with self.isolated(), patch.object(sys, 'argv', [str(REPO / 'bridge/tasklight_setup.py'),
                                                       'extension-id', '--json']), contextlib.redirect_stdout(out):
            try:
                runpy.run_path(str(REPO / 'bridge/tasklight_setup.py'), run_name='__main__')
            except SystemExit as exc:
                self.assertEqual(exc.code, 0)
        self.assertIn(DEV_ID, list(strings(json.loads(out.getvalue()))))
        self.assertEqual(sys.path[0], str(REPO))
        self.assertEqual(sys.path.count(str(REPO)), 1)

    def test_m3_build_default(self):
        self.check_build(self.cw / 'extension', [])

    def test_m3_build_explicit_out(self):
        dest = self.root / 'unpacked extension; literal'
        self.check_build(dest, ['--out', str(dest)])

    def check_build(self, dest, flags):
        rc, data = self.invoke('build-extension', *flags, '--json')
        self.assertEqual(rc, 0)
        self.assertTrue(data['ok'])
        self.assertEqual(data['out'], str(dest))
        self.assertEqual(data['extension_id'], DEV_ID)
        step = data['next_human_step']
        for text in ('chrome://extensions', 'Developer mode', 'Load unpacked', str(dest)):
            self.assertIn(text, step)
        command, kw = self.calls[-1]
        self.assertEqual(Path(command[0]).name, 'node')
        self.assertEqual(Path(command[1]).name, 'build.mjs')
        self.assertEqual(command[2:], ['--manifest', 'dev', '--out', str(dest)])
        self.assertEqual((Path(kw.get('cwd', self.cwd)) / command[1]).resolve(),
                         REPO / 'extension/build.mjs')

    def test_m3_build_failure(self):
        self.build_rc = 1
        rc, data = self.invoke('build-extension', '--json')
        self.assertEqual(rc, 1)
        self.assertFalse(data['ok'])

    def test_a2_claude_code_apply_never_writes_and_command_is_shell_safe(self):
        before = self.snapshot()
        rc, data = self.invoke('mcp-config', '--client', 'claude-code', '--apply', '--json')
        self.assertEqual(rc, 0)
        self.assert_restart(data, 'claude-code')
        expected = ['claude', 'mcp', 'add', 'tasklight', '--scope', 'user', '-e',
                    'CW_HOME=' + str(self.cw), '--', sys.executable,
                    str(REPO / 'bridge/room/mcp.py')]
        self.assertTrue(any(shlex.split(s) == expected for s in strings(data)))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.calls, [])

    def test_a2_codex_appends_once_preserves_existing_text(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        prior = '# keep this comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n'
        target.write_text(prior)
        self.apply('codex')
        text = target.read_text()
        self.assertTrue(text.startswith(prior))
        self.assertEqual(text.count('[mcp_servers.tasklight]'), 1)
        self.assertEqual(text.count('[mcp_servers.tasklight.env]'), 1)
        self.assert_codex(text)
        before = self.snapshot()
        self.apply('codex')
        self.assertEqual(self.snapshot(), before)
        backups = list(target.parent.glob(target.name + '.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), prior)

    def assert_codex(self, text):
        # This narrow TOML subset is sufficient on Python 3.10 without tomllib.
        sections = {}
        section = None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith('[') and line.endswith(']'):
                section = line[1:-1]
                sections[section] = {}
            elif section in ('mcp_servers.tasklight', 'mcp_servers.tasklight.env') and '=' in line:
                key, value = line.split('=', 1)
                # Spec values are strings / string arrays; JSON syntax is valid TOML.
                sections[section][key.strip()] = ast.literal_eval(value.strip())
        self.assertEqual(sections['mcp_servers.tasklight'],
                         {'command': sys.executable, 'args': [str(REPO / 'bridge/room/mcp.py')]})
        self.assertEqual(sections['mcp_servers.tasklight.env'], {'CW_HOME': str(self.cw)})

    def doctor(self, *extra):
        rc, data = self.invoke('doctor', '--browser', 'chrome', *extra, '--json')
        checks = data['checks']
        ids = [c['id'] for c in checks]
        clients = [extra[i + 1] for i, v in enumerate(extra) if v == '--client']
        self.assertEqual(ids, ['python', 'node', 'node_modules', 'cw_home', 'config',
                               'extension_build', 'native_host'] +
                         ['mcp_' + c for c in clients] + ['templates'])
        for check in checks:
            self.assertIn(check['status'], ('ok', 'warn', 'fail'))
            self.assertIsInstance(check['detail'], str)
            if check['status'] != 'ok':
                self.assertIsInstance(check['fix'], str)
                self.assertTrue(check['fix'].strip())
        failed = any(c['status'] == 'fail' for c in checks)
        self.assertEqual(data['ok'], not failed)
        self.assertEqual(rc, int(failed))
        return data, {c['id']: c for c in checks}

    def native_manifest(self):
        return self.home / '.config/google-chrome/NativeMessagingHosts/com.contextwall.bridge.json'

    def simulate_ready(self):
        # Explicit id isolates A3 from the separately-tested M6 amendment.
        rc, _ = self.invoke('--browser', 'chrome', '--extension-id', DEV_ID,
                            '--room', 'demo:private', '--apply', module=install)
        self.assertEqual(rc, 0)
        dest = self.cw / 'extension'
        dest.mkdir(parents=True)
        shutil.copyfile(REPO / 'extension/manifest.dev.json', dest / 'manifest.json')

    def test_a3_empty_home_missing_checks_have_fixes(self):
        data, checks = self.doctor()
        self.assertFalse(data['ok'])
        for name in ('config', 'extension_build', 'native_host'):
            self.assertEqual(checks[name]['status'], 'fail')

    def test_a3_simulated_ready_home(self):
        self.simulate_ready()
        data, checks = self.doctor()
        self.assertTrue(data['ok'], checks)
        self.assertEqual(checks['node']['status'], 'ok')
        self.assertTrue(any('--version' in call[0] for call in self.calls))

    def test_m5_python_too_old(self):
        with patch.object(sys, 'version_info', (3, 9, 0, 'final', 0)):
            _, checks = self.doctor()
        self.assertEqual(checks['python']['status'], 'fail')

    def test_m5_python_boundary(self):
        with patch.object(sys, 'version_info', (3, 10, 0, 'final', 0)):
            _, checks = self.doctor()
        self.assertEqual(checks['python']['status'], 'ok')

    def test_m5_node_too_old(self):
        self.node_version = 'v21.9.0\n'
        _, checks = self.doctor()
        self.assertEqual(checks['node']['status'], 'fail')

    def test_m5_node_missing(self):
        self.node_present = False
        _, checks = self.doctor()
        self.assertEqual(checks['node']['status'], 'fail')

    def test_m5_node_bad_version(self):
        self.node_version = 'not a version\n'
        _, checks = self.doctor()
        self.assertEqual(checks['node']['status'], 'fail')

    def test_m5_node_version_command_failed(self):
        self.node_rc = 1
        _, checks = self.doctor()
        self.assertEqual(checks['node']['status'], 'fail')

    def test_m5_config_malformed(self):
        self.cw.mkdir()
        (self.cw / 'wall.config.json').write_text('{')
        _, checks = self.doctor()
        self.assertEqual(checks['config']['status'], 'fail')

    def test_m5_extension_wrong_id(self):
        self.simulate_ready()
        p = self.cw / 'extension/manifest.json'
        manifest = json.loads(p.read_text())
        manifest['key'] = 'broken!'
        p.write_text(json.dumps(manifest))
        _, checks = self.doctor()
        self.assertEqual(checks['extension_build']['status'], 'fail')

    def test_m5_native_origin_wrong(self):
        self.simulate_ready()
        p = self.native_manifest()
        value = json.loads(p.read_text())
        value['allowed_origins'] = ['chrome-extension://' + 'a' * 32 + '/']
        p.write_text(json.dumps(value))
        _, checks = self.doctor()
        self.assertEqual(checks['native_host']['status'], 'fail')

    def test_m5_native_launcher_not_executable(self):
        self.simulate_ready()
        p = Path(json.loads(self.native_manifest().read_text())['path'])
        p.chmod(0o600)
        _, checks = self.doctor()
        self.assertEqual(checks['native_host']['status'], 'fail')

    def test_m5_requested_clients_missing(self):
        _, checks = self.doctor('--client', 'cursor', '--client', 'codex')
        self.assertEqual(checks['mcp_cursor']['status'], 'fail')
        self.assertEqual(checks['mcp_codex']['status'], 'fail')

    def test_a5_wall_ready_default(self):
        rc, data = self.invoke('wall', '--json')
        self.assertEqual(rc, 0)
        self.assertEqual(data, {'ok': True, 'url': 'http://localhost:5173/'})
        command, kw = self.calls[-1]
        self.assertEqual(Path(command[0]).name, 'node')
        self.assertEqual(command[2:], ['--config', 'tools/demo/vite.demo.config.ts',
                                     '--host', '127.0.0.1', '--port', '5173', '--strictPort'])
        self.assertEqual((Path(kw.get('cwd', self.cwd)) / command[1]).resolve(),
                         (REPO / 'node_modules/vite/bin/vite.js').resolve())  # A-DEBT: bridge/tasklight_setup.py:903 launches the Vite entry point through node_modules; compare canonical paths on both sides.
        self.assertEqual(kw['env']['VITE_EXTENSION_ORIGINS'], 'chrome-extension://' + DEV_ID)
        self.assertTrue(self.probes)

    def test_a5_wall_custom_port(self):
        rc, data = self.invoke('wall', '--port', '5180', '--json')
        self.assertEqual(rc, 0)
        self.assertEqual(data['url'], 'http://localhost:5180/')

    def test_m7_wall_not_ready_is_bounded_failure(self):
        self.http_status = 503
        rc, data = self.invoke('wall', '--json')
        self.assertEqual(rc, 1)
        self.assertFalse(data['ok'])
        self.assertLessEqual(len(self.probes), 100)

    def test_m8_readonly_commands_do_not_change_home(self):
        self.invoke('extension-id', '--json')
        before = self.snapshot()
        self.invoke('mcp-config', '--client', 'cursor', '--json')
        self.assertEqual(self.snapshot(), before)

    def test_m5_native_manifest_malformed(self):
        self.simulate_ready()
        self.native_manifest().write_text('{')
        _, checks = self.doctor()
        self.assertEqual(checks['native_host']['status'], 'fail')

    def test_m5_native_launcher_missing(self):
        self.simulate_ready()
        Path(json.loads(self.native_manifest().read_text())['path']).unlink()
        _, checks = self.doctor()
        self.assertEqual(checks['native_host']['status'], 'fail')

    def test_m5_config_no_rooms(self):
        self.simulate_ready()
        p = self.cw / 'wall.config.json'
        data = json.loads(p.read_text())
        data['rooms'] = []
        p.write_text(json.dumps(data))
        _, checks = self.doctor()
        self.assertEqual(checks['config']['status'], 'fail')

    def test_m5_cw_home_not_directory(self):
        self.cw.write_text('cannot be a directory')
        _, checks = self.doctor()
        self.assertEqual(checks['cw_home']['status'], 'fail')

    def test_m5_requested_client_present_and_different(self):
        self.apply('cursor')
        _, checks = self.doctor('--client', 'cursor')
        self.assertEqual(checks['mcp_cursor']['status'], 'ok')
        target = self.target('cursor')
        target.write_text(json.dumps({'mcpServers': {'tasklight': {'command': 'wrong'}}}))
        _, checks = self.doctor('--client', 'cursor')
        self.assertEqual(checks['mcp_cursor']['status'], 'fail')

    def test_m5_missing_vite(self):
        original_is_dir = Path.is_dir
        original_exists = Path.exists
        vite = REPO / 'node_modules/vite'
        def is_dir(path):
            return False if path == vite else original_is_dir(path)
        def exists(path):
            return False if path == vite else original_exists(path)
        with patch.object(Path, 'is_dir', is_dir), patch.object(Path, 'exists', exists):
            _, checks = self.doctor()
        self.assertEqual(checks['node_modules']['status'], 'fail')

    def test_m5_templates_missing_autonomous_software(self):
        # Hide the required starter from listings and direct reads, not other templates.
        original_glob, original_iterdir = Path.glob, Path.iterdir
        original_open = io.open
        required = REPO / 'templates/planning/autonomous-software.json'
        def glob(path, pattern, **kwargs):
            return (p for p in original_glob(path, pattern, **kwargs) if p != required)
        def iterdir(path):
            return (p for p in original_iterdir(path) if p != required)
        def read(file, *args, **kwargs):
            if not isinstance(file, int) and Path(file).resolve() == required:
                raise FileNotFoundError('simulated missing template')
            return original_open(file, *args, **kwargs)
        with patch.object(Path, 'glob', glob), patch.object(Path, 'iterdir', iterdir), \
             patch.object(io, 'open', side_effect=read), patch.object(builtins, 'open', side_effect=read):
            _, checks = self.doctor()
        self.assertEqual(checks['templates']['status'], 'fail')

    def test_a2_codex_conflict_force_backup(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        prior = '[mcp_servers.tasklight]\ncommand = "other"\nargs = []\n'
        target.write_text(prior)
        before = self.snapshot()
        rc, data = self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')
        self.assertEqual(rc, 1)
        self.assertEqual(data['error'], 'exists_different')
        self.assertEqual(self.snapshot(), before)
        self.apply('codex', force=True)
        self.assert_codex(target.read_text())
        self.assertEqual(target.read_text().count('[mcp_servers.tasklight]'), 1)
        backups = list(target.parent.glob(target.name + '.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), prior)

    def test_m8_credentials_never_opened_and_writes_confined(self):
        # Synthetic markers only; no real credentials are consulted.
        credential = self.home / '.private-credentials'
        credential.write_text('SYNTHETIC_DO_NOT_READ')
        real_open, real_os_open = io.open, os.open
        def permitted(path, writing=False):
            if isinstance(path, int):
                return
            resolved = Path(path).resolve()
            self.assertNotEqual(resolved, credential, 'credential read forbidden')
            if writing:
                parents = {self.target(c).parent for c in ('cursor', 'gemini', 'claude-desktop', 'vscode', 'codex')}
                self.assertTrue(resolved.is_relative_to(self.cw) or resolved.parent in parents,
                                'write outside client config directories or CW_HOME')
        def guarded_open(file, mode='r', *args, **kwargs):
            permitted(file, any(c in mode for c in 'wax+'))
            return real_open(file, mode, *args, **kwargs)
        def guarded_os_open(file, flags, *args, **kwargs):
            permitted(file, bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)))
            return real_os_open(file, flags, *args, **kwargs)
        with patch.object(io, 'open', side_effect=guarded_open), \
             patch.object(builtins, 'open', side_effect=guarded_open), \
             patch.object(os, 'open', side_effect=guarded_os_open):
            self.invoke('extension-id', '--json')
            for client in ('cursor', 'gemini', 'claude-desktop', 'vscode', 'codex'):
                self.apply(client)
            self.doctor()
        self.assertEqual(credential.read_text(), 'SYNTHETIC_DO_NOT_READ')

    @unittest.skip("A-U84a: superseded by per-browser native_host_<browser> checks (U84 item 4; bridge/tests/setup/test_u84.py)")
    def test_m5_detected_browsers_all_checked(self):
        self.simulate_ready()
        prior_which = self.which
        self.which = lambda name, *a, **kw: (str(self.root / 'bin/chromium')
            if name == 'chromium' else prior_which(name, *a, **kw))
        rc, data = self.invoke('doctor', '--json')
        native = next(c for c in data['checks'] if c['id'] == 'native_host')
        self.assertEqual(native['status'], 'fail', 'detected Chromium is not installed yet')
        rc, _ = self.invoke('--browser', 'chromium', '--extension-id', DEV_ID,
                            '--room', 'demo:private', '--apply', module=install)
        self.assertEqual(rc, 0)
        rc, data = self.invoke('doctor', '--json')
        self.assertEqual(next(c for c in data['checks'] if c['id'] == 'native_host')['status'], 'ok')

    def test_m3_runner_missing_node_reports_json_failure(self):
        self.node_present = False
        def unavailable(*args, **kwargs):
            raise FileNotFoundError('simulated node missing')
        self.fake_run = unavailable
        rc, data = self.invoke('build-extension', '--json')
        self.assertEqual(rc, 1)
        self.assertFalse(data['ok'])

    def test_m3_cw_home_environment_override(self):
        self.cw = self.root / 'custom data home'
        self.env['CW_HOME'] = str(self.cw)
        self.check_build(self.cw / 'extension', [])

    def test_m4_cw_home_environment_override(self):
        self.cw = self.root / 'custom data home'
        self.env['CW_HOME'] = str(self.cw)
        self.apply('cursor')
        self.assertEqual(json.loads(self.target('cursor').read_text())['mcpServers']['tasklight'],
                         self.entry('cursor'))


# Parameterized cases remain individually visible to unittest and ORACLE.md.
def preview_case(client, platform):
    def test(self):
        before = self.snapshot()
        rc, data = self.invoke('mcp-config', '--client', client, '--room', 'demo',
                               '--json', platform=platform)
        self.assertEqual(rc, 0)
        self.assert_restart(data, client)
        if client == 'claude-code':
            expected = ['claude', 'mcp', 'add', 'tasklight', '--scope', 'user', '-e',
                        'CW_HOME=' + str(self.cw), '--', sys.executable,
                        str(REPO / 'bridge/room/mcp.py')]
            self.assertTrue(any(shlex.split(s) == expected for s in strings(data)))
        else:
            self.assertIn(str(self.target(client, platform)), list(strings(data)))
            if client != 'codex':
                key = 'servers' if client == 'vscode' else 'mcpServers'
                self.assertTrue(any(m.get(key, {}).get('tasklight') == self.entry(client)
                                    for m in mappings(data) if isinstance(m.get(key, {}), dict)),
                                'preview must include the exact client config snippet')
            else:
                self.assertTrue(any('[mcp_servers.tasklight]' in t and
                                    '[mcp_servers.tasklight.env]' in t for t in strings(data)))
            flat = '\n'.join(strings(data))
            for value in (sys.executable, str(REPO / 'bridge/room/mcp.py'), str(self.cw)):
                self.assertIn(value, flat)
        self.assertEqual(self.snapshot(), before)
    return test


def json_apply_case(client, platform):
    def test(self):
        target = self.target(client, platform)
        key = 'servers' if client == 'vscode' else 'mcpServers'
        self.apply(client, platform)
        self.assertEqual(json.loads(target.read_text())[key]['tasklight'], self.entry(client))
        before = self.snapshot()
        self.apply(client, platform)
        self.assertEqual(self.snapshot(), before, 'identical entry must not write or back up')
    return test


def merge_case(client, mode):
    def test(self):
        target = self.target(client)
        target.parent.mkdir(parents=True)
        key = 'servers' if client == 'vscode' else 'mcpServers'
        old = {'theme': 'keep', key: {'other': {'command': 'keep'}}}
        if mode in ('conflict', 'force'):
            old[key]['tasklight'] = {'command': 'different'}
        raw = '{broken' if mode == 'malformed' else json.dumps(old)
        target.write_text(raw)
        before = self.snapshot()
        if mode in ('conflict', 'malformed'):
            rc, data = self.invoke('mcp-config', '--client', client, '--apply', '--json')
            self.assertEqual(rc, 1)
            self.assertFalse(data['ok'])
            if mode == 'conflict':
                self.assertEqual(data['error'], 'exists_different')
            self.assertEqual(self.snapshot(), before)
        else:
            with patch.object(os, 'replace', wraps=os.replace) as replace:
                self.apply(client, force=(mode == 'force'))
            self.assertTrue(replace.called, 'client writes must be atomic')
            actual = json.loads(target.read_text())
            self.assertEqual(actual['theme'], 'keep')
            self.assertEqual(actual[key]['other'], {'command': 'keep'})
            self.assertEqual(actual[key]['tasklight'], self.entry(client))
            backups = list(target.parent.glob(target.name + '.bak-*'))
            self.assertEqual(len(backups), 1)
            self.assertRegex(backups[0].name, r'\.bak-\d{14}$')
            self.assertEqual(backups[0].read_text(), raw)
    return test


def invalid_case(args):
    def test(self):
        before = self.snapshot()
        rc, data = self.invoke(*args, '--json')
        self.assertEqual(rc, 2)
        self.assertFalse(data.get('ok', False))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.snapshot(), before)
    return test


def bad_key_case(key):
    def test(self):
        # Mutate only the read result, never a repository manifest.
        actual_read = io.open
        def read(file, mode='r', *args, **kwargs):
            if not isinstance(file, int) and Path(file).resolve() == REPO / 'extension/manifest.dev.json':
                with actual_read(file, 'r', encoding='utf-8') as source:
                    value = json.load(source)
                if key is None:
                    value.pop('key', None)
                else:
                    value['key'] = key
                text = json.dumps(value)
                return io.BytesIO(text.encode()) if 'b' in mode else io.StringIO(text)
            return actual_read(file, mode, *args, **kwargs)
        with patch.object(io, 'open', side_effect=read), patch.object(builtins, 'open', side_effect=read):
            rc, data = self.invoke('extension-id', '--json')
        self.assertEqual(rc, 1)
        self.assertEqual(data, {'ok': False, 'error': 'invalid_key'})
    return test


def codex_platform_case(platform):
    def test(self):
        self.apply('codex', platform)
        self.assert_codex(self.target('codex', platform).read_text())
        before = self.snapshot()
        self.apply('codex', platform)
        self.assertEqual(self.snapshot(), before)
    return test


def browser_case(platform, browser):
    def test(self):
        rc, _ = self.invoke('--browser', browser, '--extension-id', DEV_ID,
                            '--room', 'demo:private', '--apply', platform=platform, module=install)
        self.assertEqual(rc, 0)
        dest = self.cw / 'extension'
        dest.mkdir(parents=True)
        shutil.copyfile(REPO / 'extension/manifest.dev.json', dest / 'manifest.json')
        rc, data = self.invoke('doctor', '--browser', browser, '--json', platform=platform)
        native = next(c for c in data['checks'] if c['id'] == 'native_host')
        self.assertEqual(native['status'], 'ok')
    return test


for _platform in PLATFORMS:
    setattr(SetupOracle, 'test_a2_codex_apply_' + _platform, codex_platform_case(_platform))
for _platform in ('linux', 'darwin'):
    for _browser in ('chrome', 'chromium', 'edge', 'brave'):
        setattr(SetupOracle, 'test_m5_native_' + _platform + '_' + _browser,
                browser_case(_platform, _browser))


for _client in CLIENTS:
    for _platform in PLATFORMS:
        setattr(SetupOracle, 'test_a2_preview_' + _client.replace('-', '_') + '_' + _platform,
                preview_case(_client, _platform))
for _client in ('claude-desktop', 'cursor', 'gemini', 'vscode'):
    for _platform in PLATFORMS:
        setattr(SetupOracle, 'test_a2_apply_' + _client.replace('-', '_') + '_' + _platform,
                json_apply_case(_client, _platform))
    for _mode in ('preserve', 'conflict', 'force', 'malformed'):
        setattr(SetupOracle, 'test_a2_' + _mode + '_' + _client.replace('-', '_'),
                merge_case(_client, _mode))
for _name, _args in {
    'unknown_verb': ['unknown'], 'missing_verb': [],
    'unknown_client': ['mcp-config', '--client', 'unknown'],
    'missing_client': ['mcp-config'],
    'bad_manifest': ['extension-id', '--manifest', 'unknown'],
    'missing_manifest_value': ['extension-id', '--manifest'],
    'forbidden_port': ['wall', '--port', '5998'],
    'nonnumeric_port': ['wall', '--port', 'no'],
    'unknown_flag': ['extension-id', '--unexpected'],
}.items():
    setattr(SetupOracle, 'test_m1_usage_' + _name, invalid_case(_args))
for _name, _key in {'missing': None, 'nonbase64': '!invalid!',
                    'empty': '', 'not_der': base64.b64encode(b'not a public key').decode()}.items():
    setattr(SetupOracle, 'test_a1_invalid_key_' + _name, bad_key_case(_key))


class InstallerAmendment(SetupOracle):
    # Only these tests run for this subclass; inherited setup helpers are reused.
    def test_a4_default_dry_run_states_dev_id(self):
        before = self.snapshot()
        rc, output = self.invoke(module=install)
        self.assertEqual(rc, 0)
        self.assertIn(DEV_ID, output)
        self.assertEqual(self.snapshot(), before)

    def test_a4_default_apply_uses_dev_origin(self):
        rc, output = self.invoke('--apply', '--room', 'demo:private', module=install)
        self.assertEqual(rc, 0, output)
        manifest = json.loads(self.native_manifest().read_text())
        self.assertEqual(manifest['allowed_origins'], ['chrome-extension://' + DEV_ID + '/'])


# Reuse fixtures without duplicating the CLI test methods in discovery.
for _name in tuple(dir(SetupOracle)):
    if _name.startswith('test_'):
        setattr(InstallerAmendment, _name, None)
