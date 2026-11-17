"""Amendment B work ceilings and discriminating negative controls.

Cold proof work is measured separately, never hidden in fixture setup. No wall
clock latency claim is made here; statistical benchmark admission is external.
"""
import time

from bridge.room import store
from .support import (Clock, OracleCase, WorkMeter, encoded, event, fake_time,
                      footprint, full_read, project)


class WorkOracle(OracleCase):
    def prepared_recent(self):
        self.seed([event(n, text='x' * 1024) for n in range(1, 901)])
        data = self.path.read_bytes()
        self.assertGreater(len(data), 524288)
        expected = full_read(data, after_lamport=890)
        with WorkMeter(self.path) as cold:
            value = self.request(after_lamport=890)
        self.assertEqual(value, expected)
        self.cold_work = cold.snapshot()
        # The call above is explicit cold work, not unobserved setup/cache priming.
        return expected

    def test_b1_warm_recent_suffix_parses_at_most_512_records(self):
        expected = self.prepared_recent()
        with WorkMeter(self.path) as warm:
            value = self.request(after_lamport=890)
        self.assertEqual(value, expected)
        self.assertLessEqual(warm.records, 512,
                             'recent monotonic suffix reparsed the full journal')

    def test_b1_warm_recent_suffix_reads_at_most_524288_bytes(self):
        expected = self.prepared_recent()
        with WorkMeter(self.path) as warm:
            value = self.request(after_lamport=890)
        self.assertEqual(value, expected)
        self.assertLessEqual(warm.bytes_read, 524288,
                             'recent monotonic suffix reread the full journal')

    def test_b1_recent_append_keeps_bounded_work_and_correctness(self):
        self.prepared_recent()
        self.append(encoded([event(901, text='x' * 1024)]))
        expected = full_read(self.path.read_bytes(), after_lamport=895)
        with WorkMeter(self.path) as changed:
            value = self.request(after_lamport=895)
        self.assertEqual(value, expected)
        self.assertLessEqual(changed.records, 512, 'append caused a full-journal reparse')
        self.assertLessEqual(changed.bytes_read, 524288, 'append caused a full-journal reread')

    def test_b1_warm_suffix_includes_malformed_parse_attempts(self):
        bad = b'{broken\n\xff\n{"lamport":9999}\n' * 5
        self.seed(raw=encoded([event(n, text='x' * 1024) for n in range(1, 891)])
                  + bad + encoded([event(n) for n in range(891, 901)]))
        expected = full_read(self.path.read_bytes(), after_lamport=890)
        with WorkMeter(self.path) as cold:
            self.assertEqual(self.request(after_lamport=890), expected)
        self.cold_work = cold.snapshot()
        with WorkMeter(self.path) as warm:
            value = self.request(after_lamport=890)
        self.assertEqual(value, expected)
        self.assertLessEqual(warm.records, 512, 'malformed decoding also consumes the parse budget')
        self.assertLessEqual(warm.bytes_read, 524288)

    def test_meter_observes_invalid_utf8_and_decoding_outside_read_all(self):
        self.seed([event(1)])
        data = encoded([event(1)]) + b'{broken\n\xff\n{"lamport":9999}\n'
        with WorkMeter(self.path) as meter:
            value = full_read(data)
        self.assertEqual(value['events'], project([event(1)]))
        self.assertEqual(value['head'], 1)
        self.assertEqual(meter.records, 4, 'invalid UTF-8 must count before JSON decoding')
        self.assertEqual(meter.bytes_read, 0, 'parser-only self-check must not invent I/O')

    def test_a9_old_projection_mutant_is_rejected(self):
        expected = project(self.events)
        mutant = [{k: v for k, v in e.items() if k not in ('to', 're')} for e in expected]
        with self.assertRaisesRegex(AssertionError, 'old projection'):
            self.assertEqual(mutant, expected, 'old projection loses addressing')

    def test_a9_last_lines_mutant_is_rejected(self):
        reordered = [self.events[i] for i in (3, 0, 2, 1)]
        expected = full_read(encoded(reordered), after_lamport=2)
        mutant = full_read(encoded(reordered[-2:]), after_lamport=2)
        with self.assertRaisesRegex(AssertionError, 'last-lines'):
            self.assertEqual(mutant, expected, 'last-lines reader misses reordered events')

    def test_a9_polling_reparse_mutant_is_rejected(self):
        self.seed([event(1)])
        marks = []
        with WorkMeter(self.path) as meter:
            clock = Clock(lambda _: marks.append(meter.snapshot()))
            with fake_time(clock):
                deadline = time.monotonic() + 0.2
                while True:
                    store._read_all(self.home, 'demo')
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.05)
        self.assertGreater(marks[0][1], 0)
        with self.assertRaisesRegex(AssertionError, 'unchanged metadata'):
            self.assertEqual(meter.snapshot(), marks[0],
                             'unchanged metadata must not reread payload or reparse records')

    def test_b4_read_only_mutant_is_rejected(self):
        self.seed(raw=encoded([event(1)]) + b'{torn')
        before = footprint(self.home)
        # A deliberately bad reader repairs a torn tail; the M7 gate must catch it.
        self.path.write_bytes(encoded([event(1)]))
        with self.assertRaisesRegex(AssertionError, 'journal mutated'):
            self.assertEqual(footprint(self.home), before, 'journal mutated by reader')
