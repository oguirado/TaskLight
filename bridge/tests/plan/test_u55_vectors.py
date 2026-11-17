import copy
import json
import unittest
from bridge.plan.fold import fold_plan
from .support import BASE_TS, FIXTURES, event, template


class VectorOracle(unittest.TestCase):
    pass


def install(case):
    if case['id'] in ('plan_close', 'reopen_preserves_memory'):
        # A-U109c: (a) explicitly cancel blocked/open work before close/reopen, M6.
        case = copy.deepcopy(case)
        for ev in case['events'][8:]:
            ev['lamport'] += 1
            ev['ts'] += 1
            ev['id'] = 'e-%016x' % ev['lamport']
        case['events'].insert(8, event(9, {'kind': 'task.set', 'task_id': 'T01',
                                         'base_rev': 7, 'state': 'cancelled'}))
        expected = case['expected_projection']
        expected['archived_plans'][0]['closed_ts'] = BASE_TS + 10
        expected['plan']['rev'] += 1
        expected['last_lamport'] += 1
        if case['id'] == 'plan_close':
            expected['tasks'][0].update(explicit_state='cancelled', state='cancelled',
                                        ready=False, rev=9)
            expected['rollup'].update(tasks_blocked=0, tasks_ready=0)
        else:
            expected['plan']['opened_lamport'] += 1
            expected['plan']['opened_ts'] += 1
    def test(self):
        before=copy.deepcopy(case)
        actual=fold_plan(case['events'],templates=case['templates'])
        self.assertEqual(actual,case['expected_projection'])
        self.assertEqual(actual['rejected'],case['expected_rejected'])
        self.assertEqual(case['expected_rejected'],case['expected_projection']['rejected'])
        self.assertEqual(case,before)
    setattr(VectorOracle,'test_V1_'+case['id'],test)

pack=json.loads((FIXTURES/'vectors.v1.json').read_text(encoding='utf-8'))
assert pack['v']==1
for case in pack['cases']:
    assert set(case)=={'id','templates','events','expected_projection','expected_rejected'}
    install(case)
