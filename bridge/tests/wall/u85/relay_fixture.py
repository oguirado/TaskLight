"""Fixture driver: real RoomRelay/fold, with only the journal reader replaced."""
import copy
import json
from pathlib import Path
from unittest.mock import patch

from bridge.wall import room_relay as relay_module
from bridge.plan.fold import fold_plan

ROOT = Path(__file__).resolve().parents[4]
CURRENT_HASH = "2b504639f69d0f5ced71cbee6bd4363d838aa6536b37d69b6cf21154060fbe65"
HISTORICAL_HASH = "19e0b7d9f2aebc331061f4d9199343ef28b2f2f1302395319f52b2394574bf1f"
FLOOR = "ONLY_ON_DEVICE"


def fixture():
    return json.loads((ROOT / "tests/unit/u85/fixture.json").read_text())


def event(lamport, **extra):
    return dict(id=f"e-{lamport:016x}", room="demo", agent="alice", act="heartbeat",
                text="", ts=1700000000000 + lamport, lamport=lamport, **extra)


def triplet(reason=None):
    events = [event(n) for n in (7, 8, 9)]
    if reason == "oversize":
        events[1]["text"] = "ordinary words " * 6000
    return events


class RelayFixture:
    """The read boundary is fake; sanitizer, frame sizing and traversal are real."""
    def __init__(self, events, reason=None, send_failure=None):
        self.events = copy.deepcopy(events)
        self.reason = reason
        self.send_failure = send_failure
        self.sent = []
        self.attempted = []
        self.reads = []
        self.relay = relay_module.RoomRelay(
            {"rooms": [{"room": "demo", "floor": FLOOR}], "agent": "alice"},
            self.send, clock=lambda: 0.0)

    def read(self, room, since, **_kwargs):
        self.reads.append((room, since))
        return ([copy.deepcopy(e) for e in self.events
                 if e["room"] == room and e["lamport"] > since], 0)

    def send(self, frame):
        self.attempted.append(copy.deepcopy(frame))
        if self.send_failure is not None and self.send_failure(frame):
            raise OSError("synthetic send failure")
        self.sent.append(copy.deepcopy(frame))

    def run(self, mode="live", since=0, rid="replay-1"):
        real_sanitize = relay_module.sanitize_event

        def sanitize(ev):
            if self.reason == "sanitize_failed" and ev["lamport"] == 8:
                return None
            return real_sanitize(ev)

        with patch.object(relay_module.store, "read", side_effect=self.read), \
                patch.object(relay_module, "sanitize_event", side_effect=sanitize):
            if mode == "live":
                self.relay.poll()
            else:
                self.relay.handle({"t": "room_sync", "v": 1, "rid": rid,
                                   "since": {"demo": since}})
        return self.sent


def main():
    import sys
    req = json.load(sys.stdin)
    data = fixture()
    events = req.get("events", data["events"])
    if req.get("triplet"):
        events = triplet(req.get("reason"))
    driver = RelayFixture(events, reason=req.get("reason"))
    frames = driver.run(req.get("mode", "replay"), req.get("since", 0))
    projection = fold_plan(events, templates={data["template"]["id"]: data["template"]})
    print(json.dumps({"frames": frames, "projection": projection}))


if __name__ == "__main__":
    main()
