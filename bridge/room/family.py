"""Recipient-owned file transport; the room dispatcher retains journal authority.

Slice two adds activity, planning and work through the shared fenced backend.
Dependency admission is a deployment prerequisite; registered tool contracts are
checked again before the consumer takes ownership. Slice one remains the default.
"""

import argparse
from contextlib import ExitStack, contextmanager
import errno
from inspect import signature
import os
import posix
import secrets
import stat
import sys
import time

from bridge.room import _lock, app, store
from bridge.room.family_envelope import (
    ENDPOINT_RE, ID_RE, LIFECYCLE, MAX_REQUEST_BYTES, SCHEMA, SLICE_TWO,
    InvalidEnvelope, canonical, configuration, decode, digest, operation_id, validate,
)


# Fixed routes in delivery-enablement order. The only selectable subtools are
# the closed planning set already checked by the envelope validator.
_SLICE_TWO_TOOLS = {
    "agent.activity": ("activity_beat",),
    "agent.plan": ("plan_create", "task_add", "microtask_add"),
    "work.acquire": ("work_acquire",),
    "work.report": ("work_report",),
    "task.claim": ("task_claim",),
    "task.release": ("task_release",),
    "task.update": ("task_update",),
    "microtask.update": ("microtask_set",),
    "plan.phase": ("plan_phase",),
    "plan.close": ("plan_close",),
}


class Refusal(Exception):
    """Startup or ownership precondition was not satisfied."""


class UnsafeEntry(Exception):
    """A directory entry must not be followed or consumed."""


class RecoveryError(Exception):
    """Durability or retained identity cannot be established."""


def _stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_uid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _same_entry(directory, name, before):
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError as exc:
        raise UnsafeEntry("entry replaced") from exc
    if _stamp(current) != _stamp(before):
        raise UnsafeEntry("entry replaced")


def _open_directory(parent, name):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        raise UnsafeEntry("unsafe directory")
    fd = posix.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=parent)
    try:
        after = os.fstat(fd)
        # Directory mtimes change as entries are published; identity must not.
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise UnsafeEntry("directory replaced")
        linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (linked.st_dev, linked.st_ino) != (after.st_dev, after.st_ino):
            raise UnsafeEntry("directory replaced")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _owned_directory(fd):
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or info.st_mode & 0o002:
        raise UnsafeEntry("directory is not recipient-owned")


def _read_regular(directory, name, cap):
    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            before.st_uid != os.geteuid()):
        raise UnsafeEntry("unsafe file")
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=directory)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise UnsafeEntry("file replaced by symlink") from exc
        raise
    try:
        opened = os.fstat(fd)
        if _stamp(opened) != _stamp(before):
            raise UnsafeEntry("file replaced")
        _same_entry(directory, name, opened)
        chunks, remaining = [], cap + 1
        while remaining:
            try:
                chunk = os.read(fd, min(remaining, 65_536))
            except InterruptedError:
                continue
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if _stamp(os.fstat(fd)) != _stamp(opened):
            raise UnsafeEntry("file changed during read")
        _same_entry(directory, name, opened)
        return b"".join(chunks), opened
    finally:
        os.close(fd)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except InterruptedError:
            continue
        if written <= 0:
            raise RecoveryError("incomplete write")
        view = view[written:]


def _atomic_write(directory, name, value):
    temporary = ".family-" + secrets.token_hex(16) + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
    try:
        _write_all(fd, canonical(value))
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        # A process death may leave an ignored adjacent temporary. It is never
        # interpreted as either a request or a retained operation identity.
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def _error(code, detail=None):
    value = {"ok": False, "code": code}
    if detail:
        value["detail"] = detail
    return value


def _response(identity, result, envelope=None):
    value = {"schema": SCHEMA, "id": identity, "result": result}
    if envelope is not None and "correlation_id" in envelope:
        value["correlation_id"] = envelope["correlation_id"]
    return value


def _receipt_valid(value, identity):
    return (isinstance(value, dict) and
            {"schema", "id", "result"} <= set(value) <=
            {"schema", "id", "result", "correlation_id"} and
            value["schema"] == SCHEMA and value["id"] == identity and
            ("correlation_id" not in value or isinstance(value["correlation_id"], str)) and
            _result_valid(value["result"]))


