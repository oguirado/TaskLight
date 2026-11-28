"""Context command responses use UTF-8 regardless of console settings."""
import io
import json
import unittest
from unittest.mock import patch

from bridge.ctx import __main__ as cli


class ConsoleEncoding(unittest.TestCase):
    def test_usage_response_is_utf8_with_ascii_stdout(self):
        raw = io.BytesIO()
        with io.TextIOWrapper(raw, encoding="ascii", newline="\r\n") as stdout:
            with patch.object(cli.sys, "stdout", stdout):
                code = cli.main(["page", "--path", "café", "--unknown", "x"])
            stdout.flush()
            response = raw.getvalue()
        self.assertEqual(code, 2)
        self.assertTrue(response.endswith(b"\n"))
        self.assertNotIn(b"\r", response)
        self.assertEqual(json.loads(response.decode("utf-8"))["data"]["path"], "café")
