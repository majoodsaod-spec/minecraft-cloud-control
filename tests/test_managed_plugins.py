"""Offline unit tests for managed plugins and secure Geyser setup."""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import yaml
from server import managed_plugins, geyser_setup


def fake_plugin_jar(content=b"name: Example\nmain: com.example.Example\nversion: 1.0\n"):
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("plugin.yml",content)
    return buffer.getvalue()


class PluginInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def test_plugin_checksum_and_jar_structure(self):
        payload=fake_plugin_jar()
        checksum=hashlib.sha256(payload).hexdigest()
        with patch.object(managed_plugins.urllib.request,"urlopen",return_value=io.BytesIO(payload)):
            destination=self.root/"Example.jar"
            managed_plugins.download_jar("https://example.org/Example.jar",destination,checksum)
            self.assertEqual(destination.read_bytes(),payload)

    def test_mismatched_checksum_is_rejected(self):
        payload=fake_plugin_jar()
        with patch.object(managed_plugins.urllib.request,"urlopen",return_value=io.BytesIO(payload)):
            with self.assertRaisesRegex(ValueError,"checksum mismatch"):
                managed_plugins.download_jar("https://example.org/Example.jar",self.root/"Example.jar","0"*64)
        self.assertFalse((self.root/"Example.jar").exists())

    def test_chunky_requires_current_compatible_version(self):
        versions=[
            {"game_versions":["26.2"],"loaders":["paper"],"files":[{"url":"https://old.example/x.jar"}]},
            {"game_versions":["26.3"],"loaders":["paper"],"files":[
                {"url":"https://cdn.example/Chunky.jar","primary":True,"filename":"Chunky.jar","hashes":{"sha256":"abc"}}
            ]}
        ]
        with patch.object(managed_plugins,"fetch_json",return_value=versions):
            self.assertEqual(managed_plugins.chunky_build(),("https://cdn.example/Chunky.jar","abc"))

    def test_geyser_floodgate_auth_and_secret_overlay(self):
        folder=self.root/"plugins"
        folder.mkdir()
        template={"bedrock":{"port":19132,"transport":"raknet","signaling":{"mode":"builtin"}},"java":{"auth-type":"online"}}
        with zipfile.ZipFile(folder/"Geyser-Spigot.jar","w") as jar:
            jar.writestr("config.yml",yaml.safe_dump(template))
        playit="bedrock:\n  signaling:\n    mode: nxs\n    token: SECRET_FROM_ENV\n"
        with patch.dict(os.environ,{"GEYSER_PLAYIT_CONFIG":playit}):
            geyser_setup.configure_geyser(self.root)
        result=yaml.safe_load((folder/"Geyser-Spigot"/"config.yml").read_text())
        self.assertEqual(result["java"]["auth-type"],"floodgate")
        self.assertEqual(result["bedrock"]["transport"],"nethernet")
        self.assertEqual(result["bedrock"]["port"],19132)
        self.assertEqual(result["bedrock"]["signaling"]["token"],"SECRET_FROM_ENV")

    def test_bad_playit_configuration_is_rejected(self):
        folder=self.root/"plugins"
        folder.mkdir()
        with zipfile.ZipFile(folder/"Geyser-Spigot.jar","w") as jar:
            jar.writestr("config.yml", "bedrock: {}\njava: {}\n")
        with patch.dict(os.environ,{"GEYSER_PLAYIT_CONFIG":"not: playit"}):
            with self.assertRaisesRegex(RuntimeError,"bedrock"):
                geyser_setup.configure_geyser(self.root)


if __name__ == "__main__":
    unittest.main()
