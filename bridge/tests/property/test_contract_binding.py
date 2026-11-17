import json
import unittest
from .contracts import stage_status
from .support import PUBLIC


class StageBinding(unittest.TestCase):
    def test_missing_contracts_are_blocked_with_reasons_not_skips(self):
        statuses=stage_status()
        self.assertEqual(set(statuses),{'baseline','gates','cache','lifecycle'})
        for stage in ('cache','lifecycle'):
            self.assertEqual(statuses[stage]['status'],'BLOCKED')
            self.assertIn('AUSENTE',statuses[stage]['reason'])
        contract=json.loads((PUBLIC/'contracts.json').read_text())
        self.assertIsNone(contract['lifecycle']['projection_shape'])
        self.assertEqual(contract['lifecycle']['clock']['alive_offsets'],[0,29999,30000])
        self.assertIn('ignore_lifecycle_mutant',contract['lifecycle']['mandatory_transitions'])

    def test_missing_evidence_and_import_failure_are_not_correctness_success(self):
        from .run import classify
        self.assertEqual(classify(None,''),'INFRASTRUCTURE')
        self.assertEqual(classify(1,'ModuleNotFoundError: deliberate runner failure'),'INFRASTRUCTURE')
        self.assertEqual(classify(1,'AssertionError: wrong assignee'),'CORRECTNESS')
        self.assertEqual(classify(0,'OK'),'PASS')
