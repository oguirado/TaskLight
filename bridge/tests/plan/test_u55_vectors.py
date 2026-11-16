import copy
import json
import unittest
from bridge.plan.fold import fold_plan
from .support import FIXTURES, template


class VectorOracle(unittest.TestCase):
    pass


def install(case):
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
