"""A7 change-driven waits, fake monotonic deadlines, and all store predicates."""
from unittest import mock

from bridge.room import store
from .support import (Clock, OracleCase, WorkMeter, encoded, event, fake_time,
                      footprint, full_read, project, result)


class WaitOracle(OracleCase):
    def unchanged_wait(self, run):
        self.seed([event(1)])
        marks = []
        with WorkMeter(self.path) as work:
            clock = Clock(lambda _: marks.append(work.snapshot()))
            with fake_time(clock):
                value = run()
        self.assertTrue(marks, 'fixture must exercise sleeping')
        self.assertGreater(marks[0][1], 0, 'initial payload parse must be observed')
        self.assertEqual(work.snapshot(), marks[0],
                         'unchanged metadata must not reread payload or reparse records')
        self.assertTrue(all(mark == marks[0] for mark in marks))
        return value, clock

    def test_a7_room_events_unchanged_parses_initial_view_only(self):
        value, clock = self.unchanged_wait(lambda: self.request(
            after_lamport=1, acts=['question'], wait_ms=200))
        self.assertEqual(value, result([], 1, 1))
        self.assertAlmostEqual(clock.now, 0.2)

    def test_a7_store_wait_unchanged_parses_initial_view_only(self):
        value, clock = self.unchanged_wait(lambda: store.wait(
            'demo', 1, to='exec-a', timeout_s=0.2, poll_s=0.05, home=self.home))
        self.assertIsNone(value)
        self.assertAlmostEqual(clock.now, 0.2)

    def test_a7_room_events_nonmatch_then_addressed_question(self):
        self.seed([event(1)])
        def changes(n):
            if n == 1:
                self.append(encoded([event(2)]))
            elif n == 2:
                self.append(encoded([event(3, agent='harness', act='question', to='exec-a')]))
        clock = Clock(changes)
        with fake_time(clock):
            actual = self.request(after_lamport=1, acts=['question'], wait_ms=1000)
        self.assertEqual(actual, result(project([event(3, agent='harness', act='question', to='exec-a')]), 3, 3))
        self.assertEqual(len(clock.sleeps), 2)

    def test_a7_store_wait_nonmatch_then_all_predicates_match(self):
        self.seed([event(1)])
        match = event(6, agent='harness', act='question', to='exec-a')
        def changes(n):
            if n == 1:
                self.append(encoded([event(2, agent='harness', to='exec-a'),
                    event(3, agent='other', act='question', to='exec-a'),
                    event(4, agent='reader', act='question', to='exec-a'),
                    event(5, agent='harness', act='question', to='other')]))
            elif n == 2:
                self.append(encoded([match]))
        clock = Clock(changes)
        with fake_time(clock):
            actual = store.wait('demo', 1, act='question', agent='harness',
                                exclude_agent='reader', to='exec-a', timeout_s=1,
                                poll_s=0.05, home=self.home)
        self.assertEqual(actual, match)
        self.assertEqual(len(clock.sleeps), 2)

    def test_m6_store_wait_exclude_agent_is_independent(self):
        self.seed([event(2, agent='reader', act='question', to='exec-a'),
                   event(3, agent='harness', act='question', to='exec-a')])
        clock = Clock()
        with fake_time(clock):
            actual = store.wait('demo', 1, act='question', exclude_agent='reader',
                                to='exec-a', timeout_s=1, home=self.home)
        self.assertEqual(actual['agent'], 'harness')
        self.assertEqual(clock.sleeps, [])

    def test_a7_filtered_timeout_reports_latest_valid_head(self):
        self.seed([event(1)])
        def changes(n):
            if n == 1:
                self.append(encoded([event(2)]))
            elif n == 2:
                self.append(b'{bad\n{"lamport":9999}\n')
        clock = Clock(changes)
        with fake_time(clock):
            actual = self.request(after_lamport=1, acts=['question'], wait_ms=200)
        self.assertEqual(actual, result([], 2, 2))
        self.assertAlmostEqual(clock.now, 0.2)

    def test_a7_store_wait_nonmatches_timeout_to_none(self):
        self.seed([event(1)])
        clock = Clock(lambda n: self.append(encoded([event(2)])) if n == 1 else None)
        with fake_time(clock):
            actual = store.wait('demo', 1, to='exec-a', timeout_s=0.2,
                                poll_s=0.05, home=self.home)
        self.assertIsNone(actual)

    def test_m6_room_events_wait_observes_newline_completion(self):
        wanted = event(2, act='question', to='exec-a')
        self.seed(raw=encoded([event(1)]) + encoded([wanted]).rstrip(b'\n'))
        clock = Clock(lambda n: self.append(b'\n') if n == 1 else None)
        with fake_time(clock):
            value = self.request(after_lamport=1, acts=['question'], wait_ms=200)
        self.assertEqual(value, result(project([wanted]), 2, 2))
        self.assertEqual(len(clock.sleeps), 1)

    def test_m6_store_wait_observes_newline_completion(self):
        wanted = event(2, act='question', to='exec-a')
        self.seed(raw=encoded([event(1)]) + encoded([wanted]).rstrip(b'\n'))
        clock = Clock(lambda n: self.append(b'\n') if n == 1 else None)
        with fake_time(clock):
            value = store.wait('demo', 1, to='exec-a', timeout_s=0.2,
                               poll_s=0.05, home=self.home)
        self.assertEqual(value, wanted)
        self.assertEqual(len(clock.sleeps), 1)

    def test_m6_waits_observe_replacement(self):
        wanted = event(2, act='question', to='exec-a')
        for api in ('events', 'wait'):
            with self.subTest(api=api):
                self.seed([event(1)])
                replacement = self.path.with_name('replacement.jsonl')
                replacement.write_bytes(encoded([wanted]))
                clock = Clock(lambda n: replacement.replace(self.path) if n == 1 else None)
                with fake_time(clock):
                    value = (self.request(after_lamport=1, acts=['question'], wait_ms=200)
                             if api == 'events' else store.wait('demo', 1, to='exec-a',
                             timeout_s=0.2, poll_s=0.05, home=self.home))
                self.assertEqual(value, result(project([wanted]), 2, 2) if api == 'events' else wanted)

    def test_m6_available_results_return_without_sleep(self):
        self.seed([event(1, act='question', to='exec-a')])
        clock = Clock()
        with fake_time(clock):
            self.assertEqual(self.request(acts=['question'], wait_ms=30000),
                             result(project([event(1, act='question', to='exec-a')]), 1, 1))
            self.assertEqual(store.wait('demo', 0, to='exec-a', timeout_s=30,
                                       home=self.home)['lamport'], 1)
        self.assertEqual(clock.sleeps, [])

    def test_m6_sub_poll_deadline_is_capped_monotonically(self):
        self.seed([event(1)])
        clock = Clock()
        with fake_time(clock):
            value = self.request(after_lamport=1, wait_ms=1)
        self.assertEqual(value, result([], 1, 1))
        self.assertAlmostEqual(clock.now, 0.001)
        self.assertAlmostEqual(sum(clock.sleeps), 0.001)

    def test_m7_missing_room_waits_create_nothing(self):
        before = footprint(self.home)
        self.assertEqual(store._read_all(self.home, 'demo'), ([], 0))
        self.assertEqual(store.read('demo', home=self.home), ([], 0))
        self.assertEqual(store.inbox('demo', 'exec-a', home=self.home), [])
        clock = Clock()
        with fake_time(clock):
            self.assertIsNone(store.wait('demo', 0, timeout_s=0.1, poll_s=0.05, home=self.home))
            self.assertEqual(self.request(acts=['question'], wait_ms=100), result([], 0, 0))
        self.assertEqual(footprint(self.home), before)
