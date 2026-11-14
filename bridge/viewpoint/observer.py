"""U40 ViewPoint runs -> Context Wall room observer (read-only)."""
import json
import os
import re

MAX_SIZE = 256 * 1024
MAX_STEPS = 12
DEFAULT_ROOT = "/dev/shm/vqa-cu/vp-mwrun/metaviewer/runs"

try:
    from bridge.wall.emit import redact as _emit_redact

    def _redact(s):
        if not isinstance(s, str):
            return ""
        return _emit_redact(s)[0]

except Exception:  # pragma: no cover - fallback if emit unavailable
    def _redact(s):
        return s if isinstance(s, str) else ""


def _home_default(home):
    if home is not None:
        return os.fspath(home)
    v = os.environ.get("CW_HOME")
    if v:
        return v
    return os.path.join(os.path.expanduser("~"), ".context-wall")


def _cursor_path(home):
    return os.path.join(_home_default(home), "observers", "viewpoint.json")


def _slug(run_id):
    raw = str(run_id).lower()
    out = []
    for c in raw:
        if ("a" <= c <= "z") or ("0" <= c <= "9") or c in "._-":
            out.append(c)
        else:
            out.append("-")
    safe = "".join(out)[:8]
    if not safe:
        safe = "x"
    return "vp-" + safe


def _title(goal):
    return _redact(goal if isinstance(goal, str) else "")[:120]


# U42: capsule inferred from the goal text, then the target names.
CAPSULES = (
    ("ChatGPT", ("chatgpt", "openai")),
    ("Gemini", ("gemini",)),
    ("Wikipedia", ("wikipedia",)),
    ("arXiv", ("arxiv",)),
)
DEFAULT_CAPSULE = "ViewPoint"
_TAGGED_TITLE_RE = re.compile(
    r"^\[(%s)\]" % "|".join(re.escape(c) for c, _k in CAPSULES + ((DEFAULT_CAPSULE, ()),)),
    re.IGNORECASE,
)


def _capsule(goal, names=()):
    texts = [goal] + list(names)
    for t in texts:
        if not isinstance(t, str) or not t:
            continue
        low = t.lower()
        # the capsule named first in the text wins ("Search Wikipedia for Gemini" -> Wikipedia)
        best = None
        for cap, keys in CAPSULES:
            for k in keys:
                i = low.find(k)
                if i >= 0 and (best is None or i < best[0]):
                    best = (i, cap)
        if best is not None:
            return best[1]
    return DEFAULT_CAPSULE


def _agent_base(capsule):
    return "%s-agent" % capsule.lower()


def _task_title(capsule, goal):
    """Task title "<Capsule> · <goal>"; a goal already tagged "[<Capsule>]" is kept as is."""
    g = goal if isinstance(goal, str) else ""
    if _TAGGED_TITLE_RE.match(g):
        t = g
    elif g:
        t = "%s \u00b7 %s" % (capsule, g)
    else:
        t = capsule
    return _redact(t)[:120]


def _label(action, target, text_len):
    atype = ""
    if isinstance(action, dict):
        t = action.get("type")
        if isinstance(t, str):
            atype = t
    role = ""
    name = ""
    if isinstance(target, dict):
        r = target.get("role")
        if isinstance(r, str):
            role = r
        n = target.get("name")
        if isinstance(n, str):
            name = n
    parts = []
    if atype:
        parts.append(atype)
    if role:
        parts.append(role)
    if name:
        parts.append('"%s"' % name)
    s = " ".join(parts) if parts else "step"
    return _redact(s)[:80]


