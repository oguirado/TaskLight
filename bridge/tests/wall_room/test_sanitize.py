import copy, unittest
from . import support as S

SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
PATH = "/tmp/fixture-file.txt"


def full_event(secret):
    return {"id": "e-00000000000000ab", "lamport": 7, "ts": 1700000000007, "room": "demo", "agent": "agent-a",
            "act": "plan", "text": "msg " + secret, "to": "wall-user", "re": "e-00000000000000aa",
            "plan": {"title": "title " + secret, "steps": [{"text": "s1 " + secret, "accept": "a1 " + secret},
                                                           {"text": "s2"}]},
            "evidence": [{"path": PATH + " " + secret, "sha256": SHA}]}


class SanitizeStructure(S.Base):
    def san(self, ev):
        return self.mod().sanitize_event(ev)

    def test_clean_event_equal_and_copied(self):
        ev = full_event("clean")
        before = copy.deepcopy(ev)
        out = self.san(ev)
        self.assertEqual(out, before)
        self.assertEqual(ev, before, "input must not be mutated")
        self.assertIsNot(out, ev)

    def test_non_dict_none(self):
        for bad in (None, [], "x", 5):
            with self.subTest(v=bad):
                self.assertIsNone(self.san(bad))

    def test_residue_drops_event(self):
        # redact() still reports hits on its own output -> fail-closed
        with S.patched_redact(S.residue_redact):
            self.assertIsNone(self.san(S.event(1, text="anything")))

    def test_residue_in_any_field_drops(self):
        marks = {"text": "R-TEXT", "title": "R-TITLE", "step.text": "R-STEP", "accept": "R-ACC",
                 "path": "R-PATH"}

        def fake(text, _disable=frozenset()):
            return (text, 1, ["EMAIL"]) if any(m in text for m in marks.values()) else (text, 0, [])
        base = full_event("ok")
        variants = {
            "text": lambda e: e.update(text="R-TEXT"),
            "title": lambda e: e["plan"].update(title="R-TITLE"),
            "step.text": lambda e: e["plan"]["steps"][0].update(text="R-STEP"),
            "accept": lambda e: e["plan"]["steps"][0].update(accept="R-ACC"),
            "path": lambda e: e["evidence"][0].update(path="/R-PATH"),
        }
        with S.patched_redact(fake):
            self.assertIsNotNone(self.san(copy.deepcopy(base)))
            for name, mut in variants.items():
                with self.subTest(field=name):
                    e = copy.deepcopy(base)
                    mut(e)
                    self.assertIsNone(self.san(e))

    def test_exempt_fields_never_passed_to_redact(self):
        seen = []

        def spy(text, _disable=frozenset()):
            seen.append(text)
            return text, 0, []
        ev = full_event("clean")
        with S.patched_redact(spy):
            self.san(ev)
        self.assertNotIn(ev["id"], seen)
        self.assertNotIn(SHA, seen)

    def test_step_fields_are_redacted_via_redact(self):
        seen = []

        def spy(text, _disable=frozenset()):
            seen.append(text)
            return text, 0, []
        ev = S.event(3, step={"index": 1, "state": "done", "outcome": "OUTCOME-X", "took": "TOOK-X"})
        with S.patched_redact(spy):
            self.san(ev)
        self.assertIn("OUTCOME-X", seen)
        self.assertIn("TOOK-X", seen)


class SanitizeRedaction(S.Base):
    """Content assertions: need the real U09 redact()."""
    use_real_redact = True

    def setUp(self):
        super().setUp()
        if not S.redact_ready():
            self.skipTest("bridge.wall.emit.redact raises NotImplementedError (U09 not integrated yet)")

    def check_masked(self, out):
        self.assertIsNotNone(out)
        self.assertNotIn(S.FAKE_VALUE, repr(out))

    def test_every_field_redacted(self):
        out = self.mod().sanitize_event(full_event(S.FAKE_SECRET))
        self.check_masked(out)
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["text"])
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["plan"]["title"])
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["plan"]["steps"][0]["text"])
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["plan"]["steps"][0]["accept"])
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["evidence"][0]["path"])
        self.assertEqual(out["plan"]["steps"][1], {"text": "s2"})

    def test_step_outcome_and_took_redacted(self):
        ev = S.event(4, step={"index": 0, "state": "done", "outcome": "o " + S.FAKE_SECRET,
                              "took": S.FAKE_SECRET})
        out = self.mod().sanitize_event(ev)
        self.check_masked(out)
        self.assertIn("[REDACTED:KEY_ASSIGN]", out["step"]["outcome"])
        self.assertEqual(out["step"]["index"], 0)
        self.assertEqual(out["step"]["state"], "done")

    def test_id_and_sha256_exempt(self):
        # a 64-hex sha256 is high-entropy: exempt by field, not by luck
        out = self.mod().sanitize_event(full_event("clean"))
        self.assertEqual(out["id"], "e-00000000000000ab")
        self.assertEqual(out["evidence"][0]["sha256"], SHA)

    def test_non_text_fields_untouched(self):
        ev = full_event(S.FAKE_SECRET)
        out = self.mod().sanitize_event(ev)
        for k in ("lamport", "ts", "room", "agent", "act", "to", "re"):
            self.assertEqual(out[k], ev[k], k)

    def test_idempotent_no_residue_for_real_secret(self):
        out = self.mod().sanitize_event(S.event(5, text="x " + S.FAKE_SECRET))
        self.assertIsNotNone(out, "a masked secret must not be mistaken for residue")
        self.assertEqual(self.mod().sanitize_event(out), out)
