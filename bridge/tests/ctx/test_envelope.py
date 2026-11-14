import hashlib
import unittest

from bridge.ctx import limits
from bridge.ctx.envelope import canonical, respond
from bridge.ctx.page import page
from bridge.ctx.find import find
from bridge.ctx.census import census
from bridge.ctx.tail import tail
from bridge.ctx.state import state
from bridge.ctx.check import check
from .helpers import RCS, TmpCase, assert_envelope, canon, sha


class LimitsTests(unittest.TestCase):
    def test_constants(self):
        exp = dict(PAGE_LINES_MAX=60, PAGE_BYTES_MAX=4096, SNIPPET_MAX=160, FIND_K_MAX=50,
                   FIND_TERMS_MAX=8, FIND_FILE_MAX=1_048_576, FIND_DEADLINE_MS=2000,
                   CENSUS_TOP=10, CENSUS_ENTRIES_MAX=100_000, TAIL_N_MAX=200,
                   TAIL_BYTES_MAX=4096, GIT_TIMEOUT_S=2)
        for k, v in exp.items():
            self.assertEqual(getattr(limits, k), v, k)


class CanonicalTests(unittest.TestCase):
    def test_sorted_compact(self):
        self.assertEqual(canonical({"b": 1, "a": [1, {"d": True, "c": None}]}),
                         '{"a":[1,{"c":null,"d":true}],"b":1}')

    def test_bytewise_key_order(self):
        self.assertEqual(canonical({"b": 1, "B": 2, "a": 3}), '{"B":2,"a":3,"b":1}')

    def test_unicode_not_escaped_controls_escaped(self):
        self.assertEqual(canonical({"k": "é\n\x01"}), '{"k":"é\\n\\u0001"}')

    def test_bool_is_not_int(self):
        self.assertEqual(canonical([True, 1, False, 0]), "[true,1,false,0]")

    def test_floats_rejected(self):
        for bad in (1.5, float("nan"), float("inf"), {"a": [0.0]}):
            with self.assertRaises((ValueError, TypeError)):
                canonical(bad)

    def test_matches_reference(self):
        o = {"z": ["a b", {"y": -3, "x": "€"}], "a": ""}
        self.assertEqual(canonical(o), canon(o))


class RespondTests(unittest.TestCase):
    def test_every_rc(self):
        for rc in RCS:
            r = respond("page", rc, {"x": 1})
            assert_envelope(self, r, "page", rc)
            self.assertEqual(r["data"], {"x": 1})

    def test_ok_false_for_nonzero(self):
        self.assertIs(respond("find", 7, {})["ok"], False)
        self.assertIs(respond("find", 0, {})["ok"], True)

    def test_sha_is_hash_of_canonical_data(self):
        r = respond("tail", 0, {"b": "é", "a": 1})
        self.assertEqual(r["sha256"], hashlib.sha256(b'{"a":1,"b":"\xc3\xa9"}').hexdigest())

    def test_never_raises_float_data(self):
        r = respond("page", 0, {"x": 1.5})
        self.assertEqual(r["rc"], 2)
        self.assertFalse(r["ok"])
        self.assertEqual(set(r["data"]), {"error"})
        self.assertRegex(r["data"]["error"], r"^[A-Za-z_][A-Za-z0-9_]*$")
        assert_envelope(self, r, "page", 2)


class TotalityTests(TmpCase):
    """Verbs never raise (B1): garbage input -> rc 2."""
    def test_garbage(self):
        calls = [
            (page, "page", (None, 1, self.roots)),
            (page, "page", (self.root + "/x", "1", self.roots)),
            (find, "find", ("alpha", self.root, 3, self.roots)),
            (find, "find", (["a"], self.root, "3", self.roots)),
            (census, "census", (None, self.roots)),
            (tail, "tail", (self.root + "/x", "5", self.roots)),
            (state, "state", (None, self.roots)),
            (check, "check", (None,)),
        ]
        for fn, verb, args in calls:
            r = fn(*args)
            assert_envelope(self, r, verb, 2)


if __name__ == "__main__":
    unittest.main()
