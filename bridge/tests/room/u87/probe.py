"""Bounded JSON transport for fresh-process and Vitest contract probes."""
import importlib
import io
import json
import sys
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from .support import (
    ProbeFinder, call, deterministic, fresh_probe, tree_bytes,
)


def import_probe(home):
    before = tree_bytes(home)
    out, err = io.StringIO(), io.StringIO()
    with deterministic(home), redirect_stdout(out), redirect_stderr(err), \
            patch("builtins.input", side_effect=AssertionError("app read stdin")), \
            patch.object(sys.stdin, "read", side_effect=AssertionError("app read stdin")), \
            patch.object(sys.stdin, "readline", side_effect=AssertionError("app read stdin")):
        importlib.import_module("bridge.room.app")
    return dict(stdout=out.getvalue(), stderr=err.getvalue(), writes=tree_bytes(home) != before,
                mcp_loaded="bridge.room.mcp" in sys.modules)


def extension_mutation(home):
    finder = ProbeFinder()
    sys.meta_path.insert(0, finder)
    try:
        with deterministic(home):
            from bridge.room import app, mcp, ext
            reference = call("mcp", "u87_probe", {})
            assert reference == (0, {"untrusted": {"probe": True}})
            assert call("cli", "u87_probe", {}) == reference
            # Remove only the probe's entries from live handler maps; descriptors
            # remain discoverable. No production bytes or module files change.
            mappings = []
            for module in (app, mcp, ext):
                for value in vars(module).values():
                    if isinstance(value, dict) and callable(value.get("u87_probe")):
                        if all(value is not old for old in mappings):
                            mappings.append(value)
            assert mappings, "no live extension dispatch map found"
            with ExitStack() as stack:
                for mapping in mappings:
                    saved = dict(mapping)
                    stack.enter_context(patch.dict(mapping, saved, clear=True))
                    mapping.pop("u87_probe", None)
                rejected = []
                for adapter in ("cli", "mcp"):
                    try:
                        result = call(adapter, "u87_probe", {})
                    except AssertionError:
                        rejected.append(True)
                    else:
                        rejected.append(result != reference)
                assert all(rejected), "extension omission escaped a call oracle"
            assert call("mcp", "u87_probe", {}) == reference
            assert call("cli", "u87_probe", {}) == reference
            return {"healthy": True, "mutant_rejected": True, "restored": True}
    finally:
        sys.meta_path.remove(finder)


def run_case(name):
    suite = unittest.defaultTestLoader.loadTestsFromName(
        "bridge.tests.room.u87.test_contract." + name)
    output = io.StringIO()
    result = unittest.TextTestRunner(stream=output, verbosity=1).run(suite)
    return {"ok": result.wasSuccessful(), "tests": result.testsRun,
            "failures": len(result.failures), "errors": len(result.errors),
            "reason": "\n".join(text for _, text in result.failures + result.errors)}


def main(argv):
    mode = argv[0]
    if mode == "case":
        value = run_case(argv[1])
    elif mode == "fresh":
        value = fresh_probe(Path(argv[1]), argv[2], argv[3])
    elif mode == "import":
        value = import_probe(Path(argv[1]))
    elif mode == "extension-mutation":
        value = extension_mutation(Path(argv[1]))
    else:
        raise ValueError("unknown oracle probe")
    print(json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
