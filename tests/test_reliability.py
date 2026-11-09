"""Regression checks for fail-closed recovery and lifecycle diagnostics."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from reliability import LifecycleRecorder, verify_restored_world, markdown_summary, expected_world_directory
import handoff
import recovery_gate


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

    def test_custom_level_name_restored_and_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "paper"
            root.mkdir()
            config = Path(tmp) / "settings.properties"
            config.write_text("level-name=Custom World\n", encoding="utf-8")
            (root / "Custom World").mkdir()
            (root / "Custom World" / "level.dat").write_bytes(b"valid world save header")
            self.assertEqual(expected_world_directory(root, config), root / "Custom World")
            verify_restored_world(root, True, config)
            config.write_text("level-name=../outside\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                verify_restored_world(root, True, config)

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


class ScheduledRecoveryTests(unittest.TestCase):
    def test_failed_runner_after_last_snapshot_blocks_automatic_restore(self):
        backup = [{"name": "minecraft-world", "expired": False, "workflow_run": {"id": 80},
                   "created_at": "2026-11-09T08:00:00Z"}]
        runs = [{"id": 90, "event": "workflow_dispatch", "status": "completed",
                 "conclusion": "failure", "created_at": "2026-11-09T09:00:00Z"}]
        ok, why = recovery_gate.allowed(80, backup, runs, 99)
        self.assertFalse(ok)
        self.assertIn("Unbacked", why)

    def test_verified_latest_snapshot_allows_safe_recovery(self):
        backup = [{"name": "minecraft-world", "expired": False, "workflow_run": {"id": 90},
                   "created_at": "2026-11-09T10:00:00Z"}]
        runs = [{"id": 80, "event": "workflow_dispatch", "status": "completed",
                 "conclusion": "failure", "created_at": "2026-11-09T09:00:00Z"},
                {"id": 90, "event": "workflow_dispatch", "status": "completed",
                 "conclusion": "failure", "created_at": "2026-11-09T09:30:00Z"}]
        self.assertTrue(recovery_gate.allowed(90, backup, runs, 99)[0])

    def test_missing_selected_artifact_is_never_accepted(self):
        self.assertFalse(recovery_gate.allowed(100, [], [], 101)[0])

    def test_no_backup_after_prior_server_run_cannot_start_blank_world(self):
        runs = [{"id": 85, "event": "workflow_dispatch", "conclusion": "success",
                 "created_at": "2026-11-08T00:00:00Z"}]
        self.assertFalse(recovery_gate.allowed(None, [], runs, 99)[0])

    def test_fresh_repository_without_backup_can_start_first_world(self):
        self.assertTrue(recovery_gate.allowed(None, [], [], 101)[0])


class WorkflowIntegrationTests(unittest.TestCase):
    def test_automatic_recovery_is_gated_before_snapshot_download(self):
        workflow = (ROOT / ".github/workflows/paper-state-test.yml").read_text()
        self.assertIn("python server/recovery_gate.py --backup-run", workflow)
        self.assertLess(workflow.index("python server/recovery_gate.py --backup-run"),
                        workflow.index('gh run download "$run_id"'))
        self.assertIn('if [[ "$EVENT_NAME" == "schedule" && -f previous/stop-requested ]]; then', workflow)

    def test_no_successor_without_verified_artifact(self):
        workflow = (ROOT / ".github/workflows/paper-state-test.yml").read_text()
        self.assertIn("needs.minecraft.outputs.backed_up == 'true'", workflow)
        self.assertIn("needs.minecraft.outputs.stop_requested != 'true'", workflow)
        self.assertIn('python server/handoff.py --run-id "$GITHUB_RUN_ID"', workflow)

    def test_timings_available_in_job_summary_without_credentials(self):
        workflow = (ROOT / ".github/workflows/paper-state-test.yml").read_text()
        paper = (ROOT / "server" / "continuous_paper.py").read_text()
        bridge = (ROOT / "server" / "runtime_bridge.py").read_text()
        self.assertIn("cycle-output/lifecycle-report.json", workflow)
        self.assertIn("markdown_summary", workflow)
        self.assertIn('recorder.stage("restore_backup")', paper)
        self.assertIn('recorder.stage("paper_download")', paper)
        self.assertIn('recorder.mark("saved")', paper)
        self.assertIn('"startupTimings":dict(self.startup_timings)', bridge)


if __name__ == "__main__":
    unittest.main()
