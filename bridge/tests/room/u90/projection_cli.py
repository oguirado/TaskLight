"""Bounded JSON adapter for cross-language tests; no network or model calls."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from bridge.plan.fold import apply_op_event, fold_plan


def main():
    request = json.loads(sys.stdin.read(65536))
    result = fold_plan(request["events"])
    for event in request.get("continuation", []):
        result = json.loads(json.dumps(result))
        result, _ = apply_op_event(result, event)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
