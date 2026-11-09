"""Phase 2 regression tests: managed plugins and privacy-minimal player admin."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from collections import deque
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"server"))
from pending_content_actions import apply_content_actions, desired_actions
from pending_modrinth import apply_modrinth_queue
from runtime_bridge import LiveBridge
from modrinth_install import installed_inventory


class ManagedContentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.data=self.root/"data"
        (self.data/"plugins").mkdir(parents=True)
        self.manifest=self.root/"actions.json"
        self.project="Proj123"
        self.jar=self.data/"plugins"/"modrinth-Proj123.jar"
        self.jar.write_bytes(b"verified-jar-placeholder")
        (self.data/"plugins"/".modrinth-installed.json").write_text(json.dumps({
            self.project:{"kind":"plugin","title":"Example","versionId":"Ver123",
                          "version":"1.0.0","enabled":True}
        }))
        folder=self.data/"plugins"/"Example"
        folder.mkdir()
        (folder/"config.yml").write_text("keep: true",encoding="utf-8")

    def stage(self,action):
        self.manifest.write_text(json.dumps({self.project:action}),encoding="utf-8")

    def test_disable_preserves_jar_and_plugin_configuration(self):
        self.stage("disable")
        self.assertEqual(len(apply_content_actions(self.data,self.manifest)),1)
        self.assertFalse(self.jar.exists())
        disabled=self.data/"plugins"/".disabled-modrinth"/self.jar.name
        self.assertTrue(disabled.is_file())
        self.assertFalse(installed_inventory(self.data)[self.project]["enabled"])
        self.assertEqual((self.data/"plugins"/"Example"/"config.yml").read_text(),"keep: true")
        self.assertEqual(json.loads((self.data/".cloud-applied-content.json").read_text())[self.project],"disable")
        # An already applied disable is harmless on subsequent runner sessions.
        apply_content_actions(self.data,self.manifest)
        self.assertTrue(disabled.is_file())

    def test_reenable_moves_disabled_jar_back_without_redownload(self):
        self.stage("disable")
        apply_content_actions(self.data,self.manifest)
        self.stage("enable")
        apply_content_actions(self.data,self.manifest)
        self.assertTrue(self.jar.is_file())
        self.assertTrue(installed_inventory(self.data)[self.project]["enabled"])
        self.assertFalse((self.data/"plugins"/".disabled-modrinth"/self.jar.name).exists())

    def test_remove_does_not_erase_configuration_or_other_plugins(self):
        other=self.data/"plugins"/"another.jar"
        other.write_bytes(b"unmanaged-jar")
        self.stage("remove")
        apply_content_actions(self.data,self.manifest)
        self.assertFalse(self.jar.exists())
        self.assertTrue(other.exists())
        self.assertEqual((self.data/"plugins"/"Example"/"config.yml").read_text(),"keep: true")
        self.assertNotIn(self.project,installed_inventory(self.data))
        self.assertEqual(json.loads((self.data/".cloud-applied-content.json").read_text())[self.project],"remove")
        apply_content_actions(self.data,self.manifest)

    def test_invalid_manifest_fails_before_modification(self):
        for content in ({"../../oops":"remove"},{"Proj123":"delete"},
                        {"Proj123":"disable","Proj456":{"evil":True}}):
            self.manifest.write_text(json.dumps(content))
            with self.assertRaises((TypeError,ValueError)):
                apply_content_actions(self.data,self.manifest)
            self.assertTrue(self.jar.exists())

    def test_disabling_suppresses_queued_install_downloads(self):
        self.stage("disable")
        install_file=self.root/"installs.json"
        install_file.write_text(json.dumps({"Proj123":{
            "kind":"plugin","versionId":"Ver123","title":"Example"}}))
        with patch("pending_modrinth.install_modrinth") as install:
            result=apply_modrinth_queue(self.data,install_file,self.manifest)
            self.assertEqual(result,[])
            install.assert_not_called()


class PlayersDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data=Path(self.temp.name)
        self.commands=[]
        self.bridge=LiveBridge(
            self.data,"test-session",{"JavaUser",".BedrockA"},threading.Lock(),
            deque(),threading.Event(),self.commands.append,
            threading.Event(),threading.Event(),{"empty_since":None},os.getpid()
        )
        (self.data/"whitelist.json").write_text(json.dumps([
            {"uuid":"UUID-MUST-NOT-LEAK","name":"JavaUser"},
            {"uuid":"irrelevant","name":"Injected; stop"}
        ]))
        (self.data/"ops.json").write_text(json.dumps([
            {"uuid":"UUID-MUST-NOT-LEAK","name":".BedrockA"}]))
        (self.data/"banned-players.json").write_text(json.dumps([
            {"uuid":"UUID-MUST-NOT-LEAK","name":"BannedUser"}]))
        (self.data/"server.properties").write_text("white-list=true\n")

    def test_directory_exposes_names_but_not_private_records(self):
        result=self.bridge._execute({"type":"players-list","args":{}})
        self.assertEqual(result["online"],[".BedrockA","JavaUser"])
        self.assertEqual(result["operators"],[".BedrockA"])
        self.assertEqual(result["whitelisted"],["JavaUser"])
        self.assertEqual(result["banned"],["BannedUser"])
        self.assertTrue(result["whitelistEnabled"])
        self.assertNotIn("UUID-MUST-NOT-LEAK",json.dumps(result))

    def test_java_and_bedrock_commands_use_safe_player_names(self):
        self.bridge._execute({"type":"whitelist-add","args":{"player":".BedrockA"}})
        self.bridge._execute({"type":"kick","args":{"player":"JavaUser"}})
        self.assertIn("whitelist add .BedrockA",self.commands)
        self.assertIn("kick JavaUser",self.commands)

    def test_unsafe_commands_rejected(self):
        for name in ("user;stop","user\nstop","another player","../abc","", "."):
            with self.subTest(name=name),self.assertRaises(ValueError):
                self.bridge._execute({"type":"op","args":{"player":name}})
        self.assertEqual(self.commands,[])


if __name__=="__main__":
    unittest.main()
