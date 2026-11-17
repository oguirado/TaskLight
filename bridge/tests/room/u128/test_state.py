"""A8, captured-view races and read-only invariants; no cache API assumptions."""
import itertools
import os
from unittest import mock

from bridge.room import store
from .support import (Clock, OracleCase, WorkMeter, encoded, event, fake_time,
                      footprint, full_read, project, result)


class StateOracle(OracleCase):
    def test_a8_disordered_cold_and_reused_reader(self):
        self.seed([self.events[i] for i in (3, 0, 2, 1)])
        for _ in range(2):
            self.check_oracle(limit=2)
            self.check_oracle(after_lamport=2, limit=2)

    def test_m5_disorder_requires_historical_match_fallback(self):
        items = [event(2000), *[event(n, text='x' * 1024) for n in range(1, 900)]]
        self.seed(items)
        self.check_oracle(after_lamport=1999, limit=1)
        self.check_oracle(after_lamport=800, limit=100)

    def test_m5_sparse_filters_require_full_reader_results(self):
        self.seed([event(1, act='question'), *[event(n) for n in range(2, 900)]])
        for _ in range(2):
            self.check_oracle(acts=['question'], limit=1)
            self.check_oracle(acts=['question'], ops=[])

    def test_a8_replacement_invalidates_same_length_and_mtime(self):
        self.seed([event(1, text='old')])
        self.check_oracle()
        old = self.path.stat()
        replacement = self.path.with_name('replacement.jsonl')
        replacement.write_bytes(encoded([event(1, text='new')]))
        os.utime(replacement, ns=(old.st_atime_ns, old.st_mtime_ns))
        replacement.replace(self.path)
        self.assertEqual(self.path.stat().st_size, old.st_size)
        self.assertNotEqual(self.path.stat().st_ino, old.st_ino)
        self.check_oracle()

    def test_a8_truncation_invalidates_and_resyncs(self):
        self.seed([event(n) for n in range(1, 20)])
        self.check_oracle(after_lamport=18)
        self.seed([event(1)])
        self.assertEqual(self.check_oracle(after_lamport=18), result([], 1, 1, resync=True))
        self.seed(raw=b'')
        self.assertEqual(self.check_oracle(after_lamport=1), result([], 0, 0, resync=True))

    def test_a8_same_size_in_place_rewrite_invalidates(self):
        self.seed([event(1, text='old')])
        self.check_oracle()
        before = self.path.stat()
        self.seed([event(1, text='new')])
        os.utime(self.path, ns=(before.st_atime_ns, before.st_mtime_ns + 1))
        self.assertEqual(self.path.stat().st_size, before.st_size)
        self.assertEqual(self.path.stat().st_ino, before.st_ino)
        self.check_oracle()

    def test_b1_boundary_digest_invalidates_unchanged_stat_tuple(self):
        old_event = event(1)
        old_event.pop('text')
        old_event['text'] = 'old'
        data = self.seed([old_event])
        self.check_oracle()
        before = self.path.stat()
        changed = data.replace(b'"text":"old"', b'"text":"new"')
        self.assertNotEqual(changed[-64:], data[-64:])
        self.seed(raw=changed)
        os.utime(self.path, ns=(before.st_atime_ns, before.st_mtime_ns))
        after = self.path.stat()
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns')
        self.assertEqual(tuple(getattr(before, k) for k in fields), tuple(getattr(after, k) for k in fields))
        self.check_oracle()

    def test_a8_storage_home_and_room_isolation(self):
        self.seed([event(1, text='first')])
        self.check_oracle()
        other_home = self.home.parent / 'other-home'
        self.seed([event(7, text='other')], path=other_home / 'rooms/demo/events.jsonl')
        self.seed([event(9, room='other', text='other-room')], path=self.home / 'rooms/other/events.jsonl')
        for _ in range(2):
            with mock.patch.dict(os.environ, {'CW_HOME': str(other_home)}):
                self.assertEqual(self.request(), result(project([event(7, text='other')]), 7, 7))
            self.check_oracle()
            self.check_oracle(room='other')

    def test_m3_foreign_records_cannot_raise_requested_room_head(self):
        self.seed([event(1), event(999, room='other')])
        self.assertEqual(self.request(), result(project([event(1)]), 1, 1))

    def test_b4_equal_lamport_boundary_preserves_stable_legacy_cursor(self):
        items = [event(1), dict(event(3), lamport=2, text='first equal'),
                 dict(event(2), lamport=2, text='second equal'), event(4)]
        self.seed(items)
        for _ in range(2):
            self.assertEqual(self.request(limit=2), result(project(items[:2]), 2, 4, True))
            # Scalar cursor is strictly greater, so remaining equals are skipped by design.
            self.assertEqual(self.request(after_lamport=2, limit=1), result(project([items[3]]), 4, 4))

    def test_b4_mid_parse_append_produces_one_complete_view(self):
        before = self.seed([event(n) for n in range(1, 5)])
        addition = encoded([dict(event(5), lamport=1, text='late equal'), event(6)])
        def append_once(n):
            if n == 1:
                self.append(addition)
        with WorkMeter(self.path, on_decode=append_once) as meter:
            actual = self.request(limit=2)
        self.assertGreater(meter.records, 0)
        self.assertEqual(self.path.read_bytes(), before + addition)
        self.assertIn(actual, [full_read(before, limit=2), full_read(before + addition, limit=2)],
                      'head and page must come from one captured view')
        self.check_oracle(after_lamport=4)

    def test_b4_mid_parse_replacement_produces_one_complete_view(self):
        before = self.seed([event(1), event(2)])
        after = encoded([event(3), event(4)])
        replacement = self.path.with_name('replacement.jsonl')
        replacement.write_bytes(after)
        def replace_once(n):
            if n == 1:
                replacement.replace(self.path)
        with WorkMeter(self.path, on_decode=replace_once):
            actual = self.request(limit=1)
        self.assertEqual(self.path.read_bytes(), after)
        self.assertIn(actual, [full_read(before, limit=1), full_read(after, limit=1)])
        self.check_oracle()

    def test_m7_all_read_surfaces_preserve_torn_bytes_and_take_no_writer_lock(self):
        self.seed(raw=encoded([event(1), event(2, act='question', to='exec-a')]) + b'{torn')
        before = footprint(self.home)
        with mock.patch.object(store._lock, 'lock_exclusive',
                               side_effect=AssertionError('reader acquired writer lock')), \
             mock.patch.object(store.fcntl, 'flock',
                               side_effect=AssertionError('reader acquired writer lock')):
            rows, malformed = store._read_all(self.home, 'demo')
            self.assertEqual(malformed, 0)
            self.assertEqual(rows, [event(1), event(2, act='question', to='exec-a')])
            self.assertEqual(store.read('demo', 1, home=self.home), ([rows[1]], 0))
            self.assertEqual(store.inbox('demo', 'exec-a', home=self.home), [rows[1]])
            self.request(after_lamport=2)
            with fake_time(Clock()):
                self.assertIsNone(store.wait('demo', 2, timeout_s=0.1, poll_s=0.05, home=self.home))
        self.assertEqual(footprint(self.home), before)

    def test_m7_no_persistent_index_or_sidecar(self):
        self.seed([event(n) for n in range(1, 900)])
        before = footprint(self.home)
        self.request(after_lamport=890)
        self.request(after_lamport=890)
        self.assertEqual(footprint(self.home), before)

    def test_m3_differential_grid_cold_and_reused(self):
        items = [event(1), event(2, act='question'), event(3), event(4, act='handoff')]
        for order in itertools.permutations(items):
            self.seed(order)
            for cursor in (0, 1, 2, 4, 9):
                for filters in ({}, {'acts': ['heartbeat', 'question']}, {'ops': []}):
                    with self.subTest(order=[e['id'] for e in order], cursor=cursor, filters=filters):
                        self.check_oracle(after_lamport=cursor, limit=2, **filters)
                        self.check_oracle(after_lamport=cursor, limit=2, **filters)

    def test_a8_resolved_home_alias_follows_changed_target(self):
        first = self.home.parent / 'first-home'
        second = self.home.parent / 'second-home'
        alias = self.home.parent / 'home-alias'
        self.seed([event(1, text='first')], path=first / 'rooms/demo/events.jsonl')
        self.seed([event(1, text='other')], path=second / 'rooms/demo/events.jsonl')
        alias.symlink_to(first, target_is_directory=True)
        with mock.patch.dict(os.environ, {'CW_HOME': str(alias)}):
            self.assertEqual(self.request(), result(project([event(1, text='first')]), 1, 1))
            alias.unlink()
            alias.symlink_to(second, target_is_directory=True)
            self.assertEqual(self.request(), result(project([event(1, text='other')]), 1, 1))
