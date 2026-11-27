"""C7b artifact authorization, containment, integrity, paging and redaction."""
import builtins
import io
import os
from unittest import mock

from bridge.room.ext.artifact import artifact_read
from bridge.tests.room.c7.support import SECRET, StopRule, bounded
from bridge.wall.emit import sanitize_output

from .support import ARTIFACT, NO_REFERENCE, REVIEWER, ProjectCase, digest

MAX_SIZE = 4 * 1024 * 1024


from bridge.tests.xplat_support import windows_filesystem


class ArtifactOracle(ProjectCase):
    def artifact(self, path=ARTIFACT, **fields):
        # Test the handler itself before the separate MCP registration case.
        with bounded():
            return artifact_read({**REVIEWER, "path": path, **fields})

    def assert_artifact_error(self, path=ARTIFACT, code=None, detail=None, **fields):
        self.assert_room_error(lambda: self.artifact(path, **fields), code, detail)

    def test_windows_artifact_reads_regular_file_and_refuses_junction(self):
        data = b"recorded artifact"
        self.write_artifact(data)
        self.record_receipt()
        with windows_filesystem():
            self.assertEqual(self.artifact()["text"], data.decode())
        with windows_filesystem(self.project / "artifacts"):
            self.assert_artifact_error(code="bad_args")

    def test_m1_reads_historical_terminal_receipt(self):
        data = b"historical worker report\n"
        actual = self.write_artifact(data)
        self.record_receipt()
        self.lifecycle("deployed", run_id="next-run")

        self.assertEqual(self.artifact()["text"], data.decode())
        self.assertEqual(self.artifact()["sha256"], actual)

    def test_m1_reads_failed_worker_evidence(self):
        data = b"failed worker evidence\n"
        actual = self.write_artifact(data)
        self.record_evidence(actual, state="failed")
        before = self.raw()

        reply = self.artifact()
        self.assertEqual(reply["text"], data.decode())
        self.assertEqual(reply["sha256"], actual)
        self.assertEqual(self.raw(), before)

    def test_m1_refuses_readable_unrecorded_file(self):
        self.write_artifact(b"unrecorded bytes")
        self.record_receipt("artifacts/different.txt")
        self.assert_artifact_error(code="bad_args", detail=NO_REFERENCE)

    def test_m1_matches_path_as_written_before_resolving(self):
        self.write_artifact(b"only the recorded spelling is authorized")
        self.record_receipt()
        self.assert_artifact_error("./" + ARTIFACT, "bad_args", NO_REFERENCE)

    def test_m1_refuses_pointer_recorded_only_in_another_room(self):
        self.write_artifact(b"other room bytes")
        self.record_receipt(room="other")
        self.assert_artifact_error(code="bad_args", detail=NO_REFERENCE)

    def test_m1_refuses_recorded_parent_escape(self):
        # The sibling's name also exercises false positives from string prefixes.
        sibling = self.home / "project-sibling"
        sibling.mkdir()
        (sibling / "outside.txt").write_text("out of scope", encoding="utf-8")
        path = "../project-sibling/outside.txt"
        self.record_receipt(path)
        self.assert_artifact_error(path, "bad_args", "path escapes the project root")

    def test_m1_refuses_recorded_symlink_escape(self):
        outside = self.home / "outside.txt"
        outside.write_text("out of scope", encoding="utf-8")
        (self.project / ARTIFACT).symlink_to(os.path.relpath(outside, self.project / "artifacts"))
        self.record_receipt()
        self.assert_artifact_error(code="bad_args", detail="path escapes the project root")

    def test_m1_reads_recorded_symlink_to_regular_file_inside_root(self):
        data = b"in-root symlink target"
        actual = self.write_artifact(data, "artifacts/target.txt")
        (self.project / ARTIFACT).symlink_to("target.txt")
        self.record_receipt()

        reply = self.artifact()
        self.assertEqual(reply["text"], data.decode())
        self.assertEqual(reply["sha256"], actual)

    def test_m1_refuses_recorded_fifo_without_blocking(self):
        fifo = self.project / ARTIFACT
        os.mkfifo(fifo)
        self.record_receipt()
        identity = fifo.stat()
        os_open, builtin_open, io_open = os.open, builtins.open, io.open

        def is_fifo(file, dir_fd=None):
            if isinstance(file, int):
                info = os.fstat(file)
            else:
                try:
                    info = os.stat(file, dir_fd=dir_fd)
                except OSError:
                    return False
            return (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino)

        nonblocking_flags = os.O_NONBLOCK | getattr(os, "O_PATH", 0)

        def guarded_os_open(file, flags, *args, **kwargs):
            if is_fifo(file, kwargs.get("dir_fd")) and not flags & nonblocking_flags:
                raise StopRule("blocking FIFO open")
            return os_open(file, flags, *args, **kwargs)

        def guard_text_open(original):
            def guarded(file, *args, **kwargs):
                opener = args[6] if len(args) > 6 else kwargs.get("opener")
                if not isinstance(file, int) and is_fifo(file) and opener is None:
                    raise StopRule("blocking FIFO open")
                return original(file, *args, **kwargs)
            return guarded

        with mock.patch.object(os, "open", guarded_os_open), \
                mock.patch.object(builtins, "open", guard_text_open(builtin_open)), \
                mock.patch.object(io, "open", guard_text_open(io_open)):
            self.assert_artifact_error()

    def test_m1_refuses_recorded_directory(self):
        (self.project / ARTIFACT).mkdir()
        self.record_receipt()
        self.assert_artifact_error()

    def test_m1_refuses_oversize_even_for_one_byte(self):
        with (self.project / ARTIFACT).open("wb") as stream:
            stream.truncate(MAX_SIZE + 1)
        self.record_receipt()
        self.assert_artifact_error(code="limit_exceeded", limit=1)

    def test_m1_accepts_exact_file_size_cap(self):
        with (self.project / ARTIFACT).open("wb") as stream:
            stream.seek(MAX_SIZE - 1)
            stream.write(b"z")
        self.record_receipt()
        self.assert_page(self.artifact(offset=MAX_SIZE - 1, limit=1),
                         text="z", size=MAX_SIZE, offset=MAX_SIZE - 1, next_offset=None,
                         sha256=digest(b"\0" * (MAX_SIZE - 1) + b"z"))

    def test_m2_verifies_tail_against_recorded_hash_before_returning_prefix(self):
        self.record_evidence(digest(b"shared prefix\noriginal tail"))
        actual = self.write_artifact(b"shared prefix\nmodified tail")
        self.assert_artifact_error(code="bad_op", detail="sha256 mismatch", limit=1,
                                   sha256=actual)

    def test_m2_refuses_bad_recorded_hash_when_no_caller_hash(self):
        self.record_evidence(digest(b"original"))
        self.write_artifact(b"replacement")
        self.assert_artifact_error(code="bad_op", detail="sha256 mismatch")

    def test_m2_verifies_caller_hash_on_receipt_without_recorded_hash(self):
        data = b"same prefix\nnew"
        actual = self.write_artifact(data)
        self.record_receipt()
        self.assert_artifact_error(code="bad_op", detail="sha256 mismatch", limit=1,
                                   sha256=digest(b"same prefix\nold"))
        self.assertEqual(self.artifact(sha256=actual)["sha256"], actual)

    def test_m2_refuses_bad_caller_hash_when_recorded_hash_matches(self):
        actual = self.write_artifact(b"checked evidence")
        self.record_evidence(actual)
        self.assert_artifact_error(code="bad_op", detail="sha256 mismatch",
                                   sha256=digest(b"different content"))

    def assert_page(self, reply, **expected):
        self.assertEqual({key: reply.get(key) for key in expected}, expected)
        self.assertTrue(expected.keys() <= reply.keys())

    def test_m2_default_and_maximum_page_sizes_are_measured_in_bytes(self):
        data = b"a " * 32768 + b"z"
        actual = self.write_artifact(data)
        self.record_receipt()
        self.assert_page(self.artifact(), text=data[:16384].decode(), size=len(data), offset=0,
                         next_offset=16384, sha256=actual)
        self.assert_page(self.artifact(limit=65536), text=data[:65536].decode(), size=len(data),
                         offset=0, next_offset=65536, sha256=actual)
        self.assert_page(self.artifact(offset=65536, limit=1), text="z", size=len(data),
                         offset=65536, next_offset=None, sha256=actual)

    def test_m2_invalid_utf8_is_replaced_and_offsets_count_source_bytes(self):
        data = b"\xc3\xa9\xffZ"
        actual = self.write_artifact(data)
        self.record_receipt()
        self.assert_page(self.artifact(limit=3), text="\u00e9\ufffd", size=4, offset=0,
                         next_offset=3, sha256=actual)
        self.assert_page(self.artifact(offset=3, limit=1), text="Z", size=4, offset=3,
                         next_offset=None, sha256=actual)
        self.assert_page(self.artifact(offset=4), text="", size=4, offset=4,
                         next_offset=None, sha256=actual)

    def test_m2_refuses_limit_outside_closed_interval(self):
        self.write_artifact(b"data")
        self.record_receipt()
        for limit in (0, 65537):
            self.assert_artifact_error(limit=limit)

    def test_m3_uses_wall_redaction_and_preserves_pointer_bytes(self):
        path = "artifacts/" + "0123456789abcdef" * 4 + ".txt"
        owner_text = "Report header\n" + SECRET + "\nReport footer"
        actual = self.write_artifact(owner_text.encode(), path)
        self.record_receipt(path)
        before = self.raw()
        expected = sanitize_output({"text": owner_text})["text"]
        self.assertNotEqual(owner_text, expected, "planted secret must trigger the shared sanitizer")

        reply = self.artifact(path)
        self.assertEqual(reply["text"], expected)
        self.assertNotIn(SECRET.split()[-1], reply["text"])
        self.assertEqual(reply["sha256"], actual)
        if "path" in reply:
            self.assertEqual(reply["path"], path)
        self.assertEqual((self.project / path).read_bytes(), owner_text.encode())
        self.assertEqual(self.raw(), before)

    def test_m3_sanitizer_failure_stops_output(self):
        self.write_artifact(SECRET.encode())
        self.record_receipt()
        with mock.patch("bridge.wall.emit.redact",
                        side_effect=RuntimeError("redaction unavailable")) as redact:
            try:
                reply = self.artifact()
            except NotImplementedError:
                raise
            except Exception:
                reply = {}
        redact.assert_called()
        self.assertFalse(reply.get("text"), "sanitizer failure must stop output")

