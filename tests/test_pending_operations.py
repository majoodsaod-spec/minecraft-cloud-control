"""Safety and idempotence tests for Phase 2 queued file operations."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from pending_operations import apply_pending_operations, load_operations, safe_directory, validate_operation
from pending_files import apply_pending


def op(kind, path, index, target=None):
    entry = {"id": f"phase2-test-{index:04d}", "type": kind, "path": path}
    if target is not None:
        entry["target"] = target
    return entry


class PendingOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "paper"
        self.data.mkdir()
        self.manifest = self.root / "operations.json"
        self.edits = self.root / "edits.json"

    def queue(self, *items):
        self.manifest.write_text(json.dumps({"version": 1, "operations": list(items)}),
                                 encoding="utf-8")

    def test_directory_creation_replays_once(self):
        self.queue(op("mkdir", "plugins/CustomConfig", 1))
        self.assertEqual(apply_pending_operations(self.data, self.manifest), 1)
        self.assertTrue((self.data / "plugins/CustomConfig").is_dir())
        self.assertEqual(apply_pending_operations(self.data, self.manifest), 0)
        self.assertEqual(len(json.loads((self.data / ".cloud-applied-ops.json").read_text())), 1)

    def test_text_file_rename_and_delete(self):
        folder = self.data / "plugins" / "Example"
        folder.mkdir(parents=True)
        (folder / "old.yml").write_text("value: true")
        (folder / "remove.toml").write_text("unused")
        self.queue(op("rename", "plugins/Example/old.yml", 1, "plugins/Example/new.yml"),
                   op("delete", "plugins/Example/remove.toml", 2))
        self.assertEqual(apply_pending_operations(self.data, self.manifest), 2)
        self.assertTrue((folder / "new.yml").exists())
        self.assertFalse((folder / "old.yml").exists())
        self.assertFalse((folder / "remove.toml").exists())
        self.assertEqual(apply_pending_operations(self.data, self.manifest), 0)

    def test_offline_rename_refuses_to_overwrite_existing_file(self):
        folder = self.data / "plugins" / "Example"
        folder.mkdir(parents=True)
        (folder / "a.yml").write_text("A")
        (folder / "b.yml").write_text("B")
        self.queue(op("rename", "plugins/Example/a.yml", 1, "plugins/Example/b.yml"))
        with self.assertRaisesRegex(ValueError, "overwrite"):
            apply_pending_operations(self.data, self.manifest)
        self.assertEqual((folder / "a.yml").read_text(), "A")
        self.assertEqual((folder / "b.yml").read_text(), "B")

    def test_world_and_sensitive_paths_blocked(self):
        unsafe = [
            op("delete", "world/level.dat", 1),
            op("delete", "world/playerdata/abc.txt", 2),
            op("delete", "ops.json", 3),
            op("delete", "server.properties", 4),
            op("delete", "plugins/Geyser-Spigot/config.yml", 5),
            op("rename", "plugins/a.yml", 6, "world/a.yml"),
            op("mkdir", "world/creative", 7),
            op("mkdir", ".ssh", 8),
            op("delete", "plugins/../secrets.yml", 9),
        ]
        for item in unsafe:
            with self.subTest(item=item):
                with self.assertRaises(ValueError):
                    validate_operation(item)

    def test_queued_operations_conflicting_with_edits_fail_closed(self):
        self.queue(op("rename", "plugins/test/old.yml", 1, "plugins/test/new.yml"))
        self.edits.write_text(json.dumps({"plugins/test/new.yml": "replacement"}))
        with self.assertRaisesRegex(ValueError, "conflicts"):
            apply_pending_operations(self.data, self.manifest, self.edits)
        self.assertFalse((self.data / ".cloud-applied-ops.json").exists())

    def test_duplicate_ids_and_unknown_operation_types_rejected(self):
        self.queue(op("mkdir", "plugins/a", 1), op("mkdir", "plugins/b", 1))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            load_operations(self.manifest)
        self.queue(op("execute", "plugins/payload", 4))
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            load_operations(self.manifest)

    def test_symlinked_parent_refused(self):
        outside = self.root / "external"
        outside.mkdir()
        (self.data / "plugins").symlink_to(outside, target_is_directory=True)
        self.queue(op("mkdir", "plugins/config", 1))
        with self.assertRaisesRegex(ValueError, "Symlinked|escapes server directory"):
            apply_pending_operations(self.data, self.manifest)
        self.assertFalse((outside / "config").exists())

    def test_file_overlay_receipts_survive_repeated_startups(self):
        (self.data / "plugins").mkdir()
        self.edits.write_text(json.dumps({"plugins/example.yml": "first"}))
        self.assertEqual(apply_pending(self.data, self.edits), 1)
        self.assertEqual(apply_pending(self.data, self.edits), 0)
        self.assertEqual((self.data / "plugins/example.yml").read_text(), "first")
        self.assertEqual(len(json.loads((self.data / ".cloud-applied-edits.json").read_text())), 1)
        self.edits.write_text(json.dumps({"plugins/example.yml": "second"}))
        self.assertEqual(apply_pending(self.data, self.edits), 1)
        self.assertEqual((self.data / "plugins/example.yml").read_text(), "second")

    def test_queued_changes_are_not_applied_to_source_backup(self):
        backup = self.root / "immutable-backup"
        backup.mkdir()
        (backup / "note.yml").write_text("before")
        self.queue(op("mkdir", "plugins/Example", 1))
        self.assertEqual(apply_pending_operations(self.data, self.manifest), 1)
        self.assertEqual((backup / "note.yml").read_text(), "before")
        self.assertFalse((backup / "plugins").exists())


if __name__ == "__main__":
    unittest.main()
