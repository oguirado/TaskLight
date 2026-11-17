"""AC1/AC2/AC4: admitted routes, legacy isolation and runtime fencing refusal."""
import json
from unittest.mock import patch

from bridge.room import store

from .support import (ROOT, LEGACY, NEW, PLAN_ROUTES, ROUTES,
                      MailboxCase, expected_call, request)


class RoutingOracle(MailboxCase):
    def test_unadmitted_slice_two_refuses_startup_before_dispatch(self):
        self.configure(slice=2)
        value = request()
        path = self.publish(value)
        before = path.read_bytes()
        # A-U143a: admission is cleared; missing runtime fencing still refuses.
        with patch.object(store, "post", lambda *args, **kwargs: self.fail("unfenced write")), self.spy() as dispatch:
            self.assertEqual(self.invoke(), 2)
        self.assertIn("planning delivery awaits atomic backend generation fencing", self.stderr)
        dispatch.assert_not_called()
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(self.receipt_path(value).exists())
        self.assertEqual(self.journal_bytes(), {})

    def test_slice_one_capabilities_retains_legacy_and_holds_all_new_kinds(self):
        value = request("capabilities", {})
        with self.spy() as dispatch:
            result = self.success(value, admitted=False)
        self.assertEqual(set(result["kinds"]), LEGACY)
        self.assertTrue(NEW.isdisjoint(result["kinds"]))
        dispatch.assert_not_called()

    def test_documented_default_configuration_remains_slice_one(self):
        text = (ROOT / "docs/FAMILY_CHANNEL.md").read_text(encoding="utf-8")
        configs = []
        for line in text.splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and {"endpoint", "rooms", "sources", "slice"} <= value.keys():
                configs.append(value)
        self.assertTrue(configs, "public channel guide must retain a default configuration example")
        self.assertTrue(any(config["slice"] == 1 for config in configs),
                        "public default example must keep slice:1 available")


def route_case(row):
    label, kind, tool, payload = row
    def test(self):
        self.configure(slice=2)
        value = request(kind, payload)
        with self.spy() as dispatch:
            # A-U143a: explicit slice:2 uses the real startup dependency check.
            result = self.success(value, admitted=False)
        name, args = expected_call(value, tool)
        dispatch.assert_called_once_with(name, args)
        self.assertEqual(result, {"ok": True, "marker": "backend"})
    return test


def slice_one_case(row):
    label, kind, tool, payload = row
    def test(self):
        # A-U143a: the default slice-one configuration still rejects new kinds.
        value = request(kind, payload)
        self.publish(value)
        with self.spy() as dispatch:
            self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.receipt(value).get("code"), "bad_args")
        dispatch.assert_not_called()
        self.assertEqual(self.journal_bytes(), {})
    return test


for _row in ROUTES + PLAN_ROUTES:
    setattr(RoutingOracle, "test_admitted_routes_" + _row[0], route_case(_row))
for _row in ROUTES:
    setattr(RoutingOracle, "test_slice_one_rejects_" + _row[0], slice_one_case(_row))
