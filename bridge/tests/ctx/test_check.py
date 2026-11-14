import json
import unittest

from bridge.ctx.check import check
from bridge.ctx.page import page
from bridge.ctx.tail import tail
from bridge.ctx.census import census
from bridge.ctx.find import find
from bridge.ctx.state import state
from .helpers import Clock, TmpCase, assert_envelope, canon, clk_tck, codes, D, make_proc, seal


def j(o):
    return canon(o)


class CheckTests(TmpCase):
    def setUp(self):
        super().setUp()
        p = self.w("f.txt", "".join("l%08d\n" % i for i in range(1, 101)))
        self.good = page(p, 1, self.roots)
        self.text = j(self.good)

    def chk(self, text):
        r = check(text)
        assert_envelope(self, r, "check")
        return r

    def invalid(self, text):
        r = self.chk(text)
        self.assertEqual(r["rc"], 2, text[:200])
        self.assertIs(r["ok"], False)
        self.assertIs(D(r)["valid"], False)
        self.assertTrue(D(r)["errors"])
        errs = D(r)["errors"]
        self.assertEqual(errs, sorted(errs, key=lambda e: (e["path"], e["code"])))
        for e in errs:
            self.assertEqual(set(e), {"code", "path"})
        return r

    def test_P11_valid_control(self):
        r = self.chk(self.text)
        self.assertEqual(r["rc"], 0)
        self.assertEqual(D(r), {"valid": True, "errors": []})

    def test_valid_other_verbs(self):
        p = self.w("g.txt", "alpha\nbeta\n")
        outs = [
            tail(p, 2, self.roots), census(self.root, self.roots),
            find(["alpha", "zz"], self.root, 5, self.roots),
            find(["alpha", "zz"], self.root, 5, self.roots, monotonic=Clock()),
        ]
        make_proc(self.root + "/proc", 3, starttime_ticks=clk_tck())
        outs.append(state("pid:3", self.roots, proc_root=self.root + "/proc", now_s=10))
        for o in outs:
            r = self.chk(j(o))
            self.assertEqual(r["rc"], 0, (o["verb"], D(r)))

    def test_rc6_envelope_accepted(self):
        env = seal("find", 6, {"hits": [], "complete": False, "scanned": 0, "skipped": 0, "binary": 0})
        self.assertEqual(self.chk(j(env))["rc"], 0)

    def test_unknown_key(self):
        o = dict(self.good, extra=1)
        r = self.invalid(j(o))
        self.assertIn(("UNKNOWN_FIELD", "extra"), {(c, p.split(".")[-1]) for c, p in codes(r)})

    def test_missing_key(self):
        o = dict(self.good)
        del o["sha256"]
        r = self.invalid(j(o))
        self.assertIn("MISSING_FIELD", {c for c, _ in codes(r)})

    def test_bool_as_int(self):
        r = self.invalid(self.text.replace('"rc":0', '"rc":true'))
        self.assertIn("BOOL_AS_INT", {c for c, _ in codes(r)})

    def test_float_where_int(self):
        r = self.invalid(self.text.replace('"rc":0', '"rc":0.0'))
        self.assertIn("BAD_NUMBER", {c for c, _ in codes(r)})
        d = dict(self.good["data"], total_lines=100.0)
        r = self.invalid(j(seal("page", 0, d)))
        self.assertIn("BAD_NUMBER", {c for c, _ in codes(r)})

    def test_nan_and_infinity(self):
        for tok in ("NaN", "Infinity", "-Infinity"):
            r = self.invalid(self.text.replace('"rc":0', '"rc":' + tok))
            self.assertIn("BAD_NUMBER", {c for c, _ in codes(r)}, tok)

    def test_duplicate_key(self):
        self.invalid(self.text[:-1] + ',"ok":true}')
        self.invalid(self.text.replace('"rc":0', '"rc":0,"rc":0'))

    def test_ok_rc_mismatch(self):
        for rc in (0, 7, 124):
            env = seal("page", rc, self.good["data"], ok=(rc != 0))
            self.invalid(j(env))
        self.invalid(j(seal("page", 7, self.good["data"], ok=True)))

    def test_rc_outside_set(self):
        for rc in (1, 3, 5, 8, 123, 125, -1):
            self.invalid(j(seal("page", rc, self.good["data"], ok=False)))

    def test_bad_verb_and_schema(self):
        self.invalid(j(dict(self.good, verb="densify2")))
        self.invalid(j(dict(self.good, schema="ctx.resp/v2")))

    def test_tampered_data_is_stale_sha(self):
        o = json.loads(self.text)
        o["data"]["total_lines"] = 999
        r = self.invalid(j(o))
        self.assertIn("STALE_SHA", {c for c, _ in codes(r)})
        self.assertEqual(r["rc"], 2)

    def test_sha_wrong_hex(self):
        r = self.invalid(j(dict(self.good, sha256="0" * 64)))
        self.assertIn("STALE_SHA", {c for c, _ in codes(r)})

    def test_per_verb_data_shape(self):
        d = dict(self.good["data"])
        d2 = dict(d, zzz=1)
        r = self.invalid(j(seal("page", 0, d2)))
        self.assertIn("UNKNOWN_FIELD", {c for c, _ in codes(r)})
        d3 = dict(d)
        del d3["total_lines"]
        r = self.invalid(j(seal("page", 0, d3)))
        self.assertIn("MISSING_FIELD", {c for c, _ in codes(r)})
        r = self.invalid(j(seal("page", 0, dict(d, total_lines=True))))
        self.assertIn("BOOL_AS_INT", {c for c, _ in codes(r)})
        self.invalid(j(seal("page", 0, dict(d, line_cut=1))))
        self.invalid(j(seal("page", 0, dict(d, lines="abc"))))

    def test_malformed_input(self):
        for t in ("{", "", "[]", "null", "1", '"x"', "{}", "\x00"):
            self.invalid(t)

    def test_errors_sorted_multi(self):
        o = dict(self.good, zz=1, aa=2)
        r = self.invalid(j(o))
        self.assertGreaterEqual(len(D(r)["errors"]), 2)

    def test_deterministic(self):
        self.assertEqual(check(self.text), check(self.text))


if __name__ == "__main__":
    unittest.main()
