"""Headless guide discovery and read contracts through the MCP dispatcher."""
import contextlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from bridge.room import mcp

URI = "tasklight://guide/headless"
GUIDE = Path(__file__).resolve().parents[4] / "docs" / "HEADLESS.md"


class HeadlessResourceTest(unittest.TestCase):
    def setUp(self):
        home = Path(__file__).resolve().parent / ".resource-home"
        env = patch.dict(os.environ, {"CW_HOME": str(home)})
        env.start()
        self.addCleanup(env.stop)

    def rpc(self, method, **params):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            mcp._handle(1, method, params)
        reply = json.loads(output.getvalue())
        self.assertEqual((reply["jsonrpc"], reply["id"]), ("2.0", 1))
        return reply

    def guide_bytes(self, data):
        original = open

        def replacement(path, *args, **kwargs):
            if Path(path) == GUIDE:
                if data is None:
                    raise FileNotFoundError("guide unavailable")
                return io.BytesIO(data)
            return original(path, *args, **kwargs)

        return patch("builtins.open", side_effect=replacement)

    def assert_content(self, text):
        self.assertEqual(self.rpc("resources/read", uri=URI)["result"], {
            "contents": [{"uri": URI, "mimeType": "text/markdown", "text": text}]})

    def assert_unavailable(self):
        resources = self.rpc("resources/list")["result"]["resources"]
        self.assertNotIn(URI, [r["uri"] for r in resources])
        guide = self.rpc("resources/read", uri=URI)
        with patch.object(mcp, "_contract_text", return_value=None):
            contract = self.rpc("resources/read", uri="tasklight://contract")
        self.assertEqual(guide["error"], contract["error"])
        self.assertEqual(guide["error"], {"code": -32002, "message": "resource not found"})

    def test_listed_once_immediately_after_contract(self):
        resources = self.rpc("resources/list")["result"]["resources"]
        index = [r["uri"] for r in resources].index("tasklight://contract")
        self.assertEqual(resources[index + 1], {
            "uri": URI, "name": "headless guide", "mimeType": "text/markdown"})
        self.assertEqual(sum(r["uri"] == URI for r in resources), 1)

    def test_read_returns_exact_shipped_file(self):
        self.assert_content(GUIDE.read_text(encoding="utf-8"))

    def test_unknown_uri_still_invalid(self):
        for uri in ("tasklight://guide/unknown", URI + "/extra"):
            with self.subTest(uri=uri):
                self.assertEqual(self.rpc("resources/read", uri=uri)["error"]["code"], -32602)
        self.assert_content(GUIDE.read_text(encoding="utf-8"))

    def test_missing_file_matches_contract_error(self):
        with self.guide_bytes(None):
            self.assert_unavailable()

    def test_size_bound_counts_utf8_bytes_inclusively(self):
        text = "é" * (mcp._CONTRACT_MAX_BYTES // 2)
        with self.guide_bytes(text.encode("utf-8")):
            self.assert_content(text)
        with self.guide_bytes(text.encode("utf-8") + b"x"):
            self.assert_unavailable()

    def test_invalid_utf8_matches_contract_error(self):
        with self.guide_bytes(b"\xff"):
            self.assert_unavailable()

    def test_empty_file_and_fresh_reads(self):
        for text in ("", "First\n", "Updated café\n"):
            with self.subTest(text=text), self.guide_bytes(text.encode("utf-8")):
                self.assert_content(text)
