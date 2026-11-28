"""Repair loop 2 regressions from the second review of U33 (see ORACLE.md "Repair loop 2")."""
import hashlib, json, os, pathlib, stat, subprocess, sys, unittest

from .support import (RUNNER, REPO, McpCase, RoomCase, canon, clean_env, events_path, mk_event,
                      room_dir, run_cli, seed)

CAP = 16 * 1024 * 1024  # A-C4m: 16 MiB cap


def _store():
    from bridge.room import store
    return store


def _mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


# --------------------------------------------------------------------------- 1
class F1EvidenceSymlink(RoomCase):
    """Containment, credential and regular-file checks apply to the RESOLVED target.
    Recorded evidence path = os.path.realpath(given path); sha256 = hash of the target content."""

    def _refused(self, link):
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post(evidence=[str(link)])
        self.assertEqual(cm.exception.code, "bad_evidence")

    def _link(self, name, target):
        d = self.tmp / "links"
        d.mkdir(exist_ok=True)
        p = d / name
        os.symlink(str(target), str(p))
        return p

    def test_symlink_into_room_root_refused(self):
        self.post()                                      # creates rooms/r1/events.jsonl
        self._refused(self._link("innocent.txt", events_path(self.home, "r1")))

    def test_symlink_to_room_directory_file_via_resolved_home_refused(self):
        self.post()
        target = os.path.join(os.path.realpath(self.home), "rooms", "r1", "events.jsonl")
        self._refused(self._link("other.txt", target))

    def test_symlink_to_credential_basename_refused(self):
        tok = self.make_file("token.txt", b"s3cr3t")
        self._refused(self._link("notes.txt", tok))

    def test_chained_symlink_to_credential_refused(self):
        sec = self.make_file("secret.txt", b"s3cr3t")
        first = self._link("hop1.txt", sec)
        self._refused(self._link("hop2.txt", first))

    def test_symlink_to_directory_refused(self):
        d = self.tmp / "somedir"
        d.mkdir()
        self._refused(self._link("dirlink.txt", d))

    def test_dangling_symlink_refused(self):
        self._refused(self._link("dangling.txt", self.tmp / "nowhere.txt"))

    def test_valid_symlink_accepted_with_target_hash_and_resolved_path(self):
        data = b"payload-bytes\n"
        real = self.make_file("real.txt", data)
        link = self._link("alias.txt", real)
        ev = self.post(evidence=[str(link)])
        self.assertEqual(len(ev["evidence"]), 1)
        rec = ev["evidence"][0]
        self.assertEqual(rec["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(rec["path"], os.path.realpath(str(link)))
        self.assertEqual(rec["path"], os.path.realpath(str(real)))
        self.assertEqual(self.post(evidence=[str(link)])["evidence"][0], rec)  # stable


# --------------------------------------------------------------------------- 2
class F2AppendNeverTruncates(RoomCase):
    FRAG = b'{"id":"e-00ab12","lamport":2,"te'

    def _check(self, before_events, frag):
        p = events_path(self.home, "r1")
        before = p.read_bytes()
        ev = self.post(text="after-tear")
        after = p.read_bytes()
        self.assertTrue(after.startswith(before), "existing bytes (incl. torn fragment) must be preserved verbatim")
        self.assertIn(frag, after)
        line = (canon(ev) + "\n").encode("utf-8")
        self.assertTrue(after.endswith(line))
        grew = len(after) - len(before)
        self.assertIn(grew, (len(line), len(line) + 1), "only the new line plus <=1 separator byte may be added")
        events, _ = _store().read("r1", home=self.home)
        ids = [e["id"] for e in events]
        self.assertEqual(ids, [e["id"] for e in before_events] + [ev["id"]])
        self.assertEqual(ev["lamport"], len(before_events) + 1)
        self.assertEqual([e for e in events if e["text"] != "after-tear" and e not in before_events], [])
        # a second post still preserves everything
        ev2 = self.post(text="again")
        again = p.read_bytes()
        self.assertTrue(again.startswith(after))
        self.assertEqual(ev2["lamport"], ev["lamport"] + 1)
        events, _ = _store().read("r1", home=self.home)
        self.assertEqual([e["id"] for e in events][-2:], [ev["id"], ev2["id"]])

    def test_fragment_after_complete_events_kept(self):
        e1 = mk_event(1)
        seed(self.home, "r1", events=[e1], raw_tail=self.FRAG)
        self._check([e1], self.FRAG)

    def test_fragment_only_file_kept(self):
        seed(self.home, "r1", raw_tail=self.FRAG)
        self._check([], self.FRAG)

    def test_room_full_never_truncates_fragment(self):
        filler = b"x" * (CAP - 60 - 1) + b"\n"
        seed(self.home, "r1", raw_lines=[filler], raw_tail=b'{"id":"e-')
        p = events_path(self.home, "r1")
        before = p.read_bytes()
        store = _store()
        with self.assertRaises(store.RoomError) as cm:
            self.post()
        self.assertEqual(cm.exception.code, "room_full")
        self.assertEqual(p.read_bytes(), before, "refused append must leave the file byte-identical")


# --------------------------------------------------------------------------- 3
class F3InvalidEvents(RoomCase):
    def _bad_lines(self):
        base = mk_event(50, act="question")
        def v(**kw):
            e = dict(base)
            e.update(kw)
            return e
        def drop(k):
            e = dict(base)
            del e[k]
            return e
        return [
            v(id=[]),                       # the review's crash case (unhashable id)
            v(id={"a": 1}),
            drop("id"), drop("agent"), drop("text"), drop("lamport"), drop("room"), drop("ts"),
            v(act="bogus"), v(act=[]), v(act=None),
            v(lamport="51"), v(lamport=51.5), v(lamport=True), v(lamport=None),
            v(text=5), v(text=None), v(text=["x"]),
            v(agent=7), v(room=7), v(ts="x"),
            v(act="ack", re=[]), v(to=5),
        ]

    def setUp(self):
        super().setUp()
        self.good_q = mk_event(1, act="question", agent="a1", text="q?")
        self.good_h = mk_event(2, act="handoff", agent="a1", text="h")
        self.good_b = mk_event(3, act="heartbeat", agent="a2", text="hb")
        self.bad = self._bad_lines()
        raw = [json.dumps(b) for b in self.bad]
        seed(self.home, "r1", events=[self.good_q], raw_lines=raw[:len(raw) // 2])
        seed(self.home, "r1", events=[self.good_h, self.good_b], raw_lines=raw[len(raw) // 2:])

    def test_read_skips_and_counts(self):
        events, malformed = _store().read("r1", home=self.home)
        self.assertEqual([e["id"] for e in events], [self.good_q["id"], self.good_h["id"], self.good_b["id"]])
        self.assertEqual(malformed, len(self.bad))

    def test_read_since(self):
        events, malformed = _store().read("r1", since=1, home=self.home)
        self.assertEqual([e["id"] for e in events], [self.good_h["id"], self.good_b["id"]])
        self.assertEqual(malformed, len(self.bad))

    def test_wait_ignores_invalid(self):
        store = _store()
        ev = store.wait("r1", 0, act="question", timeout_s=0.5, poll_s=0.05, home=self.home)
        self.assertEqual(ev["id"], self.good_q["id"])
        self.assertIsNone(store.wait("r1", 1, act="question", timeout_s=0.3, poll_s=0.05, home=self.home))
        self.assertIsNone(store.wait("r1", 0, to="a1", timeout_s=0.3, poll_s=0.05, home=self.home))
        ev = store.wait("r1", 0, exclude_agent="a1", timeout_s=0.5, poll_s=0.05, home=self.home)
        self.assertEqual(ev["id"], self.good_b["id"])

    def test_inbox_ignores_invalid(self):
        items = _store().inbox("r1", "a2", home=self.home)
        ids = {(i["id"] if isinstance(i, dict) else i) for i in items}
        self.assertEqual(ids, {self.good_q["id"], self.good_h["id"]})

    def test_status_never_crashes(self):
        st = _store().status("r1", home=self.home)
        def ids(items):
            return {(i["id"] if isinstance(i, dict) else i) for i in items}
        self.assertEqual(ids(st["open_questions"]), {self.good_q["id"]})
        self.assertEqual(ids(st["handoffs_without_ack"]), {self.good_h["id"]})
        self.assertEqual(set(st["last_by_agent"]), {"a1", "a2"})

    def test_cli_status_and_read(self):
        cp = run_cli(["status", "--room", "r1"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        cp = run_cli(["read", "--room", "r1"], self.home)
        self.assertEqual(cp.returncode, 0, cp.stderr)
        out = json.loads(cp.stdout.decode())
        self.assertEqual(len(out["events"]), 3)
        self.assertEqual(out["malformed"], len(self.bad))

    def test_post_after_invalid_lines_still_works(self):
        ev = self.post(text="fresh")
        self.assertGreaterEqual(ev["lamport"], 4)          # whether invalid lines' lamports count is open; never below
        events, _ = _store().read("r1", home=self.home)
        self.assertEqual(events[-1]["id"], ev["id"])


# --------------------------------------------------------------------------- 4
class F4McpNotifications(McpCase):
    def _expect_next(self, c, id_):
        r = c.recv(timeout=10)
        self.assertIsNotNone(r, "no reply to the follow-up ping")
        self.assertEqual(r.get("id"), id_, "a stray reply was emitted before the ping reply: %r" % (r,))
        self.assertEqual(r.get("result"), {})

    def test_messages_without_id_get_no_reply(self):
        c = self.client()
        c.initialize()
        for m in ("notifications/nope", "foo/bar", "ping", "tools/list", "initialize", "tools/call"):
            c.send({"jsonrpc": "2.0", "method": m})
        c.send({"jsonrpc": "2.0", "id": 99, "method": "ping"})
        self._expect_next(c, 99)

    def test_unknown_method_with_id_is_32601(self):
        c = self.client()
        c.initialize()
        for i, m in ((7, "notifications/nope"), (8, "foo/bar"), (9, "tools/nonexistent")):
            r = c.request(m, id=i)
            self.assertNotIn("result", r)
            self.assertEqual(r["error"]["code"], -32601, m)
            self.assertEqual(r["id"], i)

    def test_id_null_is_a_request(self):
        c = self.client()
        c.initialize()
        c.send({"jsonrpc": "2.0", "id": None, "method": "ping"})
        r = c.recv(timeout=10)
        self.assertIsNotNone(r, "id:null request must be answered")
        self.assertIn("id", r)
        self.assertIsNone(r["id"])
        self.assertEqual(r.get("result"), {})
        c.send({"jsonrpc": "2.0", "id": None, "method": "no/such"})
        r = c.recv(timeout=10)
        self.assertIsNotNone(r)
        self.assertIsNone(r["id"])
        self.assertEqual(r["error"]["code"], -32601)
        c.send({"jsonrpc": "2.0", "id": 5, "method": "ping"})
        self._expect_next(c, 5)


# --------------------------------------------------------------------------- 5
class F5CliArgErrors(RoomCase):
    CASES = [
        ["frobnicate"],
        ["frobnicate", "--room", "r1"],
        ["post", "--room", "r1"],
        ["post", "--room", "r1", "--agent", "a1", "--act", "heartbeat"],          # missing --text
        ["read"],
        ["read", "--room", "r1", "--since", "abc"],
        ["read", "--room", "r1", "--since"],
        ["read", "--room", "r1", "--bogus-flag"],
        ["wait", "--room", "r1", "--timeout", "abc"],
        ["wait", "--room", "r1", "--since", "1.5"],
        ["status"],
        ["status", "--room", "r1", "extra-positional"],
    ]

    def test_exit_2_one_json_object_on_stdout(self):
        self.post()
        for args in self.CASES:
            with self.subTest(args=args):
                cp = run_cli(args, self.home, timeout=15)
                self.assertEqual(cp.returncode, 2, (cp.stdout, cp.stderr))
                text = cp.stdout.decode("utf-8")
                self.assertEqual(text.count("\n"), 1, "exactly one line on stdout: %r" % text)
                self.assertTrue(text.endswith("\n"))
                obj = json.loads(text)
                self.assertIsInstance(obj, dict)
                self.assertIs(obj.get("ok"), False)
                self.assertIsInstance(obj.get("code"), str)
                self.assertTrue(obj["code"])

    def test_no_event_written_on_arg_error(self):
        run_cli(["post", "--room", "r1", "--agent", "a1"], self.home)
        self.assertFalse(events_path(self.home, "r1").exists())


# --------------------------------------------------------------------------- 6
HOOK_MOD = "bridge.room.hook_claude"
ALLOWED = {"events.jsonl", "events.lock", "hook_state.json", "hook_state.lock", "hook.log"}


def _todos(*pairs):
    return [{"content": c, "status": s, "activeForm": c + "ing"} for c, s in pairs]


@unittest.skipUnless(os.name == "posix", "requires POSIX private file and directory modes")
class F6HookPermissions(RoomCase):
    def _hook(self, stdin, umask=0o022, **env):
        e = clean_env(self.home, **env)
        cp = subprocess.run([sys.executable, "-I", "-c", RUNNER, HOOK_MOD], input=stdin,
                            capture_output=True, cwd=str(REPO), env=e, timeout=30,
                            preexec_fn=lambda: os.umask(umask))
        self.assertEqual(cp.returncode, 0, cp.stderr)
        self.assertEqual(cp.stdout, b"")
        return cp

    def _payload(self, items, sid="s1"):
        return json.dumps({"session_id": sid, "cwd": str(self.tmp), "hook_event_name": "PostToolUse",
                           "tool_name": "TodoWrite", "tool_input": {"todos": items}}).encode()

    def _audit(self):
        if not self.home.exists():
            return
        for dp, dns, fns in os.walk(self.home):
            self.assertEqual(oct(_mode(dp)), oct(0o700), dp)
            for fn in fns:
                fp = os.path.join(dp, fn)
                self.assertEqual(oct(_mode(fp)), oct(0o600), fp)
        for dp, dns, fns in os.walk(self.home):
            if os.path.basename(os.path.dirname(dp)) == "rooms":
                for fn in fns:
                    self.assertIn(fn, ALLOWED, "stray file in room dir: %s" % fn)
                    self.assertNotIn("tmp", fn)

    def test_normal_run_private_modes_and_no_temp_files(self):
        env = dict(CW_ROOM="hr", CW_AGENT="bot")
        self._hook(self._payload(_todos(("a", "pending"), ("b", "pending"))), **env)
        self._hook(self._payload(_todos(("a", "completed"), ("b", "in_progress"))), **env)
        d = room_dir(self.home, "hr")
        self.assertTrue((d / "hook_state.json").exists())
        self.assertTrue((d / "events.jsonl").exists())
        self._audit()

    def test_umask_zero_run_also_private(self):
        self._hook(self._payload(_todos(("a", "pending"))), umask=0, CW_ROOM="hr", CW_AGENT="bot")
        self._audit()

    def test_refused_post_failure_path_private(self):
        env = dict(CW_ROOM="hr", CW_AGENT="BAD AGENT")
        self._hook(self._payload(_todos(("a", "pending"))), **env)
        self._hook(self._payload(_todos(("a", "completed"))), **env)
        self.assertTrue((room_dir(self.home, "hr") / "hook.log").exists())
        self.assertFalse(events_path(self.home, "hr").exists() and events_path(self.home, "hr").stat().st_size > 0)
        self._audit()

    def test_invalid_stdin_leaves_only_private_artifacts(self):
        for data in (b"", b"not json", b"[1,2]", b'{"tool_name":"TodoWrite","tool_input":{"todos":"x"}}',
                     b'{"tool_name":"TodoWrite","tool_input":{"todos":[1,2]}}'):
            self._hook(data, CW_ROOM="hr", CW_AGENT="bot")
        self._audit()

    def test_existing_logless_room_log_created_private(self):
        room_dir(self.home, "hr").mkdir(parents=True, mode=0o700)
        os.chmod(self.home, 0o700); os.chmod(self.home / "rooms", 0o700)
        self._hook(self._payload(_todos(("a", "pending"))), CW_ROOM="hr", CW_AGENT="BAD AGENT")
        self._audit()


if __name__ == "__main__":
    unittest.main()
