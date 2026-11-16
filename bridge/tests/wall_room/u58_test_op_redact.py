"""U58 fail-first oracle. All store I/O is replaced by bounded in-memory data."""
import contextlib
import copy
import io
import json
import unittest
from unittest import mock

from bridge.wall import room_relay as relay
from . import support as S

HOME = str(S.REPO / '.unit' / 'u58-in-memory-home')  # Never created or accessed.
KINDS = ('plan.open', 'plan.close', 'plan.phase', 'task.add', 'task.set',
         'task.claim', 'task.release', 'micro.add', 'micro.set', 'memory.set')
POISON = 'U58_POISON'
EXPAND = 'U58_EXPAND'


def op_event(lamport=1, **fields):
    payload = {'kind': 'task.add', 'title': 'clean', 'op_id': 'oracle_0001'}
    return S.event(lamport, act='op', op=payload, **fields)


def frame(event, replay=False, floor='PREFER_ON_DEVICE'):
    result = {'t': 'room_event', 'v': 1, 'room': 'demo', 'floor': floor, 'event': event}
    if replay:
        result['rid'] = 'u58'
    return result


def residue(text, _disable=frozenset()):
    if POISON in text:
        return text.replace(POISON, 'U58_RESIDUE'), 1, ['KEY_ASSIGN']
    if 'U58_RESIDUE' in text:
        return text, 1, ['KEY_ASSIGN']
    return text, 0, []


def expanding(text, _disable=frozenset()):
    return text.replace(EXPAND, 'M' * 1024), text.count(EXPAND), []


def faulty(mode):
    def redact(text, _disable=frozenset()):
        if POISON in text:
            if mode == 'raise':
                raise RuntimeError('planted U58 redactor fault')
            return 42, 0, []
        return text, 0, []
    return redact


class RelayHarness(unittest.TestCase):
    """Fake only the store boundary, not sanitize_event or relay transport logic."""
    def setUp(self):
        self.events = []
        self.reads = []
        def read(room, since=0, *, home=None):
            self.reads.append((room, since))
            # Deliberately reverse storage order; replay must sort by lamport.
            return [e for e in reversed(self.events)
                    if e['room'] == room and e['lamport'] > since], 0
        patch = mock.patch.object(relay.store, 'read', side_effect=read)
        patch.start()
        self.addCleanup(patch.stop)
        self.send = S.Frames()
        self.rcfg = relay.load_room_config(S.rcfg_dict(rooms=(('demo', 'standard'),)))
        self.assertIsNotNone(self.rcfg)
        self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
        self.r.prime()

    def sync(self, since=0):
        return self.r.handle({'t': 'room_sync', 'v': 1, 'rid': 'u58', 'since': {'demo': since}})

    def assert_drop(self, event, redactor, counter='dropped_residue'):
        """Exercise independent live/replay paths, then prove live progress by rereading."""
        for mode in ('poll', 'sync'):
            with self.subTest(mode=mode), S.patched_redact(redactor):
                self.events[:] = [event]
                self.send.clear()
                self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
                result = self.r.poll() if mode == 'poll' else self.sync()
                self.assertEqual(result, 0)
                self.assertEqual(self.send.of('room_event'), [])
                self.assertEqual(self.r.stats()[counter], 1)
                self.assertEqual(self.r.stats()['events_sent'], 0)
                if mode == 'sync':
                    self.assertEqual(self.send.of('room_synced'), [
                        {'t': 'room_synced', 'v': 1, 'rid': 'u58', 'room': 'demo',
                         'upto': event['lamport'], 'more': False}])
                    self.events.append(op_event(event['lamport'] + 1))
                    self.send.clear()
                    self.assertEqual(self.sync(event['lamport']), 0)
                    self.assertEqual([f['event']['lamport'] for f in self.send.of('room_event')],
                                     [event['lamport'] + 1])
                    self.assertEqual(self.r.stats()[counter], 1)
                else:
                    # Same poison remains in the store, followed by a clean event.
                    self.events.append(op_event(event['lamport'] + 1))
                    self.assertEqual(self.r.poll(), 1)
                    self.assertEqual(self.reads[-1], ('demo', event['lamport']))
                    self.assertEqual(self.r.poll(), 0)
                    self.assertEqual(self.r.stats()[counter], 1)
                    self.assertEqual([f['event']['lamport'] for f in self.send.of('room_event')],
                                     [event['lamport'] + 1])


