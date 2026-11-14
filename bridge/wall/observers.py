"""U09 observers: files, git, logs, transcripts, processes. Stdlib only.

Every observer output goes through emit() (SPEC B12); observers never
write the spool directly. Plain bounded reads are the fallback when
U29 (CtxPort) is unavailable (T14).
"""
import json
import os
import subprocess
import sys
import time

from .emit import emit as _emit

POLL_MS = 2000
AGENT_KINDS = frozenset(("output", "waiting_input", "error", "exit"))
_PAGE_LINES = 60
_PAGE_BYTES = 4096
_TAIL_LINES = 200
_TAIL_BYTES = 4096
_GIT_TIMEOUT = 5
_READ_CHUNK = 8192
_MAX_PENDING = 256 * 1024


class CtxPort:
    """U29 verbs surface (see bridge/ctx). Unavailable until U29 lands."""

    def tail(self, path, n):
        raise NotImplementedError

    def state(self, target):
        raise NotImplementedError

    def page(self, path, frm):
        raise NotImplementedError


def default_ctx_port():
    return None


def _sanitize(text):
    kept = []
    for c in text:
        o = ord(c)
        if c in ("\n", "\t") or (0x20 <= o and o != 0x7F):
            kept.append(c)
        else:
            kept.append("?")
    return "".join(kept)


class _Base:
    def __init__(self, project, targets, ctx=None, emit_fn=None):
        self.project = project
        self.targets = list(targets or [])
        self.ctx = ctx
        self._emit = emit_fn if emit_fn is not None else _emit

    def _send(self, kind, text, source):
        try:
            res = self._emit(self.project, kind, text, source)
        except Exception:
            return {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
        if isinstance(res, dict):
            return res
        return {"ok": False, "rc": 1, "code": "BAD_RESULT"}


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
class FilesObserver(_Base):
    def __init__(self, project, targets, ctx=None, emit_fn=None):
        super().__init__(project, targets, ctx=ctx, emit_fn=emit_fn)
        self._known = {}
        self._started = False

    def _excerpt(self, path):
        if self.ctx is not None:
            try:
                res = self.ctx.page(path, 0)
                lines = res.get("lines", []) if isinstance(res, dict) else []
                return _sanitize("\n".join(str(x) for x in lines[:_PAGE_LINES]))
            except Exception:
                pass
        try:
            with open(path, "rb") as fh:
                raw = fh.read(_PAGE_BYTES)
        except OSError:
            return ""
        text = raw.decode("utf-8", "replace")
        return _sanitize("\n".join(text.split("\n")[:_PAGE_LINES]))

    def _scan(self):
        found = {}
        for root in self.targets:
            root = str(root)
            if os.path.isfile(root):
                candidates = [root]
            elif os.path.isdir(root):
                candidates = []
                for dirpath, dirnames, filenames in os.walk(root):
                    dirnames.sort()
                    for name in sorted(filenames):
                        candidates.append(os.path.join(dirpath, name))
            else:
                continue
            for p in candidates:
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                found[p] = (st.st_mtime_ns, st.st_size)
        return found

    def poll(self):
        current = self._scan()
        if not self._started:
            self._known = current
            self._started = True
            return []
        changed = sorted(p for p, k in current.items()
                         if p not in self._known or self._known[p] != k)
        results = []
        for p in changed:
            excerpt = self._excerpt(p)
            text = "%s: %s" % (p, excerpt) if excerpt else p
            try:
                res = self._send("file_changed", text, "local")
            except Exception:
                res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
            results.append(res)
            # Advance only on success (B11/B12, DISP_03); failures retry.
            if isinstance(res, dict) and res.get("ok") is True:
                self._known[p] = current[p]
        # Drop vanished paths from the known map only after a clean poll.
        for p in list(self._known.keys()):
            if p not in current:
                del self._known[p]
        return results


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------
def _git_text(root, *args):
    try:
        r = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True, text=True, timeout=_GIT_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return r.stdout.strip()


class GitObserver(_Base):
    def __init__(self, project, targets, ctx=None, emit_fn=None):
        super().__init__(project, targets, ctx=ctx, emit_fn=emit_fn)
        self._states = {}

    def _state(self, root):
        if self.ctx is not None:
            try:
                res = self.ctx.state(str(root))
                facts = res
                if isinstance(res, dict):
                    if isinstance(res.get("data"), dict) and isinstance(
                            res["data"].get("facts"), dict):
                        facts = res["data"]["facts"]
                    elif isinstance(res.get("facts"), dict):
                        facts = res["facts"]
                if isinstance(facts, dict):
                    head = (facts.get("head") or facts.get("HEAD")
                            or facts.get("head_hash"))
                    branch = facts.get("branch")
                    up = (facts.get("upstream") or facts.get("upstream_head"))
                    if head and branch:
                        return (str(head), str(branch),
                                str(up) if up else None)
            except Exception:
                pass
        head = _git_text(root, "rev-parse", "--verify", "HEAD")
        branch = _git_text(root, "rev-parse", "--abbrev-ref", "HEAD")
        up = _git_text(root, "rev-parse", "--verify", "@{u}")
        if head is None:
            return (None, None, None)
        return (head, branch or "HEAD", up)

    def poll(self):
        results = []
        for root in self.targets:
            root = str(root)
            current = self._state(root)
            if root not in self._states:
                self._states[root] = current
                continue
            old = self._states[root]
            o_head, _o_branch, o_up = old
            n_head, n_branch, n_up = current
            # Track the committed head/up separately so a failed commit
            # retries without duplicating an accepted push (and vice versa).
            stored_head, stored_branch, stored_up = old
            if n_head is not None and n_head != stored_head:
                try:
                    res = self._send(
                        "commit", "%s %s" % (n_branch or "HEAD", n_head[:7]), "git")
                except Exception:
                    res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res)
                if isinstance(res, dict) and res.get("ok") is True:
                    stored_head = n_head
                    stored_branch = n_branch
            elif n_head is not None and stored_head == n_head and stored_branch != n_branch:
                stored_branch = n_branch
            if n_up is not None and n_up != stored_up:
                try:
                    res = self._send(
                        "push", "%s push %s" % (n_branch or "HEAD", n_up[:7]), "git")
                except Exception:
                    res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res)
                if isinstance(res, dict) and res.get("ok") is True:
                    stored_up = n_up
            self._states[root] = (stored_head, stored_branch, stored_up)
        return results


