"""U65 public-contract oracle; stdlib only, no live services."""
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bridge.plan import fold_plan, load_template
from bridge.room import store
from tools.demo.plan_demo.run import run_demo

ROOT = Path(__file__).resolve().parents[3]
ROOM = "demo-webapp"
SUMMARY = {"room", "plan_id", "rev", "last_lamport", "tasks", "waiting_task",
           "drift_task", "memory_sections", "events_written"}
TOOLS = "post_status post_plan post_step close_task read_inbox wait_inbox list_templates get_template plan_create plan_get plan_check task_add task_update task_claim task_release microtask_add microtask_set next_work memory_set memory_get".split()
ERRORS = "no_plan plan_exists unknown_template bad_template bad_op not_found stale_rev dep_cycle claimed_by_other limit_exceeded not_conformant".split()
STARTERS = "blank web-app cli-library mobile-app data-ml".split()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def tree_bytes(directory):
    return {str(p.relative_to(directory)): p.read_bytes()
            for p in directory.rglob("*") if p.is_file() and not p.is_symlink()}


class U65Oracle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.home = self.base / "cw"
        # Acceptance prerequisites are tested first. Do not catch a missing demo,
        # skip docs, or turn NotImplementedError into an expected success.
        def forbidden(*args, **kwargs):
            self.fail("Demo attempted a network connection, live session, or timer")
        with patch("socket.socket", forbidden), patch("socket.create_connection", forbidden), \
             patch("subprocess.Popen", forbidden), patch("time.sleep", forbidden):
            self.summary = run_demo(self.home)
        self.template = load_template(str(ROOT / "templates/planning/web-app.json"))

    def events(self, home=None, room=ROOM):
        return (home or self.home) / "rooms" / room / "events.jsonl"

    def rows(self, home=None):
        return [json.loads(line) for line in self.events(home).read_bytes().splitlines()]

    def projection(self, home=None):
        return fold_plan(self.rows(home), templates={"web-app": self.template})

    def invoke(self, args=(), *, entry="module", env_home=None, unset=False):
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("PYTHON", "CW_"))}
        env.update(PYTHONDONTWRITEBYTECODE="1", HOME=str(self.base / "user"))
        if not unset:
            env["CW_HOME"] = "" if env_home is None else str(env_home)
        cmd = ([sys.executable, "-B", "-m", "tools.demo.plan_demo.run"]
               if entry == "module" else
               [sys.executable, "-B", str(ROOT / "tools/demo/plan_demo/run.py")])
        return subprocess.run(cmd + list(map(str, args)), cwd=ROOT, env=env,
                              capture_output=True, timeout=20)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))

    def test_case1_happy_projection(self):
        state = self.projection()
        self.assertEqual(state["rejected"], [])
        self.assertEqual(state["plan"]["template_id"], "web-app")
        self.assertEqual(state["plan"]["id"], "p1")
        tasks = {t["id"]: t for t in state["tasks"]}
        phases = {p["id"] for p in self.template["phases"]}
        self.assertGreater(len({t["phase"] for t in tasks.values()}), 1)
        self.assertTrue({t["phase"] for t in tasks.values()} <= phases)
        self.assertTrue(all(t["microtasks"] for t in tasks.values()))
        self.assertIn("T01", tasks["T03"]["deps"])
        self.assertIs(tasks["T03"]["ready"], False)
        self.assertNotIn(tasks["T01"]["state"], ("done", "cancelled"))
        drift = [(t, m) for t in tasks.values() for m in t["microtasks"]
                 if m["state"] == "done" and m.get("accept") and m.get("outcome")
                 and m["accept"] != m["outcome"]]
        self.assertTrue(drift, "Intentional acceptance mismatch is missing")
        self.assertIn(self.summary["drift_task"], {t["id"] for t, _ in drift})
        self.assertEqual(self.summary["waiting_task"], "T03")
        required = {s["id"] for s in self.template["memory_sections"] if s["required"]}
        self.assertTrue(required <= set(state["memory"]))
        self.assertTrue(all(s["text"].strip() for s in state["memory"].values()))
        rows = self.rows()
        self.assertEqual({r["agent"] for r in rows}, {"planner", "builder-a", "builder-b"})
        self.assertTrue(any(r["act"] == "heartbeat" for r in rows))  # A-U65a: store acts have no "status"; the MCP post_status tool writes heartbeat
        claims = {r["agent"] for r in rows if r.get("op", {}).get("kind") == "task.claim"}
        self.assertTrue({"builder-a", "builder-b"} <= claims)
        kinds = {r.get("op", {}).get("kind") for r in rows}
        self.assertTrue({"plan.open", "task.add", "memory.set", "micro.set", "plan.phase"} <= kinds)
        for row in rows:
            if row["act"] == "op":
                self.assertRegex(row["op"]["op_id"], r"^[A-Za-z0-9_-]{8,64}$")
                if row["op"]["kind"] == "memory.set":
                    self.assertEqual(row["op"]["base_rev"], 0)

    def test_case1_public_store_calls(self):
        with patch.object(store, "post_ops", wraps=store.post_ops) as batch, \
             patch.object(store, "post", wraps=store.post) as post:
            run_demo(self.base / "observed")
        self.assertTrue(batch.called, "Scenario must use store.post_ops")
        self.assertTrue(post.called, "Scenario must use store.post")
        # Accept positional or keyword calls and any legal batch composition.
        bound = [inspect.signature(store.post_ops).bind(*c.args, **c.kwargs)
                 for c in batch.call_args_list]
        self.assertTrue(any({"plan.open", "task.add"} <= {op["kind"] for op in c.arguments["ops"]}
                            for c in bound), "Plan and tasks must be an atomic batch")

    def test_case1_evidence_is_contained_and_hash_matches(self):
        completed = [m for t in self.projection()["tasks"] for m in t["microtasks"]
                     if m["state"] == "done"]
        self.assertTrue(completed)
        for micro in completed:
            with self.subTest(micro=micro["id"]):
                self.assertTrue(micro["evidence"])
                for item in micro["evidence"]:
                    self.assert_evidence_artifact(item, self.home)

    def assert_evidence_artifact(self, item, home):
        artifacts = (home / "rooms" / ROOM / "artifacts").resolve()
        relative = Path(item["path"])
        self.assertFalse(relative.is_absolute())
        path = (ROOT / relative).resolve()
        self.assertEqual(item["path"], Path(os.path.relpath(path, ROOT)).as_posix())
        self.assertTrue(path.is_relative_to(artifacts))
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])

    def test_case2_separate_process_determinism(self):
        homes = [self.base / "clean-a", self.base / "clean-b"]
        code = ("import json,sys; from pathlib import Path; "
                "from tools.demo.plan_demo.run import run_demo; "
                "print(json.dumps(run_demo(Path(sys.argv[1])),sort_keys=True))")
        summaries = []
        for home in homes:
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", CW_HOME=str(home))
            cp = subprocess.run([sys.executable, "-B", "-c", code, str(home)],
                                cwd=ROOT, env=env, capture_output=True, timeout=20)
            self.assert_ok(cp)
            summaries.append(json.loads(cp.stdout))
        self.assertEqual(summaries[0], summaries[1])
        # Compare normalized event IDs and evidence home prefixes across runs.
        def home_prefix(home):
            return Path(os.path.relpath(home.resolve(), ROOT)).as_posix() + "/"

        def norm(home):
            rows = self.rows(home)
            ids = {r["id"]: "#%d" % i for i, r in enumerate(rows) if isinstance(r.get("id"), str)}
            prefix = home_prefix(home)

            def sub(v):
                if isinstance(v, str):
                    return ids.get(v, v).replace(prefix, "<home>/")
                if isinstance(v, list):
                    return [sub(x) for x in v]
                if isinstance(v, dict):
                    return {k: sub(x) for k, x in v.items()}
                return v

            by_id = {row["id"]: row for row in rows}
            normalized = []
            for row in rows:
                entry = sub({k: v for k, v in row.items() if k not in ("id", "ts")})
                if batch := row.get("batch"):
                    ops = [by_id[member_id]["op"] for member_id in batch["member_ids"]]
                    if any(op.get("evidence") for op in ops):
                        # These demo batches hash the raw ops, including each path.
                        request = {"strict": False, "ops": ops}
                        self.assertEqual(batch["request_sha256"],
                                         hashlib.sha256(canonical(request).encode()).hexdigest())
                        entry["batch"]["request_sha256"] = hashlib.sha256(
                            canonical(sub(request)).encode()).hexdigest()
                normalized.append(entry)
            return normalized

        self.assertEqual(norm(homes[0]), norm(homes[1]))
        projections = [canonical(self.projection(home)).replace(home_prefix(home), "<home>/")
                       for home in homes]
        self.assertEqual(projections[0], projections[1])

    def test_case3_repeat_is_noop(self):
        before = self.events().read_bytes()
        projection = canonical(self.projection())
        summary = run_demo(self.home, ROOM)
        self.assertEqual(summary["events_written"], 0)
        self.assertEqual({k: v for k, v in summary.items() if k != "events_written"},
                         {k: v for k, v in self.summary.items() if k != "events_written"})
        self.assertEqual(self.events().read_bytes(), before)
        self.assertEqual(len(self.events().read_bytes().splitlines()), len(before.splitlines()))
        self.assertEqual(canonical(self.projection()), projection)

    def test_case4_cli_missing_empty_home(self):
        before = tree_bytes(ROOT)
        for entry in ("module", "file"):
            for unset in (True, False):
                with self.subTest(entry=entry, unset=unset):
                    cp = self.invoke(entry=entry, unset=unset)
                    self.assertEqual(cp.returncode, 2, cp.stderr.decode(errors="replace"))
        self.assertEqual(tree_bytes(ROOT), before)
        self.assertFalse((self.base / "user").exists())
        cp = self.invoke(["--home", ""])
        self.assertEqual(cp.returncode, 2, cp.stderr.decode(errors="replace"))
        self.assertEqual(tree_bytes(ROOT), before)

    def test_case4_cli_positive_home_sources(self):
        for entry in ("module", "file"):
            for source in ("argument", "environment"):
                with self.subTest(entry=entry, source=source):
                    home = self.base / (entry + "-" + source)
                    args = ["--home", home] if source == "argument" else []
                    self.assert_ok(self.invoke(args, entry=entry, env_home=home))
                    self.assertTrue(self.events(home).is_file())

    def test_case4_hostile_rooms_rejected_without_writes(self):
        from bridge.room.store import ROOM_RE
        for room in ("../escape", "bad/room", "", "a\nb", "UPPER", "a" * 200):
            if ROOM_RE.fullmatch(room):
                continue
            with self.subTest(room=repr(room)):
                home = self.base / "rejected"
                before = tree_bytes(self.base)
                with self.assertRaises(Exception) as cm:
                    run_demo(home, room)
                self.assertNotIsInstance(cm.exception, NotImplementedError)
                self.assertEqual(tree_bytes(self.base), before)
                self.assertNotEqual(self.invoke(["--home", home, "--room", room]).returncode, 0)
                self.assertFalse(home.exists())

    def test_case4_empty_programmatic_home_stops(self):
        before = tree_bytes(ROOT)
        for home in (None, ""):
            with self.subTest(home=home):
                with self.assertRaises(Exception) as cm:
                    run_demo(home)
                self.assertNotIsInstance(cm.exception, NotImplementedError)
        self.assertEqual(tree_bytes(ROOT), before)

    def test_case4_write_audit_rejects_outside_home(self):
        # Run the actual demo behind a process-local audit boundary. Imports and
        # interpreter setup happen before the boundary; bytecode writes are off.
        code = r"""
import os, sys
from pathlib import Path
from tools.demo.plan_demo.run import run_demo
home = Path(sys.argv[1]).resolve()
def check(path):
    if isinstance(path, int):
        return
    if not Path(os.fsdecode(path)).resolve().is_relative_to(home):
        raise AssertionError("Demo attempted a write outside CW_HOME")
def audit(event, args):
    if event == "open":
        flags = args[2] or 0
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            check(args[0])
    elif event in ("os.mkdir", "os.remove", "os.rmdir", "os.chmod", "os.truncate", "os.utime"):
        check(args[0])
    elif event in ("os.rename", "os.link"):
        check(args[0]); check(args[1])
    elif event == "os.symlink":
        check(args[1])
    elif event.startswith(("socket.", "subprocess.")):
        raise AssertionError("Demo attempted external activity")
sys.addaudithook(audit)
run_demo(home)
"""
        home = self.base / "audited"
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", CW_HOME=str(home),
                   HOME=str(self.base / "user"))
        cp = subprocess.run([sys.executable, "-B", "-c", code, str(home)],
                            cwd=ROOT, env=env, capture_output=True, timeout=20)
        self.assert_ok(cp)
        self.assertTrue(self.events(home).is_file())

    def test_case4_custom_room(self):
        room = "sample-room"
        home = self.base / "custom"
        summary = run_demo(home, room)
        self.assertEqual(summary["room"], room)
        self.assertTrue(self.events(home, room).is_file())
        home = self.base / "custom-cli"
        self.assert_ok(self.invoke(["--home", home, "--room", room]))
        self.assertTrue(self.events(home, room).is_file())

    def test_case4_artifact_symlink_escape_stops(self):
        home = self.base / "hostile"
        room = home / "rooms" / ROOM
        room.mkdir(parents=True)
        outside = self.base / "outside"
        outside.mkdir()
        (room / "artifacts").symlink_to(outside, target_is_directory=True)
        before = tree_bytes(outside)
        try:
            run_demo(home, ROOM)
        except NotImplementedError:
            raise
        except (OSError, ValueError):
            pass
        # A safe implementation may reject or replace the symlink; it may not
        # write through it. Do not prescribe an undocumented exception type.
        self.assertEqual(tree_bytes(outside), before)
        if self.events(home).exists():
            for t in self.projection(home)["tasks"]:
                for m in t["microtasks"]:
                    for e in m["evidence"]:
                        self.assert_evidence_artifact(e, home)

    def test_case5_planning_document_contract(self):
        text = (ROOT / "docs/PLANNING.md").read_text()
        for token in STARTERS + ["planning-template/v1", "schemas/planning-template.v1.schema.json",
                "brief_fields", "phases", "task_types", "granularity", "memory_sections", "lens_id",
                "tasks_max", "micro_min", "micro_max", "max_chars", "hash", "sha256",
                "PLAN.md", "MEMORY.md", "CW_HOME/templates/", "plan_create", "memory_set",
                "base_rev", "conformance", "findings", "strict", "not_conformant", "next_work",
                "task_claim", "task_release", "microtask_set", "plan_phase", "plan_close",
                "resume_from_memory", "archived_plans", "claim_lamport", "blocked_reason",
                "estimate", "outcome", "took", "evidence", "rev", "pending", "active", "blocked",
                "done", "cancelled", "closed", "Private narration", "shared", "untrusted",
                "PLANNING_CONTRACT.md", "missing_evidence", "template_unavailable"]:
            with self.subTest(token=token):
                self.assertIn(token, text)
        for limit in ("40", "8", "12", "1", "120", "160", "32", "80", "240"):
            self.assertRegex(text, r"\b" + limit + r"\b")
        self.assertRegex(text, r"2[,_ ]?000")
        self.assertRegex(text.lower(), r"canonical")
        self.assertRegex(text.lower(), r"on.device")
        self.assertRegex(text.lower(), r"redact")
        contract = (ROOT / "docs/PLANNING_CONTRACT.md").read_text()
        for tier in ("private", "standard", "shared"):
            self.assertIn(f"`{tier}`", contract)

    def test_case5_mcp_document_contract(self):
        text = (ROOT / "docs/MCP.md").read_text()
        tokens = TOOLS + ERRORS + ["tasklight://templates/{id}", "tasklight://rooms/{room}/plan",
            "tasklight://rooms/{room}/memory", "resources/list", "resources/templates/list",
            "resources/read", "prompts/list", "prompts/get", "plan_from_template", "resume_from_memory",
            "2024-11-05", '"version": "0.3.0"', "serverInfo", "capabilities", "python3", "bridge.room.mcp",
            "<repo-root>", "<cw-home-path>", "CW_HOME", "op_id", "base_rev", "events.lock",
            "replayed", "takeover", "micro_id", "evidence", "reason", "estimate", "untrusted",
            "plan.close", "plan.phase", "task.set", "micro.add", "memory.set", "micro.set",
            "task.add", "task.claim", "task.release", "-32700", "-32600", "-32601", "-32602",
            "-32002", "-32603", "bad_args", "bad_room", "bad_agent", "bad_act", "text_too_long",
            "bad_plan", "bad_step", "bad_evidence", "bad_re", "room_full", "internal",
            "missing_evidence", "template_unavailable"]
        for token in tokens:
            with self.subTest(token=token):
                self.assertIn(token, text)
        self.assertRegex(text, r"600[,_ ]?000")
        self.assertRegex(text, r'\{\s*"untrusted"\s*:')
        self.assertRegex(text.lower(), r"forbidden|not allowed|must not|no `?base_rev")
        self.assertRegex(text.lower(), r"nested|tasks\[\]\.microtasks")
        for forbidden in ("task_update.assignee", "micro.set.base_rev"):
            self.assertNotIn(forbidden, text)

    def test_case6_public_text_hygiene(self):
        # Encoded denylist avoids publishing prohibited product names as prose.
        words = [bytes.fromhex(x).decode() for x in (
            "6f70656e6169", "616e7468726f706963", "636c61756465", "63686174677074",
            "636f646578", "67656d696e69", "646565707365656b", "677074", "6669726562617365",
            "617a757265", "626564726f636b", "636f70696c6f74", "637572736f72")]
        denied = re.compile(r"\b(?:" + "|".join(words) + r")\b", re.I)
        prefix = re.compile(chr(47) + r"(?:home|Users|root)(?:/|\b)|[A-Z]:\\Users\\", re.I)
        files = [ROOT / "docs/PLANNING.md", ROOT / "docs/MCP.md"]
        files += [p for rel in ("tools/demo/plan_demo", "bridge/tests/plan_demo")
                  for p in (ROOT / rel).rglob("*") if p.suffix in (".py", ".md")]
        for path in files:
            with self.subTest(path=str(path.relative_to(ROOT))):
                text = path.read_text()
                self.assertIsNone(prefix.search(text))
                if path == ROOT / "docs/MCP.md":
                    # Allow the protocol's journal position in its documented phrases.
                    position = words[-1]
                    for phrase in (f"caller-owned {position}", f"Lamport {position}",
                                   f"and {position} reads", f"durable {position} recovery"):
                        text = text.replace(phrase, "")
                self.assertIsNone(denied.search(text))
    def test_case6_secret_scan(self):
        bash = shutil.which("bash")
        if os.name == "nt":
            git = shutil.which("git")
            if git is None:
                self.skipTest("the secret scan requires the Bash supplied with Git for Windows")
            git_bash = Path(git).parent.parent / "bin" / "bash.exe"
            if not git_bash.is_file():
                self.skipTest("the secret scan requires the Bash supplied with Git for Windows")
            bash = str(git_bash)
        if bash is None:
            self.skipTest("the secret scan requires Bash")
        cp = subprocess.run([bash, "tools/secret_scan.sh"], cwd=ROOT,
                            capture_output=True, timeout=30)
        self.assert_ok(cp)
        self.assertIn("secret_scan: 0 finding(s)", cp.stdout.decode())

    def test_no_network_live_sessions_or_sleep(self):
        def forbidden(*args, **kwargs):
            self.fail("Demo attempted a network connection, live session, or timer")
        with patch("socket.socket", forbidden), patch("socket.create_connection", forbidden), \
             patch("subprocess.Popen", forbidden), patch("time.sleep", forbidden):
            run_demo(self.base / "offline")

    def test_summary_contract(self):
        self.assertEqual(set(self.summary), SUMMARY)
        json.dumps(self.summary, allow_nan=False)
        self.assertEqual(self.summary["room"], ROOM)
        self.assertEqual(self.summary["plan_id"], "p1")
        self.assertEqual(self.summary["rev"], self.projection()["plan"]["rev"])
        self.assertEqual(self.summary["last_lamport"], self.projection()["last_lamport"])
        self.assertEqual(self.summary["events_written"], len(self.rows()))


if __name__ == "__main__":
    unittest.main()
