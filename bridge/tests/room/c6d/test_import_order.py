"""Previously bound validators retain the lifecycle result contract."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[4]


class ImportOrder(unittest.TestCase):
    def isolated(self, script):
        process = subprocess.run([sys.executable, "-I", "-B", "-c",
            "import sys; sys.path.insert(0, sys.argv[1]); " + script, str(ROOT)],
            cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)

    def test_validator_bound_before_extension_import_accepts_result(self):
        self.isolated("""
from bridge.plan.ops import validate_op_shape
assert 'bridge.room.ext.lifecycle' not in sys.modules
from bridge.room.ext import lifecycle
operation = {'kind': 'agent.lifecycle', 'state': 'finished', 'run_id': 'r1',
             'op_id': 'import-order-01', 'result': {'verdict': 'OK'}}
assert validate_op_shape(operation) == operation
""")

    def test_core_validator_works_without_extension_import_and_keeps_limits(self):
        self.isolated("""
import copy
from bridge.plan.errors import PlanError
from bridge.plan.limits import OP_BYTES_MAX
from bridge.plan.ops import validate_op_shape
assert 'bridge.room.ext.lifecycle' not in sys.modules
base = {'kind': 'agent.lifecycle', 'state': 'failed', 'run_id': 'r1', 'op_id': 'core-result-01'}
result = {'verdict': 'OK', 'summary': 'é' * 2000, 'receipt': 'p' * 512,
          'evidence': [{'path': 'p' * 512, 'sha256': 'a' * 64} for _ in range(32)]}
operation = dict(base, result=result)
snapshot = copy.deepcopy(operation)
validated = validate_op_shape(operation)
assert validated == snapshot and operation == snapshot
validated['result']['evidence'][0]['path'] = 'changed'
assert operation == snapshot
for fields, code in [
    ({'result': {'verdict': 'OK', 'extra': True}}, 'bad_args'),
    ({'result': {'verdict': 'OK', 'summary': 's' * 2001}}, 'bad_args'),
    ({'result': {'verdict': 'OK', 'receipt': 'p' * 513}}, 'bad_args'),
    ({'result': {'verdict': 'OK', 'evidence': [{}] * 33}}, 'bad_args'),
    ({'state': 'deployed', 'result': {'verdict': 'OK'}}, 'bad_args'),
    ({'reason': 'r' * OP_BYTES_MAX, 'result': {'verdict': 'OK'}}, 'limit_exceeded'),
    ({'reason': 'r' * OP_BYTES_MAX}, 'limit_exceeded'),
]:
    try:
        validate_op_shape(dict(base, **fields))
    except PlanError as error:
        assert error.code == code, (error.code, code)
    else:
        raise AssertionError('invalid operation accepted')
""")

    def test_importing_extension_does_not_rebind_validator_aliases(self):
        self.isolated("""
from bridge.plan import ops
bound = ops.validate_op_shape
from bridge.room.ext import lifecycle
from bridge.plan import fold_plan
from bridge.room import store
assert ops.validate_op_shape is bound
assert lifecycle.validate_op_shape is bound
assert store.validate_op_shape is bound
""")