class ViewpointObserver:
    def __init__(self, runs_root, room="viewpoint", *, home=None, clock=None, post=None):
        self.runs_root = os.fspath(runs_root)
        self.room = room
        self.home = home
        self.clock = clock
        self._post_fn = post
        self._runs = 0
        self._steps = 0
        self._skipped_large = 0
        self._skipped_nonjson = 0
        self._errors = 0
        self._processed = set()  # (run_id, filename)
        self._cursor_meta = {}  # (run_id, filename) -> (size, mtime_ns)
        self._corrupt = False
        self._counted_nonjson = set()
        self._state = {}  # run_id -> state dict
        # U42: run_id -> {"capsule", "start", "end", "slot", "agent"}
        self._meta = {}
        self._load_cursor()
        if self._post_fn is None:
            try:
                from bridge.room.store import post as _store_post

                self._post_fn = _store_post
            except Exception:
                self._post_fn = None

    # ---- cursor ----
    def _load_cursor(self):
        p = _cursor_path(self.home)
        self._processed = set()
        self._cursor_meta = {}
        self._corrupt = False
        try:
            if not os.path.exists(p):
                return
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            self._corrupt = True
            return
        try:
            if isinstance(data, dict) and isinstance(data.get("processed"), list):
                for e in data["processed"]:
                    if isinstance(e, list) and len(e) >= 2:
                        r = e[0]
                        fn = e[1]
                        if isinstance(r, str) and isinstance(fn, str):
                            self._processed.add((r, fn))
                            size = e[2] if len(e) > 2 else 0
                            mt = e[3] if len(e) > 3 else 0
                            self._cursor_meta[(r, fn)] = (
                                size if isinstance(size, int) else 0,
                                mt if isinstance(mt, int) else 0,
                            )
            elif isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(k, str) and isinstance(v, list):
                        pass
            else:
                self._corrupt = True
        except Exception:
            self._corrupt = True

    def _save_cursor(self):
        try:
            p = _cursor_path(self.home)
            d = os.path.dirname(p)
            if d:
                os.makedirs(d, exist_ok=True)
            try:
                os.chmod(d, 0o700)
            except OSError:
                pass
            entries = []
            for (r, fn) in sorted(self._processed):
                size, mt = self._cursor_meta.get((r, fn), (0, 0))
                entries.append([r, fn, size, mt])
            payload = json.dumps({"v": 1, "processed": entries}, sort_keys=True)
            fd = os.open(p, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            try:
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
        except Exception:
            self._errors += 1

    # ---- state ----
    def _new_state(self, run_id):
        return {
            "agent": _slug(run_id),
            "title": None,
            "labels": [],
            "pid_to_index": {},
            "step_state": {},
            "closed": False,
        }

    def _agent_of(self, run_id):
        m = self._meta.get(run_id)
        if m is not None and m.get("agent"):
            return m["agent"]
        return _agent_base(DEFAULT_CAPSULE)

    def _capsule_of(self, run_id, parsed=None):
        m = self._meta.get(run_id)
        if m is not None and m.get("capsule"):
            return m["capsule"]
        if parsed is not None:
            return _capsule(parsed.get("goal"), [parsed.get("name")])
        return DEFAULT_CAPSULE

    def _scan_meta(self, run_id, run_dir, entries):
        """Capsule (from the first parsable intent), start and end mtimes of a run. Silent."""
        m = self._meta.get(run_id)
        if m is None:
            m = {"capsule": None, "start": None, "end": None, "slot": None, "agent": None}
            self._meta[run_id] = m
        if m["capsule"] is None:
            intents = sorted(
                [
                    e
                    for e in entries
                    if e["name"].startswith("intent-")
                    and e["name"].endswith(".json")
                    and e["size"] <= MAX_SIZE
                ],
                key=lambda e: (e["mtime_ns"], e["name"]),
            )
            for e in intents:
                try:
                    parsed = self._parse_intent(self._read_json(run_dir, e["name"]))
                except Exception:
                    continue
                m["capsule"] = _capsule(parsed["goal"], [parsed["name"]])
                m["start"] = e["mtime_ns"]
                break
        reports = [e for e in entries if e["name"] == "report.json"]
        if reports:
            m["end"] = reports[0]["mtime_ns"]
            if m["capsule"] is None:
                m["capsule"] = DEFAULT_CAPSULE
                m["start"] = reports[0]["mtime_ns"]

    def _assign_agents(self):
        """Slug per run: "<capsule>-agent", "-2", "-3" for runs of the same capsule that overlap
        (an earlier-started run without a report, or whose report is newer than this start).
        Depends on file mtimes only, so a restart assigns the same slugs."""
        order = sorted(
            (m["start"], rid) for rid, m in self._meta.items() if m["start"] is not None
        )
        for i, (start, rid) in enumerate(order):
            m = self._meta[rid]
            if m["agent"] is not None:
                continue
            taken = set()
            for _s2, r2 in order[:i]:
                m2 = self._meta[r2]
                if m2["capsule"] != m["capsule"] or m2["slot"] is None:
                    continue
                if m2["end"] is None or m2["end"] > start:
                    taken.add(m2["slot"])
            slot = 1
            while slot in taken:
                slot += 1
            base = _agent_base(m["capsule"])
            m["slot"] = slot
            m["agent"] = base if slot == 1 else "%s-%d" % (base, slot)

    def _get_state(self, run_id):
        st = self._state.get(run_id)
        if st is None:
            st = self._new_state(run_id)
            self._state[run_id] = st
        return st

    def _deliver(self, agent, act, text, plan=None, step=None):
        fn = self._post_fn
        if fn is None:
            raise RuntimeError("no post")
        kw = {}
        if plan is not None:
            kw["plan"] = plan
        if step is not None:
            kw["step"] = step
        kw["home"] = self.home
        kw["clock"] = self.clock
        fn(self.room, agent, act, text, **kw)

    # ---- scanning ----
    def _discover_runs(self):
        root = self.runs_root
        runs = []
        if not os.path.isdir(root):
            return runs

        def visit(dir_path, rel):
            try:
                names = os.listdir(dir_path)
            except OSError:
                self._errors += 1
                return
            has_files = False
            subdirs = []
            for name in names:
                p = os.path.join(dir_path, name)
                if os.path.islink(p):
                    if rel != "" or dir_path != root:
                        has_files = True
                    else:
                        # symlink at root level: indicates nothing; if it is a dir
                        # symlink it is skipped as a run (has_files irrelevant)
                        # mark has_files False so root handling descends correctly
                        pass
                    continue
                try:
                    if os.path.isdir(p):
                        subdirs.append(name)
                    else:
                        has_files = True
                except OSError:
                    continue
            if dir_path == root:
                for sub in sorted(subdirs):
                    visit(os.path.join(dir_path, sub), sub)
                return
            if has_files or not subdirs:
                runs.append((rel, dir_path))
            else:
                for sub in sorted(subdirs):
                    visit(os.path.join(dir_path, sub), rel + "/" + sub)

        visit(root, "")
        return runs

    def _list_run_files(self, run_id, run_dir):
        """Return (json_entries, new_nonjson_names). json_entries: list of dicts."""
        try:
            names = os.listdir(run_dir)
        except OSError:
            self._errors += 1
            return [], []
        entries = []
        new_nonjson = []
        for name in names:
            p = os.path.join(run_dir, name)
            if os.path.islink(p):
                continue
            if not name.endswith(".json"):
                # count non-json without opening
                key = (run_id, name)
                if key not in self._counted_nonjson:
                    self._counted_nonjson.add(key)
                    new_nonjson.append(name)
                continue
            try:
                st = os.lstat(p)
            except OSError:
                self._errors += 1
                continue
            # only regular files
            import stat as _stat

            if not _stat.S_ISREG(st.st_mode):
                continue
            entries.append(
                {"name": name, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
            )
        return entries, new_nonjson

    def _read_json(self, run_dir, name):
        p = os.path.join(run_dir, name)
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)

    # ---- parsing ----
    def _parse_intent(self, obj):
        if not isinstance(obj, dict):
            raise ValueError("bad")
        action = obj.get("action")
        if not isinstance(action, dict):
            raise ValueError("bad")
        t = action.get("type")
        if not isinstance(t, str) or t == "":
            raise ValueError("bad")
        target = obj.get("target")
        if target is None:
            target = {}
        if not isinstance(target, dict):
            target = {}
        goal = obj.get("goal")
        if not isinstance(goal, str):
            goal = ""
        label = _label(action, target, 0)
        title = _title(goal)
        name = target.get("name")
        if not isinstance(name, str):
            name = ""
        return {"label": label, "title": title, "goal": goal, "name": name}

    def _parse_receipt(self, obj):
        if not isinstance(obj, dict):
            raise ValueError("bad")
        ver = obj.get("verification")
        status = ""
        reason = ""
        if isinstance(ver, dict):
            s = ver.get("status")
            if isinstance(s, str):
                status = s
            r = ver.get("reason")
            if isinstance(r, str):
                reason = r
        done = status.strip().lower() in ("verified", "ok", "pass")
        if status and reason:
            outcome = "%s: %s" % (status, reason)
        elif status:
            outcome = status
        elif reason:
            outcome = reason
        else:
            outcome = "blocked"
        outcome = _redact(outcome)
        return done, outcome

    def _parse_report(self, obj):
        if not isinstance(obj, dict):
            raise ValueError("bad")
        rc = obj.get("rc")
        if isinstance(rc, bool) or not isinstance(rc, int):
            rc = 0
        verdict = obj.get("verdict_code")
        if not isinstance(verdict, str):
            verdict = ""
        verdict = _redact(verdict)
        return rc, verdict

    # ---- rebuild (silent) ----
    def _rebuild_run(self, run_id, run_dir, entries):
        st = self._new_state(run_id)
        st["agent"] = self._agent_of(run_id)
        self._state[run_id] = st
        # collect processed entries with meta ordering
        intents = []
        receipts = []
        reports = []
        for e in entries:
            key = (run_id, e["name"])
            if key not in self._processed:
                continue
            if e["size"] > MAX_SIZE:
                continue
            name = e["name"]
            # order key: stored mtime if known else current
            mt = self._cursor_meta.get(key, (0, e["mtime_ns"]))[1]
            item = (mt, name, e)
            if name.startswith("intent-") and name.endswith(".json"):
                intents.append(item)
            elif name.startswith("receipt-") and name.endswith(".json"):
                receipts.append(item)
            elif name == "report.json":
                reports.append(item)
            else:
                continue
        intents.sort(key=lambda x: (x[0], x[1]))
        receipts.sort(key=lambda x: (x[0], x[1]))
        reports.sort(key=lambda x: (x[0], x[1]))
        for _mt, name, e in intents:
            try:
                obj = self._read_json(run_dir, name)
                parsed = self._parse_intent(obj)
            except Exception:
                continue
            pid = name[len("intent-") : -len(".json")]
            idx = len(st["labels"])
            st["labels"].append(parsed["label"])
            if pid not in st["pid_to_index"]:
                st["pid_to_index"][pid] = idx
            if st["title"] is None:
                st["title"] = _task_title(self._capsule_of(run_id, parsed), parsed["goal"])
            if idx < MAX_STEPS:
                st["step_state"].setdefault(idx, "active")
        for _mt, name, e in receipts:
            try:
                obj = self._read_json(run_dir, name)
                done, _outcome = self._parse_receipt(obj)
            except Exception:
                continue
            pid = name[len("receipt-") : -len(".json")]
            idx = st["pid_to_index"].get(pid)
            if idx is None or idx >= MAX_STEPS or st["closed"]:
                continue
            st["step_state"][idx] = "done" if done else "blocked"
        for _mt, name, e in reports:
            try:
                obj = self._read_json(run_dir, name)
                rc, _verdict = self._parse_report(obj)
            except Exception:
                continue
            if st["closed"]:
                continue
            if rc != 0:
                for idx in sorted(st["step_state"].keys()):
                    if st["step_state"][idx] == "active" and idx < MAX_STEPS:
                        st["step_state"][idx] = "blocked"
            st["closed"] = True
        return st

    def prime(self):
        try:
            if self._corrupt:
                # will be overwritten by _save_cursor
                pass
            runs = self._discover_runs()
            self._runs = len(runs)
            listings = {}
            for run_id, run_dir in runs:
                entries, _nn = self._list_run_files(run_id, run_dir)
                listings[run_id] = entries
                self._scan_meta(run_id, run_dir, entries)
            self._assign_agents()
            for run_id, run_dir in runs:
                entries = listings[run_id]
                for e in entries:
                    key = (run_id, e["name"])
                    if key not in self._processed:
                        self._processed.add(key)
                        self._cursor_meta[key] = (e["size"], e["mtime_ns"])
                self._rebuild_run(run_id, run_dir, entries)
            # refresh steps stat
            self._steps = sum(len(s["labels"]) for s in self._state.values())
            self._save_cursor()
            self._corrupt = False
        except Exception:
            self._errors += 1

    def poll(self):
        try:
            if self._corrupt:
                # prime without reposting history
                self._corrupt = False
                self._processed = set()
                self._cursor_meta = {}
                self.prime()
                return 0
            posted = 0
            try:
                runs = self._discover_runs()
            except Exception:
                return 0
            self._runs = len(runs)
            # snapshot runs that disappeared? keep state; stats runs reflects latest scan
            changed_cursor = False
            listings = {}
            for run_id, run_dir in sorted(runs, key=lambda x: x[0]):
                try:
                    listings[run_id] = self._list_run_files(run_id, run_dir)
                    self._scan_meta(run_id, run_dir, listings[run_id][0])
                except Exception:
                    self._errors += 1
            try:
                self._assign_agents()
            except Exception:
                self._errors += 1
            for run_id, run_dir in sorted(runs, key=lambda x: x[0]):
                if run_id not in listings:
                    continue
                try:
                    sub_posted = self._poll_run(run_id, run_dir, listings[run_id])
                    posted += sub_posted
                except Exception:
                    self._errors += 1
                    continue
                if self._processed:
                    changed_cursor = True
            if changed_cursor:
                self._save_cursor()
            # steps stat
            self._steps = sum(len(s["labels"]) for s in self._state.values())
            return posted
        except Exception:
            self._errors += 1
            return 0

    def _poll_run(self, run_id, run_dir, listing=None):
        posted = 0
        if listing is None:
            listing = self._list_run_files(run_id, run_dir)
        entries, new_nonjson = listing
        for _n in new_nonjson:
            self._skipped_large_dummy = None  # no-op
            self._skipped_nonjson += 1
        st = self._rebuild_run(run_id, run_dir, entries)
        agent = st["agent"]
        # classify new files
        new_entries = []
        for e in entries:
            if (run_id, e["name"]) not in self._processed:
                new_entries.append(e)
        # large handling
        live = []
        for e in sorted(new_entries, key=lambda x: (x["mtime_ns"], x["name"])):
            if e["size"] > MAX_SIZE:
                self._skipped_large += 1
                self._processed.add((run_id, e["name"]))
                self._cursor_meta[(run_id, e["name"])] = (e["size"], e["mtime_ns"])
            else:
                live.append(e)

        def sort_key(e):
            return (e["mtime_ns"], e["name"])

        live_intents = sorted(
            [e for e in live if e["name"].startswith("intent-")], key=sort_key
        )
        live_receipts = sorted(
            [e for e in live if e["name"].startswith("receipt-")], key=sort_key
        )
        live_reports = sorted(
            [e for e in live if e["name"] == "report.json"], key=sort_key
        )
        live_other = [
            e
            for e in live
            if not e["name"].startswith("intent-")
            and not e["name"].startswith("receipt-")
            and e["name"] != "report.json"
        ]
        for e in live_other:
            self._processed.add((run_id, e["name"]))
            self._cursor_meta[(run_id, e["name"])] = (e["size"], e["mtime_ns"])

        # intents
        for e in live_intents:
            name = e["name"]
            pid = name[len("intent-") : -len(".json")]
            if pid == "":
                self._errors += 1
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            try:
                obj = self._read_json(run_dir, name)
                parsed = self._parse_intent(obj)
            except Exception:
                self._errors += 1
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            idx = len(st["labels"])
            new_title = _task_title(self._capsule_of(run_id, parsed), parsed["goal"])
            title = st["title"] if st["title"] is not None else new_title
            st["labels"].append(parsed["label"])
            if pid not in st["pid_to_index"]:
                st["pid_to_index"][pid] = idx
            if st["title"] is None:
                st["title"] = new_title
                title = st["title"]
            if idx >= MAX_STEPS:
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            # post plan then step
            steps_payload = [{"text": lb} for lb in st["labels"][:MAX_STEPS]]
            plan = {"title": title if title is not None else "", "steps": steps_payload}
            step_active = {"index": idx, "state": "active"}
            # snapshot for rollback on failure
            prior_state = dict(st["step_state"])
            prior_labels_len = len(st["labels"]) - 1
            try:
                self._deliver(agent, "plan", plan["title"], plan=plan)
                posted += 1
                self._deliver(agent, "step", st["labels"][idx], step=step_active)
                posted += 1
            except Exception:
                self._errors += 1
                # rollback state for this intent
                st["labels"] = st["labels"][:prior_labels_len]
                st["step_state"] = prior_state
                if st["pid_to_index"].get(pid) == idx:
                    del st["pid_to_index"][pid]
                if len(st["labels"]) == 0:
                    st["title"] = None
                # do not mark processed; retry later
                continue
            st["step_state"][idx] = "active"
            self._processed.add((run_id, name))
            self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])

        # receipts
        for e in live_receipts:
            name = e["name"]
            pid = name[len("receipt-") : -len(".json")]
            try:
                obj = self._read_json(run_dir, name)
                done, outcome = self._parse_receipt(obj)
            except Exception:
                self._errors += 1
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            idx = st["pid_to_index"].get(pid)
            if idx is None or idx >= MAX_STEPS or st["closed"]:
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            # if already resolved, still? spec at-most-once per file ensures one receipt per pid normally
            # but guard double receipt for same pid: only first counts
            if st["step_state"].get(idx) in ("done", "blocked"):
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            state = "done" if done else "blocked"
            outc = outcome
            if len(st["labels"]) > MAX_STEPS and idx == MAX_STEPS - 1:
                # 12th outcome says more steps not shown
                suffix = "more steps not shown"
                if suffix not in outc:
                    if len(outc) + 1 + len(suffix) <= 240:
                        outc = outc + " " + suffix
                    else:
                        keep = 240 - len(suffix) - 1
                        outc = (outc[:keep] + " " + suffix)[:240]
            outc = outc[:240]
            step_obj = {"index": idx, "state": state, "outcome": outc}
            text = outc
            try:
                self._deliver(agent, "step", text, step=step_obj)
                posted += 1
            except Exception:
                self._errors += 1
                continue
            st["step_state"][idx] = state
            self._processed.add((run_id, name))
            self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])

        # report
        for e in live_reports:
            name = e["name"]
            if st["closed"]:
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            try:
                obj = self._read_json(run_dir, name)
                rc, verdict = self._parse_report(obj)
            except Exception:
                self._errors += 1
                self._processed.add((run_id, name))
                self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
                continue
            # block active first if rc != 0
            try:
                if rc != 0:
                    for idx in sorted(st["step_state"].keys()):
                        if st["step_state"][idx] == "active" and idx < MAX_STEPS:
                            bout = _redact("blocked: report rc %s" % rc)[:240]
                            if len(st["labels"]) > MAX_STEPS and idx == MAX_STEPS - 1:
                                suffix = "more steps not shown"
                                if suffix not in bout:
                                    bout = (bout + " " + suffix)[:240]
                            self._deliver(
                                agent,
                                "step",
                                bout,
                                step={"index": idx, "state": "blocked", "outcome": bout},
                            )
                            posted += 1
                            st["step_state"][idx] = "blocked"
                close_text = "%s (rc %s)" % (verdict, rc)
                close_text = _redact(close_text)[:4096] if False else close_text
                # verdict already redacted; ensure not over limit (store allows 4096)
                self._deliver(agent, "close", close_text)
                posted += 1
            except Exception:
                self._errors += 1
                continue
            st["closed"] = True
            self._processed.add((run_id, name))
            self._cursor_meta[(run_id, name)] = (e["size"], e["mtime_ns"])
        return posted

    def stats(self):
        return {
            "runs": int(self._runs),
            "steps": int(sum(len(s["labels"]) for s in self._state.values())),
            "skipped_large": int(self._skipped_large),
            "skipped_nonjson": int(self._skipped_nonjson),
            "errors": int(self._errors),
        }
