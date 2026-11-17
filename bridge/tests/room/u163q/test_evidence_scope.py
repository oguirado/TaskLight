"""U163q: evidence pointers skip only the HIGH_ENTROPY class; every other redaction class still applies."""
import unittest

from bridge.wall.emit import sanitize_output

LONG = "/work/Firebase_ProjectNameLong/repo/.scratch-QTJQzoABCDEFGHIJKLMNOPQRSTUV/cw/proof.txt"
HEX = "a" * 64


class EvidenceScope(unittest.TestCase):
    def test_long_path_and_hash_keep_bytes(self):
        out = sanitize_output({"evidence": [{"path": LONG, "sha256": HEX}, LONG]})
        self.assertEqual(out["evidence"][0]["path"], LONG)
        self.assertEqual(out["evidence"][0]["sha256"], HEX)
        self.assertEqual(out["evidence"][1], LONG)

    def test_key_assignment_in_pointer_is_redacted(self):
        raw = "/tmp/x?password=hunter2-SYNTHETIC"
        out = sanitize_output({"evidence": [{"path": raw}, raw]})
        for value in (out["evidence"][0]["path"], out["evidence"][1]):
            self.assertNotIn("hunter2-SYNTHETIC", value)
            self.assertIn("[REDACTED:KEY_ASSIGN]", value)

    def test_url_credentials_in_pointer_are_redacted(self):
        raw = "https://user:" + "s3cretpass@example.test/file.txt"
        out = sanitize_output({"evidence": [{"uri": raw}]})
        self.assertNotIn("s3cretpass", out["evidence"][0]["uri"])

    def test_free_text_outside_evidence_still_high_entropy(self):
        out = sanitize_output({"note": "token " + "Zx9" + "Kq2Lm8Np4Rs7Tv1Wy6Ab3Cd5Ef0Gh9Jk2Mn"})
        self.assertIn("[REDACTED:", out["note"])


if __name__ == "__main__":
    unittest.main()
