"""Safety and behavior checks for the authenticated Minecraft file manager."""
from __future__ import annotations

import base64
from pathlib import Path
import tempfile
import unittest

from server.runtime_bridge import LiveBridge


class LiveFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bridge = object.__new__(LiveBridge)
        self.bridge.data = self.root

    def run_command(self, kind, **args):
        return self.bridge._execute({"type": kind, "args": args})

    def test_automatic_tree_and_root_listing(self):
        (self.root / "world").mkdir()
        (self.root / "plugins").mkdir()
        (self.root / "plugins" / "example.yml").write_text("enabled: true")
        tree = self.run_command("files-tree")
        names = [entry["name"] for entry in tree["roots"]]
        self.assertIn("world", names)
        self.assertIn("plugins", names)
        listing = self.run_command("files-list", path="plugins")
        self.assertEqual(listing["entries"][0]["path"], "plugins/example.yml")
        self.assertEqual(listing["entries"][0]["type"], "file")
        self.assertIn("modified", listing["entries"][0])

    def test_create_upload_download_rename_delete(self):
        (self.root / "plugins").mkdir()
        self.run_command("files-mkdir", path="plugins/config")
        data = b"enabled: true\n"
        self.run_command("files-upload", path="plugins/config/example.yml",
                         content=base64.b64encode(data).decode("ascii"))
        read = self.run_command("files-read", path="plugins/config/example.yml")
        self.assertEqual(read["content"], data.decode())
        downloaded = self.run_command("files-download", path="plugins/config/example.yml")
        self.assertEqual(base64.b64decode(downloaded["content"]), data)
        self.run_command("files-rename", path="plugins/config/example.yml",
                         target="plugins/config/moved.yml")
        self.assertFalse((self.root / "plugins/config/example.yml").exists())
        self.run_command("files-delete", path="plugins/config/moved.yml")
        self.assertFalse((self.root / "plugins/config/moved.yml").exists())

    def test_protected_world_and_sensitive_credentials(self):
        for world in ("world", "world_nether", "world_the_end", "world_custom"):
            (self.root / world).mkdir()
            (self.root / world / "info.txt").write_text("keep")
            with self.assertRaises(ValueError):
                self.run_command("files-write", path=world+"/info.txt", content="changed")
        (self.root / "plugins/Geyser-Spigot").mkdir(parents=True)
        (self.root / "plugins/Geyser-Spigot/config.yml").write_text("signaling: SECRET")
        with self.assertRaises(ValueError):
            self.run_command("files-read", path="plugins/Geyser-Spigot/config.yml")
        (self.root / "plugins/floodgate").mkdir()
        (self.root / "plugins/floodgate/key.pem").write_bytes(b"secret")
        with self.assertRaises(ValueError):
            self.run_command("files-download", path="plugins/floodgate/key.pem")

    def test_reject_escape_and_symlink_alias(self):
        (self.root / "world").mkdir()
        (self.root / "world/note.txt").write_text("keep")
        (self.root / "world_link").symlink_to(self.root / "world",target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_command("files-write", path="world_link/note.txt", content="changed")
        with self.assertRaises(ValueError):
            self.run_command("files-read", path="../secret.txt")
        with self.assertRaises(ValueError):
            self.run_command("files-mkdir", path=".hidden")

    def test_protected_config_and_binary_upload(self):
        (self.root / "plugins").mkdir()
        (self.root / "server.properties").write_text("max-players=5")
        with self.assertRaises(ValueError):
            self.run_command("files-write", path="server.properties", content="max-players=100")
        with self.assertRaises(ValueError):
            self.run_command("files-upload", path="plugins/example.jar",
                             content=base64.b64encode(b"jar").decode())
        with self.assertRaises(ValueError):
            self.run_command("files-rename", path="server.properties",target="renamed.properties")


if __name__=="__main__":
    unittest.main()