# ---------------------------------------------------------------------------
# Logs (ci)
# ---------------------------------------------------------------------------
class LogObserver(_Base):
    def __init__(self, project, targets, ctx=None, emit_fn=None):
        super().__init__(project, targets, ctx=ctx, emit_fn=emit_fn)
        self._states = {}

    def _tail(self, path):
        if self.ctx is not None:
            try:
                res = self.ctx.tail(path, _TAIL_LINES)
                lines = res.get("lines", []) if isinstance(res, dict) else []
                return "\n".join(str(x) for x in lines)
            except Exception:
                pass
        try:
            size = os.path.getsize(path)
        except OSError:
            return ""
        try:
            with open(path, "rb") as fh:
                if size > _TAIL_BYTES:
                    fh.seek(size - _TAIL_BYTES)
                raw = fh.read()
        except OSError:
            return ""
        return raw.decode("utf-8", "replace")

    def poll(self):
        results = []
        for entry in self.targets:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            if not path or not os.path.exists(path):
                continue
            passed = entry.get("passed") or ""
            failed = entry.get("failed") or ""
            cur = self._tail(str(path))
            st = self._states.get(str(path))
            if st is None:
                try:
                    res = self._send("ci_started", str(path), "ci")
                except Exception:
                    res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res)
                if isinstance(res, dict) and res.get("ok") is True:
                    self._states[str(path)] = cur
                continue
            prev = st
            need_passed = bool(passed and passed in cur and passed not in prev)
            need_failed = bool(failed and failed in cur and failed not in prev)
            if not need_passed and not need_failed:
                self._states[str(path)] = cur
                continue
            # Advance the tail only when every pending event was accepted.
            ok = True
            if need_passed:
                try:
                    res = self._send(
                        "ci_passed", "%s: %s" % (path, passed), "ci")
                except Exception:
                    res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res)
                if not (isinstance(res, dict) and res.get("ok") is True):
                    ok = False
            if need_failed:
                try:
                    res = self._send(
                        "ci_failed", "%s: %s" % (path, failed), "ci")
                except Exception:
                    res = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res)
                if not (isinstance(res, dict) and res.get("ok") is True):
                    ok = False
            if ok:
                self._states[str(path)] = cur
        return results


