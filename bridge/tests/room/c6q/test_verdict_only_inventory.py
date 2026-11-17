"""C6q: a verdict-only result (A-C6b) never breaks the inventory's last_result."""
from bridge.room.ext.inventory import derive_inventory
from ..c6.support import RoomCase


class VerdictOnlyInventory(RoomCase):
    def test_last_result_with_verdict_only(self):
        self.life(agent="lane-1", state="finished", result={"verdict": "ADMIT"})
        inv = derive_inventory("demo", self.events(), 10 ** 13)
        row = next(r for r in inv["agents"] if r["agent"] == "lane-1")
        self.assertEqual(row["last_result"]["verdict"], "ADMIT")
        self.assertIsNone(row["last_result"]["summary"])
        self.assertIsNone(row["last_result"]["receipt"])
