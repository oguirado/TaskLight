import contextlib, importlib, io, json, re, unittest
from . import support as S

E = importlib.import_module("bridge.wall.emit")
ORDER = ["PRIVATE_KEY", "BEARER", "JWT", "KEY_ASSIGN", "URL_CREDS", "APPCHECK_DEBUG", "EMAIL", "HIGH_ENTROPY"]
MARK = re.compile(r"\[REDACTED:([A-Z_]+)\]")


class Redact(S.Base):
    def test_each_class_redacted(self):
        for cls, (text, secret, ok) in S.planted().items():
            out, n, classes = E.redact(text)
            self.assertNotIn(secret, out, cls)
            self.assertGreaterEqual(n, 1, cls)
            self.assertTrue(set(ok) & set(classes), (cls, classes))
            self.assertTrue(set(MARK.findall(out)) & set(ok), (cls, out))
            self.assertTrue(set(classes) <= set(ORDER))

    def test_pinned_markers_for_unambiguous_classes(self):
        P = S.planted()
        self.assertIn("MY_SECRET=[REDACTED:KEY_ASSIGN]", E.redact(P["KEY_ASSIGN"][0])[0])  # only the value
        self.assertIn("[REDACTED:EMAIL]", E.redact(P["EMAIL"][0])[0])
        self.assertIn("[REDACTED:BEARER]", E.redact(P["BEARER"][0])[0])
        self.assertIn("[REDACTED:PRIVATE_KEY]", E.redact(P["PRIVATE_KEY"][0])[0])
        self.assertTrue(E.redact(P["PRIVATE_KEY"][0])[0].startswith("key dump "))
        self.assertTrue(E.redact(P["PRIVATE_KEY"][0])[0].endswith(" end"))
        self.assertIn("db_password: [REDACTED:KEY_ASSIGN]", E.redact("db_password: " + "hunter2hunter2")[0])

    def test_class_order_is_redactclass_order(self):
        P = S.planted()
        text = P["EMAIL"][0] + " " + P["BEARER"][0]
        self.assertEqual(E.redact(text)[2], ["BEARER", "EMAIL"])

    def test_idempotent_and_marker_not_matched(self):
        for cls, (text, _, _) in S.planted().items():
            once = E.redact(text)[0]
            twice, n, classes = E.redact(once)
            self.assertEqual((twice, n, classes), (once, 0, []), cls)
        m = " ".join("[REDACTED:%s]" % c for c in ORDER)
        self.assertEqual(E.redact(m), (m, 0, []))

    def test_clean_text_unchanged(self):
        for t in ("Approve migration?", "tests: 42 passed, 0 failed", "src/ingest/redact.ts changed", "a" * 40):
            self.assertEqual(E.redact(t), (t, 0, []), t)

    # W2
    def test_w2_planted_secrets_never_reach_spool(self):
        cfg = self.cfg()
        P = S.planted()
        for cls, (text, secret, ok) in P.items():
            r = E.emit("api", "output", text, config=cfg, _clock=S.CLOCK)
            self.assertEqual(r["rc"], 0, (cls, r))
        raw = b"\n".join(S.spool_lines(cfg, "api"))
        for cls, (text, secret, ok) in P.items():
            self.assertNotIn(secret.encode(), raw, cls)
        for (cls, (_, _, ok)), line in zip(P.items(), S.spool_lines(cfg, "api")):
            t = json.loads(line)["text"]
            self.assertTrue(set(MARK.findall(t)) & set(ok), (cls, t))
        for p in S.spool_dir(cfg).iterdir():
            for cls, (_, secret, _) in P.items():
                self.assertNotIn(secret.encode(), p.read_bytes(), (p.name, cls))

    def test_secret_before_cap_is_not_leaked(self):
        cfg = self.cfg()
        secret = S.entropy_token(40, 3)
        E.emit("api", "output", "ab " * 650 + secret + " tail", config=cfg, _clock=S.CLOCK)
        self.assertNotIn(secret[:32].encode(), b"".join(S.spool_lines(cfg, "api")))

    # W3
    def test_w3_residue_fail_closed(self):
        cfg = self.cfg()
        tok = S.entropy_token(40, 11)
        ok = E.emit("api", "output", "build " + tok, config=cfg, _clock=S.CLOCK)
        self.assertEqual(ok["rc"], 0)                                        # control: normal path redacts
        self.assertIn("[REDACTED:HIGH_ENTROPY]", json.loads(S.spool_lines(cfg, "api")[0])["text"])
        before = S.tree_bytes(S.spool_dir(cfg))
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()) as out:
            r = E.emit("api", "output", "build " + tok, config=cfg, _clock=S.CLOCK,
                       _disable=frozenset({"HIGH_ENTROPY"}))
        self.assertEqual((r["ok"], r["rc"], r.get("code")), (False, 9, "REDACT_RESIDUE"))
        self.assertEqual(S.tree_bytes(S.spool_dir(cfg)), before)             # nothing written (spool and seq.json)
        for blob in (repr(r), json.dumps(r), err.getvalue(), out.getvalue()):
            self.assertNotIn(tok, blob)
            self.assertNotIn(tok[:20], blob)
        self.assertEqual(E.emit("api", "output", "after", config=cfg, _clock=S.CLOCK)["seq"], 2)  # no seq burnt

    def test_w3_residue_other_classes(self):
        cfg = self.cfg()
        for cls in ("EMAIL", "BEARER", "KEY_ASSIGN", "URL_CREDS"):
            text, secret, _ = S.planted()[cls]
            r = E.emit("api", "output", text, config=cfg, _clock=S.CLOCK, _disable=frozenset({cls}))
            self.assertEqual(r["rc"], 9, cls)
            self.assertNotIn(secret, repr(r))
        self.assertEqual(S.spool_lines(cfg, "api"), [])


if __name__ == "__main__":
    unittest.main()