class OpRedaction(RelayHarness):
    def test_o1_all_positions_real_redactor_live_and_replay(self):
        secret = S.FAKE_SECRET
        event = op_event(text=secret,
            evidence=[{'path': '/fixture/' + secret, 'sha256': 'a' * 64}],
            plan={'title': secret, 'steps': [{'text': secret, 'accept': secret}]},
            step={'index': 0, 'state': 'done', 'outcome': secret, 'took': secret})
        event['op'].update({name: secret for name in ('title', 'text', 'accept', 'outcome', 'took')})
        event['op'].update(brief={'nested': {'body': secret}},
                           microtasks=[{'title': secret, 'accept': secret}],
                           nested=[{'a': [{'b': secret}]}],
                           evidence=[{'path': secret}], op_id=secret, template_hash=secret)
        event['op'][secret] = {'nested': secret}
        before = copy.deepcopy(event)
        with S.patched_redact(S.emit_mod().redact):
            clean = relay.sanitize_event(event)
            with self.subTest(path='sanitize'):
                self.assertIsNotNone(clean)
                self.assertNotIn(S.FAKE_VALUE, repr(clean))
                self.assertEqual(event, before)
            # Every planted string (including keys and identifiers) must be masked.
            def strings(obj):
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        yield k
                        yield from strings(v)
                elif isinstance(obj, list):
                    for v in obj:
                        yield from strings(v)
                elif isinstance(obj, str):
                    yield obj
            with self.subTest(path='operation-masking'):
                self.assertIsNotNone(clean)
                self.assertTrue(any('[REDACTED:' in s for s in strings(clean['op'])))
            for mode in ('poll', 'sync'):
                with self.subTest(mode=mode):
                    self.events[:] = [event]
                    self.send.clear()
                    self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
                    self.assertEqual(self.r.poll() if mode == 'poll' else self.sync(),
                                     1 if mode == 'poll' else 0)
                    self.assertNotIn(S.FAKE_VALUE, repr(self.send.frames))
                    self.assertEqual(self.send.of('room_event'), [frame(clean, mode == 'sync')])
                    self.assertEqual(self.r.stats()['events_sent'], 1)
                    self.assertEqual(event, before)

    def test_o1_each_operation_kind_and_json_scalars(self):
        values = [None, True, False, 0, -7, 1.25, 'héllo', [], {}]
        for kind in KINDS:
            with self.subTest(kind=kind):
                event = op_event()
                event['op'] = {'kind': kind, 'values': copy.deepcopy(values)}
                before = copy.deepcopy(event)
                with S.patched_redact(S.identity_redact):
                    clean = relay.sanitize_event(event)
                self.assertEqual(clean, before)
                self.assertIsNot(clean, event)
                self.assertIsNot(clean['op'], event['op'])
                for actual, expected in zip(clean['op']['values'], values):
                    self.assertIs(type(actual), type(expected))
                self.assertEqual(event, before)

    def test_o1_operation_on_legacy_act_is_also_redacted(self):
        event = op_event()
        event['act'] = 'heartbeat'
        event['op']['brief'] = S.FAKE_SECRET
        clean = relay.sanitize_event(event)
        self.assertIsNotNone(clean)
        self.assertNotIn(S.FAKE_VALUE, repr(clean))

    def test_o2_nested_value_residue_sanitize(self):
        event = op_event()
        event['op']['brief'] = [{'text': POISON}]
        with S.patched_redact(residue):
            self.assertIsNone(relay.sanitize_event(event))

    def test_o2_key_residue_sanitize(self):
        event = op_event()
        event['op']['brief'] = {POISON: 'clean'}
        with S.patched_redact(residue):
            self.assertIsNone(relay.sanitize_event(event))

    def test_o2_nested_value_residue_live_and_sync(self):
        event = op_event()
        event['op']['brief'] = [{'text': POISON}]
        self.assert_drop(event, residue)

    def test_o2_nested_key_residue_live_and_sync(self):
        event = op_event()
        event['op']['brief'] = {POISON: 'clean'}
        self.assert_drop(event, residue)

    def test_o3_redactor_exception_sanitize(self):
        event = op_event()
        event['op']['title'] = POISON
        with S.patched_redact(faulty('raise')):
            self.assertIsNone(relay.sanitize_event(event))

    def test_o3_bad_redactor_return_sanitize(self):
        event = op_event()
        event['op']['title'] = POISON
        with S.patched_redact(faulty('bad')):
            self.assertIsNone(relay.sanitize_event(event))

    def test_o3_redactor_exception_live_and_sync(self):
        event = op_event()
        event['op']['title'] = POISON
        self.assert_drop(event, faulty('raise'))

    def test_o3_bad_redactor_return_live_and_sync(self):
        event = op_event()
        event['op']['title'] = POISON
        self.assert_drop(event, faulty('bad'))

    def test_o4_redaction_expands_past_frame_cap_live_and_sync(self):
        event = op_event()
        event['op']['brief'] = EXPAND * 80
        for replay in (False, True):
            self.assertLessEqual(len(json.dumps(frame(event, replay), ensure_ascii=False).encode()), 65536)
            expanded = copy.deepcopy(event)
            expanded['op']['brief'] = 'M' * (1024 * 80)
            self.assertGreater(len(json.dumps(frame(expanded, replay), ensure_ascii=False).encode()), 65536)
        self.assert_drop(event, expanding, 'dropped_oversize')

    def test_o5_missing_operation(self):
        event = op_event()
        del event['op']
        self.assertIsNone(relay.sanitize_event(event))

    def test_o5_invalid_operation_containers(self):
        for value in (None, 'x', []):
            with self.subTest(value=value):
                event = op_event()
                event['op'] = value
                self.assertIsNone(relay.sanitize_event(event))

    def test_o5_legacy_act_with_invalid_operation(self):
        self.assertIsNone(relay.sanitize_event(S.event(1, act='heartbeat', op='bad')))

    def test_o5_non_json_values_and_keys(self):
        for value in ((1, 2), object(), {1, 2}, b'bytes', complex(1, 2), {1: 'bad key'}):
            with self.subTest(type=type(value).__name__):
                event = op_event()
                event['op']['brief'] = value
                self.assertIsNone(relay.sanitize_event(event))

    def test_o5_excessive_mixed_container_depth(self):
        payload = 'leaf'
        for _ in range(40):
            payload = [payload] if isinstance(payload, dict) else {'nested': payload}
        event = op_event()
        event['op']['brief'] = payload
        self.assertIsNone(relay.sanitize_event(event))

    def test_o5_redacted_key_collision(self):
        event = op_event()
        event['op']['brief'] = {'secret-a': 1, 'secret-b': 2}
        def collide(text, _disable=frozenset()):
            return ('masked', 1, []) if text in ('secret-a', 'secret-b') else (text, 0, [])
        with S.patched_redact(collide):
            self.assertIsNone(relay.sanitize_event(event))

    def test_o5_noncolliding_keys_are_replaced(self):
        event = op_event()
        event['op']['brief'] = {'secret-a': 'clean'}
        def rename(text, _disable=frozenset()):
            return ('masked', 1, []) if text == 'secret-a' else (text, 0, [])
        with S.patched_redact(rename):
            clean = relay.sanitize_event(event)
        self.assertIsNotNone(clean)
        self.assertEqual(clean['op']['brief'], {'masked': 'clean'})
        self.assertEqual(event['op']['brief'], {'secret-a': 'clean'})

    def test_w0r18_copy_failure_sanitize(self):
        class Uncopyable:
            def __deepcopy__(self, memo):
                raise RuntimeError('planted copy failure')
        event = op_event()
        event['op']['brief'] = Uncopyable()
        self.assertIsNone(relay.sanitize_event(event))

    def test_w0r18_copy_failure_live_and_sync(self):
        class Uncopyable:
            def __deepcopy__(self, memo):
                raise RuntimeError('planted copy failure')
        event = op_event()
        event['op']['brief'] = Uncopyable()
        self.assert_drop(event, S.identity_redact)

    def test_w0r18_cycles(self):
        for container in ({}, []):
            with self.subTest(type=type(container).__name__):
                if isinstance(container, dict):
                    container['self'] = container
                else:
                    container.append(container)
                event = op_event()
                event['op']['brief'] = container
                self.assertIsNone(relay.sanitize_event(event))

    def test_w0r18_nonfinite_numbers(self):
        for number in (float('nan'), float('inf'), -float('inf')):
            with self.subTest(number=repr(number)):
                event = op_event()
                event['op']['brief'] = [number]
                self.assertIsNone(relay.sanitize_event(event))

    def test_w0r18_unencodable_string_never_reaches_send(self):
        event = op_event()
        event['op']['brief'] = '\ud800'
        # Serialization failures are drops; the spec does not assign a new counter.
        for mode in ('poll', 'sync'):
            with self.subTest(mode=mode), S.patched_redact(S.identity_redact):
                self.events[:] = [event]
                self.send.clear()
                self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
                self.assertEqual(self.r.poll() if mode == 'poll' else self.sync(), 0)
                self.assertEqual(self.send.of('room_event'), [])
                stats = self.r.stats()
                self.assertEqual(stats['dropped_residue'] + stats['dropped_oversize'], 1)

    def test_o6_private_operation_floor(self):
        cfg = relay.load_room_config(S.rcfg_dict())
        self.events[:] = [op_event()]
        for mode in ('poll', 'sync'):
            with self.subTest(mode=mode), S.patched_redact(S.identity_redact):
                self.send.clear()
                self.r = relay.RoomRelay(cfg, self.send, home=HOME, clock=S.Clock())
                self.r.poll() if mode == 'poll' else self.sync()
                self.assertEqual(self.send.of('room_event'),
                                 [frame(self.events[0], mode == 'sync', 'ONLY_ON_DEVICE')])

    def test_o6_legacy_golden_frames_and_stats(self):
        acts = ('open', 'plan', 'step', 'question', 'answer', 'handoff', 'ack',
                'heartbeat', 'verdict', 'close')
        self.events[:] = [S.event(i, act=act) for i, act in enumerate(acts, 1)]
        self.events[1]['plan'] = {'title': 'clean', 'steps': [{'text': 'step', 'accept': 'ok'}]}
        self.events[2]['step'].update(outcome='done', took='1m')
        self.events[3]['evidence'] = [{'path': '/fixture/file', 'sha256': 'a' * 64}]
        for mode in ('poll', 'sync'):
            with self.subTest(mode=mode), S.patched_redact(S.identity_redact):
                self.send.clear()
                self.r = relay.RoomRelay(self.rcfg, self.send, home=HOME, clock=S.Clock())
                self.r.poll() if mode == 'poll' else self.sync()
                expected = [frame(e, mode == 'sync') for e in self.events]
                if mode == 'sync':
                    expected.append({'t': 'room_synced', 'v': 1, 'rid': 'u58', 'room': 'demo',
                                     'upto': 10, 'more': False})
                self.assertEqual(json.dumps(self.send.frames, ensure_ascii=False).encode(),
                                 json.dumps(expected, ensure_ascii=False).encode())
                self.assertEqual(self.r.stats(), {'events_sent': 10, 'dropped_residue': 0,
                    'dropped_oversize': 0, 'posts_acked': 0, 'posts_refused': 0, 'structural': 0})

    def test_silent_hostile_public_calls(self):
        self.events[:] = [op_event()]
        self.events[0]['op']['brief'] = POISON
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                mock.patch('logging.Logger._log') as log, S.patched_redact(faulty('raise')):
            self.r.prime()
            self.r.poll()
            self.sync()
            self.r.handle({'t': 'room_sync', 'v': 1, 'rid': [], 'since': {}})
            self.r.stats()
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), '')
        log.assert_not_called()

    def test_o5_shallow_containers_and_legacy_null_operation(self):
        event = op_event()
        payload = 'leaf'
        for _ in range(8):
            payload = [payload] if isinstance(payload, dict) else {'nested': payload}
        event['op']['brief'] = payload
        with S.patched_redact(S.identity_redact):
            self.assertEqual(relay.sanitize_event(event), event)
            legacy = S.event(1, act='heartbeat', op=None)
            self.assertEqual(relay.sanitize_event(legacy), legacy)

    def test_w0r18_precopy_recursion_failure_is_closed(self):
        event = op_event()
        payload = 'leaf'
        for _ in range(1500):
            payload = [payload]
        event['op']['brief'] = payload
        self.assertIsNone(relay.sanitize_event(event))

    def test_w0r18_nonfinite_live_and_sync(self):
        event = op_event()
        event['op']['brief'] = float('inf')
        self.assert_drop(event, S.identity_redact)

    def test_o1_identifiers_and_hashes_have_no_exemption(self):
        seen = []
        def redact(text, _disable=frozenset()):
            seen.append(text)
            return text, 0, []
        event = op_event()
        event['op'].update(op_id='oracle_12345678', template_hash='b' * 64)
        with S.patched_redact(redact):
            self.assertIsNotNone(relay.sanitize_event(event))
        self.assertIn('oracle_12345678', seen)
        self.assertIn('b' * 64, seen)
        self.assertIn('kind', seen)
        self.assertIn('task.add', seen)
