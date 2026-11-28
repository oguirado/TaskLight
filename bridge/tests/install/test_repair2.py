"""Installer and room-store defaults must select the same data directory."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge import install
from bridge.room import store


class SharedDataDirectory(unittest.TestCase):
    def check_data_directory(self, explicit):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            home = Path(temp).resolve() / "home"
            home.mkdir()
            expected = home / ("custom-rooms" if explicit else ".context-wall")
            env = {"HOME": str(home), "USERPROFILE": str(home)}
            if explicit:
                env["CW_HOME"] = str(expected)
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(install.sys, "platform", "linux"), \
                    contextlib.redirect_stdout(io.StringIO()):
                result = install.main(["--apply", "--extension-id", "a" * 32])
                self.assertEqual(result, 0)
                room_home = store._home(None)
                self.assertEqual(Path(room_home), expected)
                config_path = expected / "wall.config.json"
                self.assertTrue(config_path.is_file())
                config = json.loads(config_path.read_text(encoding="utf-8"))
                self.assertEqual(config["rooms"]["home"], room_home)

    def test_unset_cw_home_matches_room_store(self):
        self.check_data_directory(explicit=False)

    def test_explicit_cw_home_matches_room_store(self):
        self.check_data_directory(explicit=True)
