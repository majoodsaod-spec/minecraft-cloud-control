"""Regression checks for fail-closed recovery and lifecycle diagnostics."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from reliability import LifecycleRecorder, verify_restored_world, markdown_summary
import handoff


class TimingsTests(unittest.TestCase):
    def test_lifecycle_record_is_bounded_and_redacts_exception_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            values = iter([10.0, 11.0, 14.0, 16.0, 18.0])
            r = LifecycleRecorder(path, clock=lambda: next(values))
            with r.stage("restore_backup"):
                pass
            try:
                with r.stage("plugin_setup"):
                    raise ValueError("secret-tok-should-never-be-written")
            except ValueError:
                pass
            saved = path.read_text(encoding="utf-8")
            self.assertNotIn("secret-tok", saved)
            info = json.loads(saved)
            self.assertEqual(info["durations"]["restore_backup"], 3.0)
            self.assertEqual(info["failedStage"], "plugin_setup")
            self.assertEqual(info["failureType"], "ValueError")
            self.assertIn("Restore Backup", markdown_summary(path))

    def test_required_world_missing_is_never_treated_as_new(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            verify_restored_world(root, restore_required=False)
            with self.assertRaisesRegex(RuntimeError, "level.dat"):
                verify_restored_world(root, restore_required=True)
            (root / "world").mkdir()
            (root / "world" / "level.dat").write_bytes(b"bad")
            with self.assertRaises(RuntimeError):
                verify_restored_world(root, restore_required=True)
            (root / "world" / "level.dat").write_bytes(b"123456789abcdefg")
            verify_restored_world(root, restore_required=True)

    def test_no_report_uses_safe_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("No runner diagnostic report", markdown_summary(Path(tmp) / "missing"))


class HandoffTests(unittest.TestCase):
    def test_handoff_dispatches_once_after_clean_check(self):
        checks = []
        sends = []
        def check(*args):
            checks.append(args)
            return None
        def command(*args):
            sends.append(args)
            return 0, ""
        result = handoff.dispatch_handoff("example/project", 101, "main",
                                          pause=lambda _: None, check=check,
                                          command=command)
        self.assertEqual(result, "dispatched")
        self.assertEqual(len(checks), 1)
        self.assertEqual(len(sends), 1)
        self.assertIn("previous_run=101", sends[0])

    def test_existing_successor_prevents_duplicate(self):
        def fail_command(*args):
            self.fail("Must not dispatch when another runner is active")
        self.assertEqual(handoff.dispatch_handoff("example/project", 101, "main",
            check=lambda *_: 102, command=fail_command), "already-active")

    def test_network_failure_with_visible_successor_does_not_retry(self):
        checks = iter([None, 202])
        calls = []
        result = handoff.dispatch_handoff("example/project", 101, "main",
            check=lambda *_: next(checks),
            command=lambda *args: (calls.append(args) or (1, "")),
            pause=lambda *_: None)
        self.assertEqual(result, "already-active")
        self.assertEqual(len(calls), 1)

    def test_uncertain_run_lookup_never_dispatches(self):
        def cannot_query(*_):
            raise handoff.HandoffError("API unavailable")
        with self.assertRaises(handoff.HandoffError):
            handoff.dispatch_handoff("example/project", 101, "main",
                                     check=cannot_query, command=lambda *args: self.fail())

    def test_three_failed_dispatches_stop_without_loop(self):
        calls = []
        with self.assertRaises(handoff.HandoffError):
            handoff.dispatch_handoff("example/project", 101, "main",
                pause=lambda _: None, check=lambda *_: None,
                command=lambda *args: (calls.append(1) or (1, "")))
        self.assertEqual(len(calls), 3)

    def test_active_run_statuses_and_branch_checked(self):
        fake = {"workflow_runs": [
            {"id": 101, "status": "in_progress", "head_branch": "main"},
            {"id": 105, "status": "queued", "head_branch": "other"},
            {"id": 109, "status": "waiting", "head_branch": "main"},
        ]}
        with patch.object(handoff, "gh", return_value=(0, json.dumps(fake))):
            self.assertEqual(handoff.active_other_run("example/project", 101, "main"), 109)


if __name__ == "__main__":
    unittest.main()