def _result_valid(result):
    if not isinstance(result, dict):
        return False
    if set(result) == {"untrusted"}:
        return isinstance(result["untrusted"], dict)
    return (result.get("ok") is False and isinstance(result.get("code"), str) and
            set(result) <= {"ok", "code", "detail"} and
            ("detail" not in result or isinstance(result["detail"], str)))


def _transient(result):
    return result.get("ok") is False and result.get("code") == "internal"


def _available_kinds(config):
    # No admission receipt format or discovery path is defined by this protocol.
    # A deployment must admit its backend first; tool existence alone is never
    # evidence that a missing generation fence has become safe.
    tools = {tool["name"]: tool for tool in app.list_tools()}
    descriptor = tools.get("agent_lifecycle", {}).get("inputSchema", {})
    properties = descriptor.get("properties", {})
    required = {"room", "agent", "state", "run_id"}
    if (not required <= set(descriptor.get("required", ())) or
            not (required | {"op_id"}) <= set(properties) or
            not callable(app.V2_DISPATCH.get("agent_lifecycle")) or
            "agent_lifecycle" not in app.tool_names()):
        raise Refusal("lifecycle dependency is unavailable")
    enabled = frozenset({"capabilities", "events.read"}) | LIFECYCLE
    if config["slice"] == 2:
        # Admissions belong to the release. Check the admitted build's complete
        # handler/writer contracts before taking ownership; never downgrade a
        # partially available slice or simulate fencing with a plan pre-read.
        refusal = "planning delivery awaits atomic backend generation fencing"
        for writer in (store.post, store.post_ops):
            try:
                fence = signature(writer).parameters.get("expected_opened_lamport")
            except (TypeError, ValueError):
                fence = None
            if fence is None:
                raise Refusal(refusal)
        for kind, names in _SLICE_TWO_TOOLS.items():
            for name in names:
                properties = tools.get(name, {}).get("inputSchema", {}).get("properties", {})
                expected = {"room", "agent", "op_id"}
                if name != "plan_create":
                    expected.add("expected_opened_lamport")
                if kind in {"agent.activity", "work.acquire", "work.report"}:
                    expected.add("run_id")
                if (not expected <= set(properties) or
                        name not in app.tool_names() or
                        not callable(app.V2_DISPATCH.get(name))):
                    raise Refusal(refusal)
        enabled |= SLICE_TWO
    if "room_events" not in tools or not _lock._posix:
        raise Refusal("snapshot dependency is unavailable")
    return enabled


