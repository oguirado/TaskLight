"""Regression coverage for setup repair: all writes use disposable homes."""
import base64
import json
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

from bridge import tasklight_setup as setup
from bridge.tests.setup import test_setup as oracle


class RepairOracle(unittest.TestCase):
    # Reuse dependency injection without inheriting the original test cases.
    for _name in ('setUp', 'tick', 'which', 'fake_run', 'popen', 'probe',
                  'isolated', 'invoke', 'entry', 'target', 'snapshot'):
        locals()[_name] = getattr(oracle.SetupOracle, _name)

    def test_spki_rejects_garbage_and_inconsistent_der(self):
        manifest = json.loads((oracle.REPO / 'extension/manifest.dev.json').read_text())
        raw = base64.b64decode(manifest['key'])
        for bad in (b'x' * 32, raw + b'junk', raw[:-1],
                    b'\x30\x08\x30\x03\x06\x01\x2a\x03\x01\x08'):
            with self.subTest(key=bad[:8]):
                self.assertIsNone(setup._derive_id(base64.b64encode(bad).decode()))
        self.assertEqual(setup._derive_id(manifest['key']), oracle.DEV_ID)

    def test_json_null_conflicts_and_force_backs_up(self):
        for client in ('cursor', 'gemini', 'vscode', 'claude-desktop'):
            with self.subTest(client=client):
                target = self.target(client)
                target.parent.mkdir(parents=True, exist_ok=True)
                container = 'servers' if client == 'vscode' else 'mcpServers'
                prior = json.dumps({container: {'tasklight': None, 'other': {}}})
                target.write_text(prior)
                args = ('mcp-config', '--client', client, '--apply', '--json')
                rc, data = self.invoke(*args)
                self.assertEqual((rc, data.get('error')), (1, 'exists_different'))
                self.assertEqual(target.read_text(), prior)
                self.assertEqual(self.invoke(*args, '--force')[0], 0)
                self.assertEqual(json.loads(target.read_text())[container]['other'], {})
                self.assertEqual(next(target.parent.glob(target.name + '.bak-*')).read_text(), prior)

    def test_codex_all_spellings_detected_without_mutation(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        for prior in ('[mcp_servers."tasklight"]\ncommand="other"\n',
                      '[ mcp_servers . tasklight ]\ncommand="other"\n',
                      'mcp_servers.tasklight.command="other"\n',
                      'mcp_servers = { tasklight = { command = "other" } }\n'):
            with self.subTest(prior=prior):
                target.write_text(prior)
                rc, data = self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')
                self.assertEqual((rc, data.get('error')), (1, 'exists_different'))
                self.assertEqual(target.read_text(), prior)

    def test_codex_equal_quoted_and_dotted_entries_do_not_write(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        entry = self.entry('codex')
        variants = [
            '[ mcp_servers . "tasklight" ]\ncommand = ' + json.dumps(entry['command']) +
            '\nargs = ' + json.dumps(entry['args']) + '\n[mcp_servers."tasklight".env]\nCW_HOME = ' +
            json.dumps(str(self.cw)) + '\n',
            '\n'.join('mcp_servers.tasklight.' + key + ' = ' + json.dumps(value)
                      for key, value in (('command', entry['command']), ('args', entry['args']),
                                         ('env.CW_HOME', str(self.cw)))) + '\n']
        for prior in variants:
            target.write_text(prior)
            before = self.snapshot()
            rc, data = self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')
            self.assertEqual(rc, 0, data)
            self.assertEqual(self.snapshot(), before)

    def test_codex_fallback_refuses_uncertain_syntax(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        prior = 'mcp_servers = { tasklight = {command="other"} }\n'
        target.write_text(prior)
        with patch.dict(sys.modules, {'tomllib': None}):
            rc, data = self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')
        self.assertEqual((rc, data.get('error')), (1, 'codex_config_unparsed'))
        self.assertEqual(target.read_text(), prior)

    def test_codex_force_noncanonical_refuses_without_writes(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        for prior in ('[mcp_servers."tasklight"]\ncommand="other"\n',
                      'mcp_servers = { tasklight = { command = "other" } }\n',
                      'mcp_servers.tasklight.command = "other"\n'):
            target.write_text(prior)
            before = self.snapshot()
            rc, data = self.invoke('mcp-config', '--client', 'codex', '--apply', '--force', '--json')
            self.assertEqual((rc, data.get('error')), (1, 'codex_config_unrewritable'))
            self.assertEqual(self.snapshot(), before)

    def test_codex_equal_inline_and_fallback_canonical(self):
        target = self.target('codex')
        target.parent.mkdir(parents=True)
        entry = self.entry('codex')
        prior = ('mcp_servers = { tasklight = { command = ' + json.dumps(entry['command']) +
                 ', args = ' + json.dumps(entry['args']) + ', env = { CW_HOME = ' +
                 json.dumps(str(self.cw)) + ' } } }\n')
        target.write_text(prior)
        before = self.snapshot()
        self.assertEqual(self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')[0], 0)
        self.assertEqual(self.snapshot(), before)
        with self.isolated():
            target.write_text(setup._codex_snippet())
        before = self.snapshot()
        with patch.dict(sys.modules, {'tomllib': None}):
            self.assertEqual(self.invoke('mcp-config', '--client', 'codex', '--apply', '--json')[0], 0)
        self.assertEqual(self.snapshot(), before)

    def test_extension_id_invalid_manifest_key_json(self):
        with patch.object(setup, '_read_manifest_id', return_value=None):
            rc, data = self.invoke('extension-id', '--manifest', 'prod', '--json')
        self.assertEqual((rc, data), (1, {'ok': False, 'error': 'invalid_key'}))

    def test_claude_code_absent_warns(self):
        _, data = self.invoke('doctor', '--client', 'claude-code', '--json')
        check = next(c for c in data['checks'] if c['id'] == 'mcp_claude-code')
        self.assertEqual(check['status'], 'warn')
        self.assertEqual(check['fix'], 'install Claude Code or use another client')

    def test_claude_code_registration_is_verified(self):
        original_which, original_run = self.which, self.fake_run
        self.which = lambda name, *a, **kw: 'claude' if name == 'claude' else original_which(name, *a, **kw)
        for matches in (False, True):
            def run(command, *args, **kwargs):
                if command[:3] == ['claude', 'mcp', 'get']:
                    self.calls.append((command, kwargs))
                    entry = self.entry('claude-code') if matches else {'command': 'other', 'args': []}
                    return subprocess.CompletedProcess(command, 0, json.dumps(entry), '')
                return original_run(command, *args, **kwargs)
            self.fake_run = run
            _, data = self.invoke('doctor', '--client', 'claude-code', '--json')
            check = next(c for c in data['checks'] if c['id'] == 'mcp_claude-code')
            self.assertEqual(check['status'], 'ok' if matches else 'fail')
        self.assertTrue(any(cmd[:4] == ['claude', 'mcp', 'get', 'tasklight'] for cmd, _ in self.calls))

    def test_doctor_fixes_are_actions_or_commands(self):
        _, data = self.invoke('doctor', '--json')
        for check in data['checks']:
            if check['status'] != 'ok':
                self.assertNotIn('Run ', check['fix'])
                self.assertNotIn('re-run doctor', check['fix'])
                self.assertNotIn(' or ', check['fix'])

    def test_wall_readiness_failure_reaps_stubborn_child(self):
        self.http_status = 503
        self.process.terminate = lambda: None
        waits = []
        def wait(timeout=None):
            waits.append(timeout)
            if self.process.returncode is None:
                raise subprocess.TimeoutExpired('node', timeout)
            return self.process.returncode
        self.process.wait = wait
        self.assertEqual(self.invoke('wall', '--json')[0], 1)
        self.assertIsNotNone(self.process.returncode)
        self.assertTrue(waits)
        self.assertTrue(all(timeout is not None for timeout in waits))

    def test_wall_signals_restore_handlers_and_emit_once(self):
        for signum in (signal.SIGINT, signal.SIGTERM):
            handlers = {}
            previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
            def register(sig, handler):
                handlers[sig] = handler
            def wait(timeout=None):
                if timeout is None:
                    handlers[signum](signum, None)
                return self.process.returncode
            self.process.returncode = None
            self.process.wait = wait
            with patch.object(signal, 'signal', side_effect=register):
                rc, data = self.invoke('wall', '--json')
            self.assertTrue(data['ok'])
            self.assertEqual(rc, 0)
            self.assertIsNotNone(self.process.returncode)
            self.assertEqual(handlers, previous)

    def test_wall_wait_error_does_not_emit_second_object(self):
        def wait(timeout=None):
            if timeout is None:
                raise OSError('wait failed')
            return self.process.returncode
        self.process.wait = wait
        rc, data = self.invoke('wall', '--json')
        self.assertTrue(data['ok'])
        self.assertEqual(rc, 1)
        self.assertIsNotNone(self.process.returncode)
