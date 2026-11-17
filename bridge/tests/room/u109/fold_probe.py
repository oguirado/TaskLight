"""Read shared oracle inputs; report real Python fold results for TS comparison."""
import copy
import json
from pathlib import Path
from bridge.plan import PlanError, apply_op_event

ROOT = Path(__file__).resolve().parents[4]
DATA = json.loads((ROOT / 'tests/unit/u109/cases.json').read_text())
DOMAIN = ('plan', 'tasks', 'memory', 'archived_plans', 'rollup', 'replayed_ops')


def run_case(case):
    before = copy.deepcopy(DATA['fixtures'][case['fixture']])
    try:
        after, _ = apply_op_event(before, copy.deepcopy(case['event']))
        code, detail = None, None
    except PlanError as exc:
        after, code, detail = before, exc.code, str(exc)
    return {'name': case['name'], 'code': code, 'detail': detail,
            'domain': {key: after[key] for key in DOMAIN}}


if __name__ == '__main__':
    print(json.dumps([run_case(case) for case in DATA['cases']], separators=(',', ':')))
