"""Bounded differential test adapter, not a product API or implementation."""
import contextlib
import io
import json
import sys
from .support import FIXTURE, InventoryCase


def main():
    name = json.load(sys.stdin)["case"]
    case = next(case for case in FIXTURE["cases"] if case["name"] == name)
    test = InventoryCase()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            test.setUp()
            test.install(case)
            inventory = test.inventory()
            test.assert_contract(inventory)
        print(json.dumps({"ok": True, "inventory": inventory}, ensure_ascii=True))
    except AssertionError as exc:
        # Missing product behavior is a normal assertion result, never an import failure.
        print(json.dumps({"ok": False, "reason": str(exc).split("\n")[0]}, ensure_ascii=True))
    finally:
        test.doCleanups()


if __name__ == "__main__":
    main()
