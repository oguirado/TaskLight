import hashlib, importlib, json, pathlib, unittest
from . import support as S

E = importlib.import_module("bridge.wall.emit")
KEYS = {"eventId", "projectId", "source", "kind", "sourceSeq", "ts", "text", "redactions", "truncated", "tier"}


class Export(S.Base):
    def build(self):
        cfg = self.cfg()
        E.emit("api", "waiting_input", "Approve migration?", config=cfg, _clock=S.CLOCK)
        E.emit("api", "waiting_input", "Approve migration?", config=cfg, _clock=S.CLOCK)
        for cls, (text, _, _) in S.planted().items():
            E.emit("api", "output", text, config=cfg, _clock=S.CLOCK)
        return cfg, str(S.spool_dir(cfg) / "api.jsonl")

    def export(self, cfg, spool, out):
        return S.run_wall(["export", "--config", cfg, "--spool", spool, "--out", str(out)])

    # W15 (digest parity with TS loadFixture needs the real U08 digest: see ORACLE.md)
    def test_w15_export_shape(self):
        cfg, spool = self.build()
        out = self.tmp / "fx"
        p = self.export(cfg, spool, out)
        self.assertEqual(p.returncode, 0, p.stderr)
        man = json.loads((out / "manifest.json").read_text())
        self.assertEqual(set(man), {"version", "projects", "eventCount", "digest"})
        self.assertEqual(man["version"], "v1")
        self.assertEqual(man["projects"][0]["projectId"], "api")
        self.assertEqual(set(man["projects"][0]), {"projectId", "tier", "label"})
        self.assertEqual(man["projects"][0]["tier"], "standard")
        self.assertRegex(man["digest"], r"^[0-9a-f]{64}$")
        raw = (out / "events.jsonl").read_text()
        self.assertTrue(raw.endswith("\n"))
        lines = raw.split("\n")[:-1]
        self.assertEqual(len(lines), man["eventCount"])
        self.assertEqual(len(lines), 2 + len(S.planted()))
        for l, src in zip(lines, S.spool_lines(cfg, "api")):
            ev = json.loads(l)
            self.assertEqual(set(ev), KEYS)
            self.assertEqual(l, E.canonical_json(ev))                 # canonical form on disk
            self.assertEqual(ev["tier"], "standard")
            self.assertIs(type(ev["truncated"]), bool)
            self.assertEqual(ev["sourceSeq"], json.loads(src)["sourceSeq"])
        evs = [json.loads(l) for l in lines]
        self.assertEqual([e["redactions"] for e in evs[:2]], [0, 0])
        self.assertTrue(all(e["redactions"] >= 1 for e in evs[2:]))
        blob = raw.encode()
        for _, (_, secret, _) in S.planted().items():
            self.assertNotIn(secret.encode(), blob)

    def test_w15_eventid_is_sha256_of_canonical_without_eventid_inferred(self):
        cfg, spool = self.build()
        out = self.tmp / "fx"
        self.assertEqual(self.export(cfg, spool, out).returncode, 0)
        for l in (out / "events.jsonl").read_text().split("\n")[:-1]:
            ev = json.loads(l)
            rest = {k: v for k, v in ev.items() if k != "eventId"}
            self.assertEqual(ev["eventId"], hashlib.sha256(E.canonical_json(rest).encode()).hexdigest())

    def test_export_rejects_tampered_spool_and_writes_nothing(self):
        cfg, spool = self.build()
        with open(spool, "ab") as fh:
            fh.write(json.dumps({"source": "agent", "projectId": "api", "sourceSeq": 99, "ts": 1, "kind": "output",
                                 "text": "x", "extra": 1}).encode() + b"\n")
        out = self.tmp / "fx"
        p = self.export(cfg, spool, out)
        self.assertEqual(p.returncode, 2)
        self.assertFalse((out / "manifest.json").exists())
        self.assertFalse((out / "events.jsonl").exists())

    def test_export_rejects_unredacted_spool_line(self):
        cfg, spool = self.build()
        secret = "hunter2hunter2"
        with open(spool, "ab") as fh:
            fh.write(json.dumps({"source": "agent", "projectId": "api", "sourceSeq": 99, "ts": 1, "kind": "output",
                                 "text": "MY_SECRET" + "=" + secret}).encode() + b"\n")
        out = self.tmp / "fx"
        p = self.export(cfg, spool, out)
        self.assertNotIn(secret.encode(), p.stdout + p.stderr)
        full = b"".join(f.read_bytes() for f in out.rglob("*") if f.is_file()) if out.exists() else b""
        self.assertNotIn(secret.encode(), full)                       # either re-redacted or refused, never copied


if __name__ == "__main__":
    unittest.main()
