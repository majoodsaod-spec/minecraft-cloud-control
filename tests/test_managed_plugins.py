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
        archive.writestr("data.bin", b"x"*2048)
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

    def test_analyzer_selects_only_current_monitoring_release(self):
        versions = [
            {"version_number":"2.9.0","version_type":"release","game_versions":["26.3"],
             "loaders":["paper"],"files":[{"filename":"old.jar","url":"https://cdn.example/old.jar",
                                            "hashes":{"sha256":"old"}}]},
            {"version_number":"3.1.2","version_type":"release","game_versions":["26.3"],
             "loaders":["paper"],"files":[{"filename":"analyzer.jar","url":"https://cdn.example/analyzer.jar",
                                            "primary":True,"hashes":{"sha256":"safe"}}]}
        ]
        with patch.object(managed_plugins,"fetch_json",return_value=versions):
            self.assertEqual(managed_plugins.analyzer_build(),("https://cdn.example/analyzer.jar","safe"))

    def test_analyzer_never_falls_back_to_older_entity_cleaner(self):
        versions = [{"version_number":"2.9.0","version_type":"release",
                     "game_versions":["26.3"],"loaders":["paper"],
                     "files":[{"filename":"old.jar","url":"https://cdn.example/old.jar"}]}]
        with patch.object(managed_plugins,"fetch_json",return_value=versions):
            with self.assertRaisesRegex(RuntimeError,"No verified"):
                managed_plugins.analyzer_build()

    def test_lmd_requires_paper_263_verified_release(self):
        versions = [
            {"version_number":"1.26.11.1","version_type":"release","game_versions":["26.3"],
             "loaders":["fabric"],"files":[{"filename":"fabric.jar","url":"https://cdn.example/fabric.jar",
                                             "hashes":{"sha256":"a"*64}}]},
            {"version_number":"1.26.10.3","version_type":"release","game_versions":["26.3"],
             "loaders":["paper","bukkit"],"files":[{"filename":"LetMeDespawn-1.26.10.3.jar",
                         "url":"https://cdn.example/LetMeDespawn-1.26.10.3.jar",
                         "hashes":{"sha256":"b"*64}}]}
        ]
        with patch.object(managed_plugins,"fetch_json",return_value=versions):
            self.assertEqual(managed_plugins.let_me_despawn_build(),
                             ("https://cdn.example/LetMeDespawn-1.26.10.3.jar","b"*64))

    def test_lmd_never_accepts_fabric_jar_or_unverified_file(self):
        versions=[{"version_number":"1.26.10.3","version_type":"release","game_versions":["26.3"],
                   "loaders":["fabric"],"files":[{"filename":"fabric.jar","url":"https://cdn.example/fabric.jar",
                                                 "hashes":{"sha256":"a"*64}}]}]
        with patch.object(managed_plugins,"fetch_json",return_value=versions):
            with self.assertRaisesRegex(RuntimeError,"No verified"):
                managed_plugins.let_me_despawn_build()

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
        self.assertEqual(result["bedrock"]["address"],"0.0.0.0")
        self.assertEqual(result["bedrock"]["signaling"]["token"],"SECRET_FROM_ENV")

    def test_cached_geyser_and_floodgate_are_refreshed_on_every_session(self):
        folder=self.root/"plugins"
        folder.mkdir()
        payload=fake_plugin_jar()
        (folder/"Geyser-Spigot.jar").write_bytes(payload)
        (folder/"floodgate-spigot.jar").write_bytes(payload)
        enabled={"EssentialsX.jar":False,"Chunky.jar":False,
                 "PerformanceAnalyzer.jar":False,"LetMeDespawn.jar":False,
                 "Geyser-Spigot.jar":True,"floodgate-spigot.jar":True}
        def replace_jar(url,dest,checksum):
            dest.write_bytes(payload+b"refresh")
        with patch.object(managed_plugins,"geyser_build",return_value=("https://official.example/new.jar",None)):
            with patch.object(managed_plugins,"download_jar",side_effect=replace_jar) as download:
                installed=managed_plugins.install_managed_plugins(folder,enabled)
                self.assertEqual(download.call_count,2)
        self.assertIn("Geyser-Spigot.jar",installed)
        self.assertIn("floodgate-spigot.jar",installed)

    def test_cannot_refresh_does_not_remove_existing_valid_pair(self):
        folder=self.root/"plugins"
        folder.mkdir()
        payload=fake_plugin_jar()
        for name in ("Geyser-Spigot.jar","floodgate-spigot.jar"):
            (folder/name).write_bytes(payload)
        enabled={name:False for name in ("EssentialsX.jar","Chunky.jar",
                                        "PerformanceAnalyzer.jar","LetMeDespawn.jar")}
        with patch.object(managed_plugins,"geyser_build",side_effect=RuntimeError("temporary offline")):
            installed=managed_plugins.install_managed_plugins(folder,enabled)
        self.assertIn("Geyser-Spigot.jar",installed)
        self.assertIn("floodgate-spigot.jar",installed)
        self.assertEqual((folder/"Geyser-Spigot.jar").read_bytes(),payload)

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
