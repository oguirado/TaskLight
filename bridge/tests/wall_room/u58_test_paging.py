"""U58 paging oracle: page boundaries count consumed events, including drops."""
import unittest

from . import support as S
# A-R52LG: Share the checked-reader-compatible expansion fixture.
from .u58_test_op_redact import RelayHarness, op_event, POISON, residue, expanding, expanding_event


class Paging(RelayHarness):
    def page(self, since):
        self.send.clear()
        self.assertEqual(self.sync(since), 0)
        synced = self.send.of('room_synced')
        self.assertEqual(len(synced), 1)
        self.assertEqual(set(synced[0]), {'t', 'v', 'rid', 'room', 'upto', 'more'})
        self.assertEqual(synced[0]['rid'], 'u58')
        self.assertEqual(synced[0]['room'], 'demo')
        events = self.send.of('room_event')
        self.assertEqual(self.send.frames, events + synced)
        for event in events:
            self.assertEqual(set(event), {'t', 'v', 'room', 'floor', 'event', 'rid'})
            self.assertEqual(event['rid'], 'u58')
            self.assertEqual(event['floor'], 'PREFER_ON_DEVICE')
        return [f['event']['lamport'] for f in events], synced[0]

    def walk(self, count):
        self.events[:] = [op_event(i) for i in range(1, count + 1)]
        received, pages, since = [], [], 0
        with S.patched_redact(S.identity_redact):
            # Bounded even when a broken implementation never advances its cursor.
            for _ in range(4):
                ids, synced = self.page(since)
                received.extend(ids)
                pages.append((len(ids), synced['upto'], synced['more']))
                if not synced['more']:
                    break
                self.assertGreater(synced['upto'], since)
                since = synced['upto']
            else:
                self.fail('bounded replay did not terminate')
        self.assertEqual(received, list(range(1, count + 1)))
        self.assertEqual(len(received), len(set(received)))
        self.assertEqual(self.r.stats()['events_sent'], count)
        return pages

    def test_o7_1250_operations_three_pages(self):
        self.assertEqual(self.walk(1250), [(500, 500, True), (500, 1000, True), (250, 1250, False)])

    def test_o8_exactly_500_is_terminal(self):
        self.assertEqual(self.walk(500), [(500, 500, False)])

    def test_o8_501_requires_second_page(self):
        self.assertEqual(self.walk(501), [(500, 500, True), (1, 501, False)])

    def test_empty_page_preserves_since(self):
        with S.patched_redact(S.identity_redact):
            ids, synced = self.page(77)
        self.assertEqual(ids, [])
        self.assertEqual(synced['upto'], 77)
        self.assertIs(synced['more'], False)
        self.assertEqual(self.r.stats()['events_sent'], 0)

    def test_o9_mixed_room_residue_and_oversize_at_boundary(self):
        self.events[:] = [op_event(i) if i % 2 else S.event(i, act='heartbeat')
                         for i in range(1, 601)]
        # A-R52LG: Checked reads accept the boundary rows with microtask text.
        self.events[499] = op_event(500)
        self.events[499]['op']['microtasks'] = [{'text': POISON}]
        self.events[500] = expanding_event(501)
        def redactor(text, _disable=frozenset()):
            if POISON in text or 'U58_RESIDUE' in text:
                return residue(text)
            return expanding(text)
        with S.patched_redact(redactor):
            first, s1 = self.page(0)
            second, s2 = self.page(s1['upto'])
        self.assertEqual(first, list(range(1, 500)))
        self.assertEqual(second, list(range(502, 601)))
        self.assertEqual((s1['upto'], s1['more']), (500, True))
        self.assertEqual((s2['upto'], s2['more']), (600, False))
        self.assertEqual(len(set(first + second)), 598)
        self.assertEqual(self.r.stats(), {'events_sent': 598, 'dropped_residue': 1,
            'dropped_oversize': 1, 'posts_acked': 0, 'posts_refused': 0, 'structural': 0})

    def test_o10_first_page_all_dropped_still_advances(self):
        self.events[:] = [op_event(i) for i in range(1, 551)]
        # A-R52LG: Place the residue marker in a valid operation field.
        for event in self.events[:500]:
            event['op']['microtasks'] = [{'text': POISON}]
        with S.patched_redact(residue):
            first, s1 = self.page(0)
            second, s2 = self.page(s1['upto'])
        self.assertEqual(first, [])
        self.assertEqual((s1['upto'], s1['more']), (500, True))
        self.assertEqual(second, list(range(501, 551)))
        self.assertEqual((s2['upto'], s2['more']), (550, False))
        self.assertEqual(self.r.stats()['events_sent'], 50)
        self.assertEqual(self.r.stats()['dropped_residue'], 500)
        self.assertEqual(self.r.stats()['dropped_oversize'], 0)

    def test_o11_send_exception_tenth_event_no_synced_retry_recovers(self):
        self.events[:] = [op_event(i) for i in range(1, 601)]
        calls = []
        def send(frame):
            calls.append(frame)
            if frame['t'] == 'room_event' and len(calls) == 10:
                raise RuntimeError('planted transport failure')
            self.send(frame)
        from bridge.wall.room_relay import RoomRelay
        self.r = RoomRelay(self.rcfg, send, home=S.REPO, clock=S.Clock())
        with S.patched_redact(S.identity_redact):
            self.assertEqual(self.r._handle_sync(
                {'t': 'room_sync', 'v': 1, 'rid': 'u58', 'since': {'demo': 0}}), 0)
            # A-C5b-O11: SPEC_C5b M2 sends one room_sync_error after a relay-side failure.
            self.assertEqual(len(calls), 11)
            self.assertEqual({k: calls[-1].get(k) for k in ('t', 'room', 'code')},
                             {'t': 'room_sync_error', 'room': 'demo', 'code': 'room_sync_failed'})
            self.assertEqual(len(self.send.of('room_event')), 9)
            self.assertEqual(self.send.of('room_synced'), [])
            self.assertEqual(self.r.stats()['events_sent'], 9)
            first, s1 = self.page(0)
            second, s2 = self.page(s1['upto'])
        self.assertEqual(first + second, list(range(1, 601)))
        self.assertEqual((s1['upto'], s1['more']), (500, True))
        self.assertEqual((s2['upto'], s2['more']), (600, False))
