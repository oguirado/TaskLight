import importlib, json, pathlib, struct, unittest
from . import support as S

E = importlib.import_module("bridge.wall.emit")
PING = b'{"t":"ping","v":1}'


def em(cfg, project, kind="output", text="x", source="agent"):
    r = E.emit(project, kind, text, source, config=cfg, _clock=S.CLOCK)
    assert r["rc"] == 0, r
    return r


def check_event(tc, f):
    tc.assertEqual(set(f), {"t", "v", "projectId", "payload", "floor", "spoolOffset"})
    tc.assertEqual((f["t"], f["v"]), ("event", 1))
    tc.assertEqual(set(f["payload"]), S.SIX_KEYS)
    tc.assertEqual(f["payload"]["projectId"], f["projectId"])
    tc.assertIs(type(f["spoolOffset"]), int)
    tc.assertGreaterEqual(f["spoolOffset"], 0)


class HostStart(S.Base):
    def hello(self, h, cfg):
        f = h.read_frame()
        self.assertEqual(set(f), {"t", "v", "projects"})
        self.assertEqual((f["t"], f["v"]), ("hello", 1))
        return f

    def test_hello_first_and_clean_bye(self):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        f = self.hello(h, cfg)
        self.assertEqual(sorted(f["projects"]), ["api", "vault"])
        h.send({"t": "ping", "v": 1})                    # keep-alive: no reply, still alive
        self.assertTrue(h.alive_for(0.5))
        h.send({"t": "bye", "v": 1})
        self.assertEqual(h.wait(), 0)
        self.assertEqual(h.rest(), b"")                  # stdout carries frames only

    def test_stdin_eof_at_frame_boundary_exits_0(self):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        self.hello(h, cfg)
        h.close_stdin()
        self.assertEqual(h.wait(), 0)

    # W8 (S5 oracle)
    def _fatal(self, raw, then_close=False):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        self.hello(h, cfg)
        h.send_raw(raw)
        if then_close:
            h.close_stdin()
        rc = h.wait()
        self.assertEqual(rc, 2, (raw[:12], h.stderr_text()[-300:]))
        self.assertEqual(h.rest(), b"", "no frame may follow the failure")

    def test_w8_bad_length_prefix(self):
        self._fatal(struct.pack("<I", 70000))                       # over 65536, body never sent
        self._fatal(struct.pack("<I", 65537))
        self._fatal(struct.pack("<I", 0xFFFFFFFF))
        self._fatal(struct.pack("<I", 0))                           # zero length
        self._fatal(struct.pack("<I", 10) + b"12345", then_close=True)   # truncated body
        self._fatal(struct.pack(">I", len(PING)) + PING)            # big-endian prefix = wrong byte order
        self._fatal(struct.pack("<I", 8) + b"{notjson")             # invalid JSON
        self._fatal(struct.pack("<I", 9) + b"\xff\xfe\xfd{}\xff\xfe\xfd")  # invalid UTF-8

    def test_w8_shapes_outside_exttohost(self):
        for obj in ({"t": "evil", "v": 1}, {"t": "ping", "v": 2}, {"t": "ping"}, [1], "ping", 7, None,
                    {"v": 1}, {"t": "hello", "v": 1, "projects": []}, {"t": "resync", "v": "1"}):
            with self.subTest(obj=obj):
                self._fatal(S.frame(obj))

    def test_w8_control_valid_frames_keep_host_alive(self):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        self.hello(h, cfg)
        h.send_raw(struct.pack("<I", len(PING)) + PING)
        h.send_raw(struct.pack("<I", 65536) + PING + b" " * (65536 - len(PING)))   # exactly the limit is valid
        self.assertTrue(h.alive_for(0.7))
        h.send({"t": "bye", "v": 1})
        self.assertEqual(h.wait(), 0)

    # W9 (neg)
    def test_w9_unlisted_origin(self):
        cfg = self.cfg()
        for origin in ("chrome-extension://" + "a" * 32 + "/", "chrome-extension://" + S.PINNED_ID,
                       "https://" + S.PINNED_ID + "/", S.PINNED_ID, "", None):
            with self.subTest(origin=origin):
                h = S.start_host(self, cfg, origin=origin)
                self.assertEqual(h.wait(), 2, h.stderr_text()[-300:])
                self.assertEqual(h.rest(), b"")            # nothing at all on stdout, not even hello
        h = S.start_host(self, cfg)                        # control: pinned ID
        self.assertEqual(h.read_frame()["t"], "hello")

    def test_invalid_config_exits_2_silently(self):
        cfgs = []
        bad = self.tmp / "bad.json"
        bad.write_text("{nope")
        cfgs.append(str(bad))
        cfgs.append(str(self.tmp / "missing.json"))
        cfgs.append(S.make_config(self.tmp, ext_id="q" * 32, name="a.json"))
        cfgs.append(S.make_config(self.tmp, ext_id="a" * 31, name="b.json"))
        cfgs.append(S.make_config(self.tmp, projects=[("p%d" % i, "standard") for i in range(13)], name="c.json"))
        for c in cfgs:
            h = S.start_host(self, c)
            self.assertEqual(h.wait(), 2, c)
            self.assertEqual(h.rest(), b"")

    # W10 + W11
    def test_w10_resync_snapshot_and_w11_floor(self):
        cfg = self.cfg()
        em(cfg, "api", "output", "a1")
        em(cfg, "vault", "output", "v1")
        em(cfg, "api", "waiting_input", "a2")
        h = S.start_host(self, cfg)
        self.assertEqual(h.read_frame()["t"], "hello")
        frames = [h.read_frame() for _ in range(3)]
        for f in frames:
            check_event(self, f)
        self.assertEqual([f["payload"]["sourceSeq"] for f in frames if f["projectId"] == "api"], [1, 2])
        offs = [f["spoolOffset"] for f in frames if f["projectId"] == "api"]
        self.assertLess(offs[0], offs[1])
        floors = {f["projectId"]: f["floor"] for f in frames}
        self.assertEqual(floors, {"api": "PREFER_ON_DEVICE", "vault": "ONLY_ON_DEVICE"})
        h.send({"t": "resync", "v": 1})
        snap = [h.read_frame() for _ in range(2)]
        for f in snap:
            check_event(self, f)
        self.assertEqual({(f["projectId"], f["payload"]["sourceSeq"], f["floor"]) for f in snap},
                         {("api", 2, "PREFER_ON_DEVICE"), ("vault", 1, "ONLY_ON_DEVICE")})
        with self.assertRaises(S.HostTimeout):
            h.read_frame(0.8)                                  # exactly 2 frames, no more

    def test_shared_tier_floor_is_prefer(self):
        cfg = self.cfg(projects=[("web", "shared"), ("vault", "private")])
        em(cfg, "web")
        em(cfg, "vault")
        h = S.start_host(self, cfg)
        h.read_frame()
        got = {f["projectId"]: f["floor"] for f in (h.read_frame(), h.read_frame())}
        self.assertEqual(got, {"web": "PREFER_ON_DEVICE", "vault": "ONLY_ON_DEVICE"})

    def test_live_tail_after_hello(self):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        self.assertEqual(h.read_frame()["t"], "hello")
        em(cfg, "api", "exit", "done")
        f = h.read_frame(8)
        check_event(self, f)
        self.assertEqual((f["projectId"], f["payload"]["kind"], f["payload"]["sourceSeq"]), ("api", "exit", 1))

    def test_no_event_resync_with_empty_spool_sends_nothing(self):
        cfg = self.cfg()
        h = S.start_host(self, cfg)
        h.read_frame()
        h.send({"t": "resync", "v": 1})
        with self.assertRaises(S.HostTimeout):
            h.read_frame(0.8)

    # negative controls on what may leave the host
    def test_planted_secret_never_in_stdout_frames(self):
        cfg = self.cfg()
        P = S.planted()
        for cls, (text, secret, _) in P.items():
            em(cfg, "api", "output", text)
        h = S.start_host(self, cfg)
        h.read_frame()
        frames = [h.read_frame() for _ in P]
        h.send({"t": "resync", "v": 1})
        frames.append(h.read_frame())
        blob = json.dumps(frames).encode() + h.stderr_text()
        for cls, (_, secret, _) in P.items():
            self.assertNotIn(secret.encode(), blob, cls)

    def test_oversize_and_malformed_spool_lines_are_not_forwarded(self):
        cfg = self.cfg()
        em(cfg, "api", "output", "first")
        env = lambda **kw: dict({"source": "agent", "projectId": "api", "sourceSeq": 50, "ts": 1, "kind": "output",
                                 "text": "TAMPER"}, **kw)
        tamper = [json.dumps(env(text="TAMPER" + "x" * 70000)),                 # > 65536 chars, never a frame
                  "{not json TAMPER",
                  json.dumps(env(extra="TAMPER")),                              # unknown key
                  json.dumps(env(kind="commit")),                               # kind outside source group
                  json.dumps(env(projectId="vault")),                           # envelope for another project's file
                  json.dumps([1, "TAMPER"])]
        with open(S.spool_dir(cfg) / "api.jsonl", "ab") as fh:
            for t in tamper:
                fh.write(t.encode() + b"\n")
        em(cfg, "api", "output", "last")
        h = S.start_host(self, cfg)
        h.read_frame()
        seen = []
        while True:
            f = h.read_frame(8)
            check_event(self, f)
            seen.append(f["payload"]["text"])
            if f["payload"]["text"] == "last":
                break
        self.assertEqual(seen, ["first", "last"])
        with self.assertRaises(S.HostTimeout):
            h.read_frame(0.6)
        self.assertTrue(all(n <= 65536 for n in h.sizes), h.sizes)     # MAX_MSG_CHARS; far below the 1 MiB S5 cap
        self.assertIsNone(h.p.poll())


class HostModule(unittest.TestCase):
    def test_limits(self):
        nh = importlib.import_module("bridge.wall.native_host")
        self.assertEqual(nh.MAX_FRAME, 65536)


if __name__ == "__main__":
    unittest.main()
