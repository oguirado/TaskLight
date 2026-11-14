"""RoomObserver wall bridge."""

import glob
import json
import os


class RoomObserver:
    def __init__(self, rooms_glob, emit_fn):
        self.rooms_glob = rooms_glob
        self.emit_fn = emit_fn
        self._cursors = {}

    @staticmethod
    def _canon(obj):
        return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    @staticmethod
    def _emit_ok(res):
        """Did emit_fn succeed? Dict results use ok/rc; legacy bools unchanged."""
        if isinstance(res, dict):
            if "ok" in res:
                return bool(res["ok"])
            if "rc" in res:
                return res["rc"] == 0
            return bool(res)
        return bool(res)

    def poll(self):
        paths = sorted(glob.glob(self.rooms_glob))
        for p in paths:
            if not os.path.isdir(p):
                continue
            room = os.path.basename(os.path.normpath(p))
            if not room:
                continue
            epath = os.path.join(p, "events.jsonl")
            if not os.path.isfile(epath):
                continue
            try:
                with open(epath, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            offset = self._cursors.get(room, 0)
            if offset > len(data):
                offset = 0
            content = data[offset:]
            if not content:
                continue
            ends = content.endswith(b"\n")
            parts = content.split(b"\n")
            pos = 0
            for i, raw in enumerate(parts):
                is_last = i == len(parts) - 1
                if ends and is_last:
                    break
                if not ends and is_last:
                    break  # torn tail: leave for next poll
                line_len = len(raw) + 1  # +1 for \n
                if raw.strip() == b"":
                    pos += line_len
                    continue
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception:
                    pos += line_len
                    continue
                if not isinstance(obj, dict):
                    pos += line_len
                    continue
                try:
                    res = self.emit_fn(project=room, kind="agent_event",
                                       text=self._canon(obj), source="agent")
                except Exception:
                    break
                if not self._emit_ok(res):
                    break
                pos += line_len
            self._cursors[room] = offset + pos
