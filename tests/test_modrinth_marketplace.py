"""Regression tests: Modrinth files are downloaded on the runner, not the PC."""
import hashlib
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"server"))
import modrinth_install as store
import pending_modrinth as queue


class FakeDownload(io.BytesIO):
    def __init__(self,data,url):
        super().__init__(data)
        self.url=url
        self.status=200
    def geturl(self):
        return self.url

def archive(name):
    data=io.BytesIO()
    with zipfile.ZipFile(data,"w") as z:
        z.writestr(name,"this is a valid archive descriptor")
        z.writestr("assets/data.bin",b"x"*2048)
    return data.getvalue()

class MarketplaceTests(unittest.TestCase):
    def run_install(self,kind,corrupt=False,required=False):
        payload=archive("plugin.yml" if kind=="plugin" else "pack.mcmeta")
        url="https://cdn.modrinth.com/data/Project1/versions/Version1/item"+(".jar" if kind=="plugin" else ".zip")
        release={"id":"Version1","project_id":"Project1","game_versions":["26.3"],
            "loaders":["paper" if kind=="plugin" else "datapack"],"version_number":"1.0",
            "dependencies":[{"dependency_type":"required"}] if required else [],
            "files":[{"filename":"item"+(".jar" if kind=="plugin" else ".zip"),"url":url,
                "size":len(payload),"primary":True,
                "hashes":{"sha256":"0"*64 if corrupt else hashlib.sha256(payload).hexdigest()}}]}
        def metadata(endpoint):
            if endpoint.endswith("/project/Project1"):return {"id":"Project1","title":"Test plugin"}
            if endpoint.endswith("/version/Version1"):return release
            raise AssertionError(endpoint)
        def download(req,timeout=0):
            self.assertEqual(req.full_url,url)
            return FakeDownload(payload,url)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(store,"get_json",side_effect=metadata),patch.object(store.urllib.request,"urlopen",side_effect=download):
                if corrupt or required:
                    with self.assertRaises(ValueError):
                        store.install_modrinth(Path(tmp),"Project1","Version1",kind)
                    self.assertFalse(list(Path(tmp).rglob("modrinth-*.jar")))
                    self.assertFalse(list(Path(tmp).rglob("modrinth-*.zip")))
                else:
                    result=store.install_modrinth(Path(tmp),"Project1","Version1",kind)
                    self.assertTrue((Path(tmp)/result["file"]).is_file())
                    self.assertEqual(result["restartRequired"],kind=="plugin")
                    self.assertEqual(result["kind"],kind)

    def test_plugin_download_installs_on_runner(self):
        self.run_install("plugin")
    def test_datapack_installs_inside_world(self):
        self.run_install("datapack")
    def test_sha256_mismatch_rejected(self):
        self.run_install("plugin",corrupt=True)
    def test_required_dependency_does_not_silently_install_incomplete_plugin(self):
        self.run_install("plugin",required=True)
    def test_malformed_ids_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                store.install_modrinth(Path(tmp),"../wrong","Version1","plugin")

class OfflineQueueTests(unittest.TestCase):
    def test_pending_plugins_and_datapacks_apply_into_restored_world(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            manifest=root/"pending-modrinth.json"
            manifest.write_text(json.dumps({
                "Proj123":{"versionId":"Ver123","kind":"plugin","title":"Example"},
                "Proj456":{"versionId":"Ver456","kind":"datapack","title":"Pack"}
            }))
            with patch.object(queue,"install_modrinth",side_effect=[
                {"installed":True,"kind":"plugin"},{"installed":True,"kind":"datapack"}
            ]) as installer:
                result=queue.apply_modrinth_queue(root/"paper",manifest)
            self.assertEqual(len(result),2)
            self.assertEqual(installer.call_count,2)
            self.assertEqual(installer.call_args_list[0].args[1:],("Proj123","Ver123","plugin"))
            self.assertEqual(installer.call_args_list[1].args[1:],("Proj456","Ver456","datapack"))

    def test_invalid_or_unsafe_queue_is_rejected_before_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            manifest=root/"pending-modrinth.json"
            manifest.write_text(json.dumps({"../bad":{"versionId":"Ver123","kind":"plugin"}}))
            with self.assertRaises(ValueError):
                queue.apply_modrinth_queue(root,manifest)

    def test_offline_queue_runs_after_world_restore(self):
        source=(Path(__file__).resolve().parents[1]/"server"/"continuous_paper.py").read_text()
        start=source.index("def main()")
        self.assertLess(source.index("    restore_snapshot()",start),
                        source.index("    apply_modrinth_queue(",start))

if __name__=="__main__":
    unittest.main()
