"""C2q (C2 review debt 1): an event whose `op` is null or not an object never crashes the inventory."""
import unittest

from bridge.room.ext.inventory import derive_inventory


class NullOp(unittest.TestCase):
    def test_null_and_non_dict_op_are_ignored(self):
        events = [
            {"id": "e1", "lamport": 1, "ts": 1000, "room": "demo", "agent": "worker-1", "act": "op", "op": None, "text": ""},
            {"id": "e2", "lamport": 2, "ts": 1001, "room": "demo", "agent": "worker-1", "act": "op", "op": "x", "text": ""},
        ]
        out = derive_inventory("demo", events, 2000)
        self.assertIsInstance(out, dict)


if __name__ == "__main__":
    unittest.main()
