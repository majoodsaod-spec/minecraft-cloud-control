"""Guardrails for automated world backup artifact retention."""
import unittest

from server.prune_backups import select_prunable


class BackupCleanupTests(unittest.TestCase):
    def test_only_oldest_after_fresh_upload_can_be_pruned(self):
        rows=[f"2026-11-{day:02d}T12:00:00Z\t{100+day}\t{200+day}\t1048576\n"
              for day in range(1,9)]
        removed, total=select_prunable(rows,"208")
        self.assertEqual([id for id,_ in removed],["103","102","101"])
        self.assertEqual(total,3*1048576)

    def test_never_delete_if_latest_backup_missing(self):
        rows=["2026-11-07T12:00:00Z\t501\t301\t100\n",
              "2026-11-06T12:00:00Z\t500\t300\t100\n"]*4
        self.assertEqual(select_prunable(rows,"999"),([],0))

    def test_never_delete_if_newer_backup_from_another_run(self):
        rows=[f"2026-11-{day:02d}T12:00:00Z\t{day}\t{day}\t100\n"
              for day in range(1,9)]
        self.assertEqual(select_prunable(rows,"7"),([],0))

    def test_preserve_all_if_less_than_five(self):
        rows=[f"2026-11-{day:02d}T12:00:00Z\t{day}\t{day}\t100\n"
              for day in range(1,5)]
        self.assertEqual(select_prunable(rows,"4"),([],0))

    def test_malformed_and_duplicate_artifact_rows(self):
        rows=["malformed", "2026-11-07T00:00:00Z\t5\t17\t500\n",
              "2026-11-07T00:00:00Z\t5\t17\t500\n"]
        self.assertEqual(select_prunable(rows,"17"),([],0))


if __name__ == "__main__":
    unittest.main()
