"""The extension seam registers tools once and skips modules that do not exist yet."""
import unittest

from bridge.room import ext


class SeamTest(unittest.TestCase):
    def setUp(self):
        self._tools = list(ext.EXT_TOOLS)
        self._dispatch = dict(ext.EXT_DISPATCH)

    def tearDown(self):
        ext.EXT_TOOLS[:] = self._tools
        ext.EXT_DISPATCH.clear()
        ext.EXT_DISPATCH.update(self._dispatch)

    def test_register_and_duplicate(self):
        tool = {"name": "s0_probe", "description": "probe", "inputSchema": {"type": "object"}}
        ext.register(tool, lambda args: {"ok": True})
        self.assertIn("s0_probe", ext.EXT_DISPATCH)
        self.assertEqual(ext.EXT_DISPATCH["s0_probe"]({}), {"ok": True})
        with self.assertRaises(ValueError):
            ext.register(tool, lambda args: {})

    def test_rejects_bad_descriptor_and_handler(self):
        with self.assertRaises(ValueError):
            ext.register({"description": "no name"}, lambda args: {})
        with self.assertRaises(ValueError):
            ext.register({"name": "s0_bad"}, "not callable")

    def test_load_skips_missing_modules(self):
        saved = ext.EXT_MODULES
        try:
            ext.EXT_MODULES = ("s0_module_that_does_not_exist",)
            ext.load()
        finally:
            ext.EXT_MODULES = saved


if __name__ == "__main__":
    unittest.main()