class Mailbox:
    """Validated descriptor tree, exclusive ownership and durable reply state."""

    def __init__(self, endpoint):
        self.endpoint = endpoint
        self.stack = ExitStack()
        self.links = []
        self.lock_identity = None

    def _directory(self, parent, name, *, create=False, owned=False):
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        fd = _open_directory(parent, name)
        self.stack.callback(os.close, fd)
        if owned:
            _owned_directory(fd)
        self.links.append((parent, name, fd))
        return fd

    def open(self):
        if ENDPOINT_RE.fullmatch(self.endpoint) is None:
            raise Refusal("invalid endpoint")
        home = os.environ.get("CW_HOME")
        if not home or ".." in home.split(os.sep):
            raise Refusal("explicit CW_HOME is required")
        absolute = os.path.abspath(home)
        root = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.stack.callback(os.close, root)
        try:
            current = root
            # Resolve each component through its already-open parent. Absolute
            # prefixes would bypass dir_fd and follow replaced ancestors.
            for component in absolute.split(os.sep):
                if component:
                    current = self._directory(current, component)
            self.home = current
            family = self._directory(current, "family", owned=True)
            self.root = self._directory(family, self.endpoint, owned=True)
            raw, _ = _read_regular(self.root, "config.json", MAX_REQUEST_BYTES)
            if len(raw) > MAX_REQUEST_BYTES:
                raise Refusal("configuration too large")
            self.config = configuration(raw, self.endpoint)
            self.enabled = _available_kinds(self.config)
            self.spool = self._directory(self.root, "spool", owned=True)
            # Check metadata components before any dispatch or replay.
            self.state = self._directory(self.root, "state", create=True, owned=True)
            self.dedup = self._directory(self.root, "dedup", create=True, owned=True)
            self.check_tree()
        except (OSError, UnsafeEntry, InvalidEnvelope) as exc:
            raise Refusal("invalid mailbox configuration or layout") from exc
        try:
            fd = os.open("consumer.lock", os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.root)
        except FileExistsError as exc:
            raise Refusal("consumer ownership requires explicit recovery") from exc
        self.lock_identity = os.fstat(fd)
        try:
            _write_all(fd, b"family consumer\n")
            os.fsync(fd)
            os.fsync(self.root)
        finally:
            os.close(fd)

    def check_tree(self):
        for parent, name, fd in self.links:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            opened = os.fstat(fd)
            if (not stat.S_ISDIR(current.st_mode) or
                    (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)):
                raise RecoveryError("mailbox directory replaced")

    def release(self):
        if self.lock_identity is not None:
            current = os.stat("consumer.lock", dir_fd=self.root, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (self.lock_identity.st_dev, self.lock_identity.st_ino):
                raise RecoveryError("consumer ownership changed")
            os.unlink("consumer.lock", dir_fd=self.root)
            os.fsync(self.root)
            self.lock_identity = None

    def quarantine(self, name):
        # rename the entry itself, including symlinks and nonempty directories;
        # never traverse its target or recursively remove someone else's files.
        try:
            os.rename(name, "quarantine-" + secrets.token_hex(16),
                      src_dir_fd=self.spool, dst_dir_fd=self.state)
        except FileNotFoundError:
            return
        except PermissionError:
            # Moving a read-only directory between parents may require write
            # access to that directory. Hide the entry in place without opening
            # it, changing its permissions or traversing any of its contents.
            try:
                os.rename(name, ".quarantine-" + secrets.token_hex(16),
                          src_dir_fd=self.spool, dst_dir_fd=self.spool)
            except FileNotFoundError:
                return
            os.fsync(self.spool)
            return
        os.fsync(self.state)
        os.fsync(self.spool)

    def publish(self, identity, result, envelope=None):
        self.check_tree()
        name = identity + ".result.json"
        try:
            raw, _ = _read_regular(self.spool, name, store.CAP * 4)
            try:
                previous = decode(raw)
            except InvalidEnvelope:
                previous = None
            if _receipt_valid(previous, identity) and not _transient(previous["result"]):
                # Do not overwrite an unread receipt, even for conflicting input.
                # Re-establish directory durability after a rename-time crash.
                os.fsync(self.spool)
                return
            self.quarantine(name)
        except FileNotFoundError:
            pass
        except UnsafeEntry:
            self.quarantine(name)
        _atomic_write(self.spool, name, _response(identity, result, envelope))

    def forget_request(self, name, identity):
        self.check_tree()
        try:
            _same_entry(self.spool, name, identity)
        except (UnsafeEntry, FileNotFoundError):
            self.quarantine(name)
            return
        os.unlink(name, dir_fd=self.spool)
        os.fsync(self.spool)

    def retained(self, envelope):
        name = envelope["id"] + ".json"
        try:
            raw, _ = _read_regular(self.dedup, name, store.CAP * 4)
        except FileNotFoundError:
            return None
        try:
            record = decode(raw)
        except InvalidEnvelope as exc:
            raise RecoveryError("invalid retained identity") from exc
        if (not isinstance(record, dict) or
                set(record) not in ({"identity", "digest", "op_id", "phase"},
                                    {"identity", "digest", "op_id", "phase", "result"}) or
                record.get("phase") not in ("pending", "complete") or
                not isinstance(record.get("digest"), str) or
                len(record["digest"]) != 64 or
                any(ch not in "0123456789abcdef" for ch in record["digest"]) or
                not isinstance(record.get("identity"), dict) or
                set(record["identity"]) != {"source", "target", "id"} or
                not all(isinstance(item, str) for item in record["identity"].values()) or
                record["identity"]["id"] != envelope["id"] or
                record["identity"]["target"] != self.endpoint or
                ENDPOINT_RE.fullmatch(record["identity"]["source"]) is None or
                record.get("op_id") != operation_id(record["identity"]) or
                (record["phase"] == "complete" and
                 (not _result_valid(record.get("result")) or _transient(record["result"]))) or
                (record["phase"] == "pending" and "result" in record)):
            raise RecoveryError("invalid retained identity")
        # This also repairs a previous failure syncing a pending-record rename.
        os.fsync(self.dedup)
        return record

    @contextmanager
    def snapshot(self, room):
        """Lock only an existing journal, never a mutating dispatcher call."""
        with ExitStack() as stack:
            try:
                rooms = _open_directory(self.home, "rooms")
                stack.callback(os.close, rooms)
                roomfd = _open_directory(rooms, room)
                stack.callback(os.close, roomfd)
                before = os.stat("events.jsonl", dir_fd=roomfd, follow_symlinks=False)
            except FileNotFoundError:
                yield False
                return
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise RecoveryError("unsafe room journal")
            _owned_directory(roomfd)
            room_identity = os.fstat(roomfd)
            rooms_identity = os.fstat(rooms)

            def check_room_tree():
                for parent, name, expected in ((self.home, "rooms", rooms_identity),
                                                (rooms, room, room_identity)):
                    linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if (not stat.S_ISDIR(linked.st_mode) or
                            (linked.st_dev, linked.st_ino) != (expected.st_dev, expected.st_ino)):
                        raise RecoveryError("room directory replaced")

            check_room_tree()
            lockfd = os.open("events.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW |
                             os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=roomfd)
            stack.callback(os.close, lockfd)
            lockinfo = os.fstat(lockfd)
            if not stat.S_ISREG(lockinfo.st_mode) or lockinfo.st_nlink != 1:
                raise RecoveryError("unsafe journal lock")
            # Busy snapshots are retryable I/O failures. No unbounded wait or
            # backend long poll can expose an in-flight writer's batch prefix.
            _lock._backend.flock(lockfd, _lock._backend.LOCK_EX | _lock._backend.LOCK_NB)
            try:
                journal = os.open("events.jsonl", os.O_RDONLY | os.O_NOFOLLOW |
                                  os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=roomfd)
                try:
                    info = os.fstat(journal)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise RecoveryError("unsafe room journal")
                    _same_entry(roomfd, "events.jsonl", info)
                    os.fsync(journal)
                    os.fsync(roomfd)
                    os.fsync(rooms)
                    os.fsync(self.home)
                    self.check_tree()
                    check_room_tree()
                    yield True
                    check_room_tree()
                    _same_entry(roomfd, "events.jsonl", info)
                finally:
                    os.close(journal)
            finally:
                _lock.unlock(lockfd)

    def dispatch(self, envelope):
        kind = envelope["kind"]
        if kind == "capabilities":
            return {"untrusted": {"protocol": SCHEMA, "kinds": sorted(self.enabled),
                                  "health": "ready"}}
        args = dict(envelope["payload"], room=envelope["room"], agent=envelope["agent"])
        if kind == "events.read":
            args.update(after_lamport=envelope["after"], wait_ms=0)
            with self.snapshot(envelope["room"]) as exists:
                if exists:
                    result = app.dispatch("room_events", args)
                else:
                    # The absent journal is a durable empty prefix. Calling an
                    # unlocked reader here could race the first batch's creation.
                    result = {"untrusted": {"events": [], "next_after": 0, "head": 0,
                                            "has_more": False, "resync": envelope["after"] > 0}}
                if not isinstance(result, dict) or not isinstance(result.get("untrusted"), dict):
                    return result
                events = result["untrusted"].get("events")
                if (not isinstance(events, list) or
                        any(not isinstance(event, dict) or type(event.get("lamport")) is not int
                            for event in events)):
                    raise RecoveryError("invalid backend result")
                return dict(result, untrusted=dict(result["untrusted"], events=[
                    dict(event, revision=event["lamport"]) for event in events]))
        if kind in LIFECYCLE:
            tool = "agent_lifecycle"
            args.update(run_id=envelope["run_id"], state=kind.removeprefix("agent."))
        elif kind in SLICE_TWO and kind in self.enabled:
            if kind == "agent.plan":
                tool = envelope["payload"]["tool"]
                args = dict(envelope["payload"]["args"],
                            room=envelope["room"], agent=envelope["agent"])
            else:
                tool = _SLICE_TWO_TOOLS[kind][0]
            if "plan_opened" in envelope:
                args["expected_opened_lamport"] = envelope["plan_opened"]
            if kind in {"agent.activity", "work.acquire", "work.report"}:
                args["run_id"] = envelope["run_id"]
        else:
            raise store.RoomError("bad_args", "kind is not enabled")
        args["op_id"] = operation_id(envelope)
        # Never hold events.lock across mutations: the backend owns that lock.
        return app.dispatch(tool, args)

    def consume(self, name):
        self.check_tree()
        identity = name[:-5]
        if ID_RE.fullmatch(identity) is None:
            self.quarantine(name)
            return
        try:
            raw, request = _read_regular(self.spool, name, MAX_REQUEST_BYTES)
        except FileNotFoundError:
            return
        except UnsafeEntry:
            self.quarantine(name)
            return
        envelope = None
        try:
            envelope = validate(raw, self.endpoint, identity)
            # Authorization always precedes both retained-result lookup and
            # dispatch. Missing/empty allowlists cannot grant access.
            if envelope["source"] not in self.config["sources"]:
                raise store.RoomError("bad_args", "source is not configured")
            if envelope["room"] not in self.config["rooms"]:
                raise store.RoomError("bad_room", "room is not configured")
            if envelope["kind"] not in self.enabled:
                raise store.RoomError("bad_args", "kind is not enabled")
        except InvalidEnvelope:
            self.publish(identity, _error("bad_args", "invalid request"))
            self.forget_request(name, request)
            return
        except store.RoomError as exc:
            self.publish(identity, app._error_payload(exc), envelope)
            self.forget_request(name, request)
            return
        try:
            _same_entry(self.spool, name, request)
        except UnsafeEntry:
            self.quarantine(name)
            return
        record = self.retained(envelope)
        fingerprint = digest(envelope)
        if record is not None and record["digest"] != fingerprint:
            self.publish(identity, _error("bad_op", "message identity reused"), envelope)
            self.forget_request(name, request)
            return
        if record is None:
            record = {"identity": {key: envelope[key] for key in ("source", "target", "id")},
                      "digest": fingerprint, "op_id": operation_id(envelope), "phase": "pending"}
            _atomic_write(self.dedup, identity + ".json", record)
        if record["phase"] == "complete":
            result = record["result"]
        else:
            self.check_tree()
            try:
                _same_entry(self.spool, name, request)
            except UnsafeEntry:
                self.quarantine(name)
                return
            try:
                result = self.dispatch(envelope)
            except store.RoomError as exc:
                result = app._error_payload(exc)
            except (OSError, RecoveryError, UnsafeEntry):
                raise
            except Exception as exc:
                raise RecoveryError("backend failure; request retained") from exc
            if not _result_valid(result):
                raise RecoveryError("invalid backend result")
            if _transient(result):
                raise RecoveryError("transient backend failure; request retained")
            # Serialize even a throttled lifecycle no-op before publishing its
            # receipt: later retry must never ask a changed clock for its outcome.
            record.update(phase="complete", result=result)
            _atomic_write(self.dedup, identity + ".json", record)
        self.publish(identity, result, envelope)
        self.forget_request(name, request)

    def sweep(self):
        self.check_tree()
        for name in sorted(os.listdir(self.spool)):
            if (name.startswith(".") or not name.endswith(".json") or
                    name.endswith(".result.json") or name.endswith(".tmp")):
                continue
            self.consume(name)


def _positive(value):
    if not value.isascii() or not value.isdecimal():
        raise argparse.ArgumentTypeError("must be a positive integer")
    try:
        number = int(value)
        if number <= 0 or not 0 < number / 1000 <= sys.float_info.max:
            raise ValueError
    except (ValueError, OverflowError) as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description="Drain a recipient-owned family mailbox")
    parser.add_argument("command", choices=("drain",))
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--poll-ms", type=_positive)
    args = parser.parse_args(argv)
    mailbox = Mailbox(args.endpoint)
    clean = False
    status = 3
    try:
        mailbox.open()
        try:
            while True:
                mailbox.sweep()
                if args.poll_ms is None:
                    break
                time.sleep(args.poll_ms / 1000)
        except KeyboardInterrupt:
            pass
        clean = True
        status = 0
    except Refusal as exc:
        print(str(exc), file=sys.stderr)
        clean = True
        status = 2
    except (OSError, RecoveryError, UnsafeEntry):
        print("mailbox I/O or recovery failure", file=sys.stderr)
        # An ordinary handled failure releases this process's own ownership.
        # An actual process death leaves the lock for explicit recovery.
        clean = True
        status = 3
    finally:
        try:
            if clean:
                try:
                    mailbox.release()
                except (OSError, RecoveryError, UnsafeEntry):
                    print("consumer ownership recovery required", file=sys.stderr)
                    status = 3
        finally:
            mailbox.stack.close()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
