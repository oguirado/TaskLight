"""Explicit expected states, not agreement between two implementations."""
import copy
import unittest
from bridge.plan import PlanError, apply_op_event, check_conformance, validate_op_shape
from .fold_probe import DATA


def at(value, dotted):
    for key in dotted.split('.'):
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


class FoldOracle(unittest.TestCase):
    def check_case(self, case):
        state = copy.deepcopy(DATA['fixtures'][case['fixture']])
        original = copy.deepcopy(state)
        event = copy.deepcopy(case['event'])
        event_before = copy.deepcopy(event)
        code, detail, after = None, None, None
        try:
            after, _ = apply_op_event(state, event)
        except PlanError as exc:
            code, detail = exc.code, str(exc)
        self.assertEqual(state, original, 'direct application mutated its input')
        self.assertEqual(event, event_before, 'direct application mutated the event')
        self.assertEqual(code, case['code'], 'wrong semantic decision (fixture/schema failures do not count)')
        if code is not None:
            self.assertIsInstance(detail, str)
            self.assertTrue(detail, 'step rejection requires detail')
            for token in case['contains']:
                self.assertIn(token.lower(), detail.lower())
            return
        self.assertIsNotNone(after)
        for path, expected in case['paths'].items():
            self.assertEqual(at(after, path), expected, path)
        for path in case['preserve']:
            self.assertEqual(at(after, path), at(original, path), path)
        for path in case['absent']:
            parent, key = path.rsplit('.', 1)
            self.assertIsNone(at(after, parent).get(key), path)

    def test_m1_conformance_remains_pure_and_does_not_enforce_authority(self):
        state = copy.deepcopy(DATA['fixtures']['unassigned'])
        template = {'phases': [{'id': 'start'}], 'task_types': [{'id': 'action'}]}
        before, tpl_before = copy.deepcopy(state), copy.deepcopy(template)
        check_conformance(state, template)
        self.assertEqual((state, template), (before, tpl_before))

    def test_a6_python_integral_float_is_bad_op(self):
        for kind in ('micro.set', 'task.release'):
            with self.subTest(kind=kind):
                op = ({'kind': kind, 'micro_id': 'T01.M01', 'state': 'pending'}
                      if kind == 'micro.set' else {'kind': kind, 'task_id': 'T01'})
                op['claim_lamport'] = 1.0
                try:
                    validate_op_shape(op)
                except PlanError as exc:
                    self.assertEqual(exc.code, 'bad_op')
                else:
                    self.fail('Python float is not an integer claim fence')


    def test_a4_retired_run_cannot_reappear_after_release_and_reclaim(self):
        state = copy.deepcopy(DATA['fixtures']['live'])
        for lamport, op in enumerate([
                {'kind': 'task.release', 'task_id': 'T01'},
                {'kind': 'task.claim', 'task_id': 'T01'},
                {'kind': 'micro.set', 'micro_id': 'T01.M01', 'state': 'active'},
                {'kind': 'activity.beat', 'task_id': 'T01', 'run_id': 'run-old', 'op_id': 'old-run-probe'}], 31):
            event = {'id': 'e-%016x' % lamport, 'lamport': lamport, 'ts': 1700000000000+lamport,
                     'room': 'demo', 'agent': 'alice', 'act': 'op', 'text': '', 'op': op}
            state, _ = apply_op_event(state, event)
        self.assertIsNone(state['tasks'][0]['microtasks'][0].get('live'))
        self.assertIsNone(state['tasks'][0].get('live'))



def generated(case):
    def test(self):
        self.check_case(case)
    test.__doc__ = case['acceptance'] + ': ' + case['name']
    return test


for _case in DATA['cases']:
    setattr(FoldOracle, 'test_' + _case['name'], generated(_case))


def valid_boundary(kind, n):
    def test(self):
        op = ({'kind': kind, 'micro_id': 'T01.M01', 'state': 'pending'}
              if kind == 'micro.set' else {'kind': kind, 'task_id': 'T01'})
        op['claim_lamport'] = n
        try:
            validated = validate_op_shape(op)
        except PlanError as exc:
            self.fail('valid fence rejected: ' + exc.code)
        self.assertEqual(validated['claim_lamport'], n)
    return test


for _kind in ('micro.set', 'task.release'):
    for _n in (1, 9007199254740991):
        setattr(FoldOracle, 'test_a6_validator_accepts_' + _kind.replace('.', '_') + '_' + str(_n), valid_boundary(_kind, _n))
