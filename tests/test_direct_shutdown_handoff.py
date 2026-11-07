"""Static guardrails for a verified backup and an intentional offline state."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/paper-state-test.yml").read_text()
PAPER = (ROOT / "server/continuous_paper.py").read_text()


class DirectStopHandoffTests(unittest.TestCase):
    def test_safe_stop_writes_marker_only_after_snapshot(self):
        self.assertIn('snapshot()\n            # Direct NetBird shutdown', PAPER)
        self.assertIn('if bridge_shutdown.is_set():\n                (OUTPUT / "stop-requested").write_text', PAPER)

    def test_workflow_stores_stop_marker_with_verified_backup(self):
        self.assertIn('cycle-output/worlds.zip.sha256\n            cycle-output/stop-requested', WORKFLOW)
        self.assertIn('stop_requested: ${{ steps.paper.outputs.stop_requested }}', WORKFLOW)
        self.assertIn('echo "stop_requested=true" >> "$GITHUB_OUTPUT"', WORKFLOW)

    def test_safe_restart_handoff_does_not_relaunch_after_shutdown(self):
        self.assertIn("needs.minecraft.outputs.stop_requested != 'true'", WORKFLOW)
        self.assertIn('if [[ "$EVENT_NAME" == "schedule" && -f previous/stop-requested ]]; then', WORKFLOW)
        self.assertIn('echo "skip=true" >> "$GITHUB_OUTPUT"', WORKFLOW)


if __name__ == "__main__":
    unittest.main()