# ---------------------------------------------------------------------------
# Transcripts (agent JSONL)
# ---------------------------------------------------------------------------
class TranscriptObserver(_Base):
    def __init__(self, project, targets, ctx=None, emit_fn=None):
        super().__init__(project, targets, ctx=ctx, emit_fn=emit_fn)
        self._states = {}
        self._pending = {}

    def _parse_line(self, line):
        try:
            obj = json.loads(line)
        except Exception:
            return "output", line
        if not isinstance(obj, dict):
            return "output", line
        kind = obj.get("kind")
        if not isinstance(kind, str) or kind not in AGENT_KINDS:
            kind = "output"
        text = obj.get("text")
        if not isinstance(text, str):
            text = line
        return kind, text

    def _poll_one(self, path, results):
        path = str(path)
        st = self._states.get(path)
        if self.ctx is not None:
            try:
                res = self.ctx.tail(path, _TAIL_LINES)
                lines = res.get("lines", []) if isinstance(res, dict) else []
                lines = [str(x) for x in lines]
            except Exception:
                return
            cur_count = res.get("line_count") if isinstance(res, dict) else None
            if type(cur_count) is int and cur_count >= 0:
                # Stable line_count cursor (F5): a full sliding window
                # must still yield newly appended lines.
                if st is None:
                    self._states[path] = cur_count
                    return
                prev = st if type(st) is int and st >= 0 else 0
                if cur_count < prev:
                    new_lines = lines
                    base = cur_count - len(new_lines)
                elif cur_count == prev:
                    new_lines = []
                    base = cur_count
                else:
                    new_n = cur_count - prev
                    new_lines = lines[-new_n:] if new_n <= len(lines) else lines
                    base = cur_count - len(new_lines)
                # Advance only for accepted events; stop at first failure
                # so the rest retry next poll (B11/B12, DISP_03).
                sent = 0
                for line in new_lines:
                    kind, text = self._parse_line(line)
                    try:
                        res2 = self._send(kind, text, "agent")
                    except Exception:
                        res2 = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                    results.append(res2)
                    if isinstance(res2, dict) and res2.get("ok") is True:
                        sent += 1
                    else:
                        break
                self._states[path] = base + sent
                return
            if st is None:
                self._states[path] = len(lines)
                return
            idx = st if type(st) is int and st >= 0 else 0
            for line in lines[idx:]:
                kind, text = self._parse_line(line)
                try:
                    res2 = self._send(kind, text, "agent")
                except Exception:
                    res2 = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res2)
                if isinstance(res2, dict) and res2.get("ok") is True:
                    idx += 1
                else:
                    break
            self._states[path] = idx
            return
        # Bounded fallback: stream in chunks with a capped pending
        # buffer (F5: never materialise a whole multi-MiB record).
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        if st is None:
            self._states[path] = size
            self._pending[path] = bytearray()
            return
        offset = st if type(st) is int and st >= 0 else 0
        pending = self._pending.get(path, bytearray())
        if not isinstance(pending, bytearray):
            pending = bytearray(bytes(pending))
        if size < offset:
            offset = 0
            pending = bytearray()
        if size == offset:
            # No new bytes: retry buffered lines from a prior failure.
            while True:
                nl = pending.find(b"\n")
                if nl < 0:
                    break
                line_b = bytes(pending[:nl])
                line_s = line_b.decode("utf-8", "replace")
                if line_s.endswith("\r"):
                    line_s = line_s[:-1]
                if line_s == "":
                    del pending[:nl + 1]
                    continue
                kind, txt = self._parse_line(line_s)
                try:
                    res2 = self._send(kind, txt, "agent")
                except Exception:
                    res2 = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                results.append(res2)
                if isinstance(res2, dict) and res2.get("ok") is True:
                    del pending[:nl + 1]
                else:
                    break
            self._states[path] = offset
            self._pending[path] = pending
            return
        try:
            fh = open(path, "rb")
        except OSError:
            return
        with fh:
            try:
                fh.seek(offset)
            except OSError:
                self._pending[path] = pending
                return
            while True:
                try:
                    chunk = fh.read(_READ_CHUNK)
                except OSError:
                    break
                if not chunk:
                    break
                offset += len(chunk)
                pending.extend(chunk)
                # Drain complete lines; on first failure keep the failed
                # line plus the rest buffered for retry (B11/B12).
                failed_at = None
                while True:
                    nl = pending.find(b"\n")
                    if nl < 0:
                        break
                    line_b = bytes(pending[:nl])
                    line_s = line_b.decode("utf-8", "replace")
                    if line_s.endswith("\r"):
                        line_s = line_s[:-1]
                    if line_s == "":
                        del pending[:nl + 1]
                        continue
                    kind, txt = self._parse_line(line_s)
                    try:
                        res2 = self._send(kind, txt, "agent")
                    except Exception:
                        res2 = {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
                    results.append(res2)
                    if isinstance(res2, dict) and res2.get("ok") is True:
                        del pending[:nl + 1]
                    else:
                        failed_at = nl
                        break
                if len(pending) > _MAX_PENDING:
                    # Keep only the tail so memory stays bounded.
                    excess = len(pending) - _MAX_PENDING
                    del pending[:excess]
                if failed_at is not None:
                    # Retry next poll: bytes stay in _pending, offset
                    # already advanced past the read bytes.
                    break
        self._states[path] = offset
        self._pending[path] = pending

    def poll(self):
        results = []
        for path in self.targets:
            self._poll_one(path, results)
        return results


# ---------------------------------------------------------------------------
# Processes (Linux /proc only)
# ---------------------------------------------------------------------------
class ProcObserver:
    def __init__(self, project, pids, emit_fn=None, platform=None):
        self.project = project
        self.pids = [int(p) for p in (pids or [])]
        self._emit = emit_fn if emit_fn is not None else _emit
        plat = platform if platform is not None else sys.platform
        self._platform = plat
        self._seen = set()
        if plat.startswith("linux"):
            self.disabled_reason = None
        else:
            self.disabled_reason = (
                "proc observer disabled: /proc is unavailable on platform "
                + str(plat))

    def _facts(self, pid):
        base = "/proc/%d" % pid
        rss_kib = 0
        runtime = 0.0
        try:
            with open(base + "/statm") as fh:
                parts = fh.read().split()
            page = os.sysconf("SC_PAGE_SIZE")
            rss_kib = int(parts[1]) * page // 1024
        except Exception:
            pass
        try:
            btime = 0
            with open("/proc/stat") as fh:
                for line in fh:
                    if line.startswith("btime "):
                        btime = int(line.split()[1])
                        break
            with open(base + "/stat") as fh:
                raw = fh.read()
            tail = raw.rsplit(")", 1)[1].split()
            start_ticks = float(tail[19])
            hz = os.sysconf("SC_CLK_TCK")
            runtime = max(0.0, time.time() - (btime + start_ticks / hz))
        except Exception:
            pass
        return rss_kib, runtime

    def _send(self, kind, text):
        try:
            res = self._emit(self.project, kind, text, "local")
        except Exception:
            return {"ok": False, "rc": 1, "code": "EMIT_RAISED"}
        if isinstance(res, dict):
            return res
        return {"ok": False, "rc": 1, "code": "BAD_RESULT"}

    def poll(self):
        if self.disabled_reason is not None:
            return []
        results = []
        for pid in self.pids:
            alive = os.path.isdir("/proc/%d" % pid)
            if alive and pid not in self._seen:
                rss_kib, runtime = self._facts(pid)
                text = "pid %d rss %d KiB runtime %.1fs" % (
                    pid, rss_kib, runtime)
                res = self._send("proc_started", text)
                results.append(res)
                if isinstance(res, dict) and res.get("ok") is True:
                    self._seen.add(pid)
            elif not alive and pid in self._seen:
                res = self._send("proc_exited", "pid %d exited" % pid)
                results.append(res)
                if isinstance(res, dict) and res.get("ok") is True:
                    self._seen.discard(pid)
        return results


# ---------------------------------------------------------------------------
# Factory (SPEC B11/B12)
# ---------------------------------------------------------------------------
def build_observers(project_cfg, ctx=None, emit_fn=None):
    cfg = project_cfg or {}
    pid = cfg.get("projectId") or cfg.get("project") or ""
    roots = cfg.get("roots") or []
    obs = [
        FilesObserver(pid, roots, ctx=ctx, emit_fn=emit_fn),
        GitObserver(pid, roots, ctx=ctx, emit_fn=emit_fn),
    ]
    logs = cfg.get("logs") or []
    if logs:
        obs.append(LogObserver(pid, logs, ctx=ctx, emit_fn=emit_fn))
    transcripts = cfg.get("transcripts") or []
    if transcripts:
        obs.append(TranscriptObserver(pid, transcripts, ctx=ctx, emit_fn=emit_fn))
    pids = cfg.get("pids") or []
    if pids:
        obs.append(ProcObserver(pid, pids, emit_fn=emit_fn))
    return obs


__all__ = [
    "POLL_MS", "CtxPort", "default_ctx_port", "FilesObserver",
    "GitObserver", "LogObserver", "TranscriptObserver", "ProcObserver",
    "build_observers",
]

