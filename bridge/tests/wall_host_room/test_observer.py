"""RoomObserver decision: the host does not use it (room events go via RoomRelay); if the module still exists its
dict-result bug (truthy {"ok": False}) must be fixed."""
import importlib, json, pathlib, re, shutil, tempfile, unittest
from . import support as S

BRIDGE = S.W.BRIDGE


def obs_cls():
    try:
        return importlib.import_module("bridge.room.observer").RoomObserver
    except ImportError:
        return None


class HostDoesNotUseObserver(unittest.TestCase):
    def test_wall_package_does_not_reference_room_observer(self):
        for p in sorted((BRIDGE / "wall").glob("*.py")):
            src = p.read_text(encoding="utf-8")
            self.assertNotRegex(src, r"RoomObserver|room\.observer|room import observer", p.name)

    def test_host_module_namespace_has_no_observer(self):
        self.assertFalse(hasattr(S.host_mod(), "RoomObserver"))


class ObserverDictResult(unittest.TestCase):
    def setUp(self):
        self.cls = obs_cls()
        if self.cls is None:
            self.skipTest("RoomObserver retired (allowed by AMEND_W)")
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="obs_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        d = self.tmp / "rooms" / "ra"
        d.mkdir(parents=True)
        self.lines = [{"id": "e-%016x" % i, "lamport": i, "act": "step", "text": "t%d" % i} for i in (1, 2)]
        (d / "events.jsonl").write_text("".join(json.dumps(x) + "\n" for x in self.lines))

    def run_obs(self, results):
        calls, res = [], list(results)

        def fn(project, kind, text, source="agent"):
            calls.append(json.loads(text)["lamport"])
            return res.pop(0) if res else {"ok": True, "rc": 0}
        o = self.cls(str(self.tmp / "rooms" / "*"), fn)
        o.poll()
        o.poll()
        return calls

    def test_dict_ok_false_is_failure_cursor_does_not_advance(self):
        calls = self.run_obs([{"ok": False, "rc": 1, "code": "IO_ERROR"}])
        self.assertEqual(calls, [1, 1, 2], "failed emit must be retried, not skipped")

    def test_dict_rc_nonzero_without_ok_is_failure(self):
        calls = self.run_obs([{"rc": 1, "code": "RATE_LIMITED"}])
        self.assertEqual(calls, [1, 1, 2])

    def test_dict_ok_true_advances(self):
        calls = self.run_obs([{"ok": True, "rc": 0}, {"ok": True, "rc": 0}])
        self.assertEqual(calls, [1, 2])

    def test_legacy_bool_results_unchanged(self):
        self.assertEqual(self.run_obs([False]), [1, 1, 2])
        self.assertEqual(self.run_obs([True, True]), [1, 2])


if __name__ == "__main__":
    unittest.main()
