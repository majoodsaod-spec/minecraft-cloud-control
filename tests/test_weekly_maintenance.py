"""Weekly maintenance must not interrupt players or repeat after a verified save."""
from datetime import datetime,timezone
import json
from pathlib import Path
import tempfile
import unittest
from server.weekly_maintenance import read_policy,due,period_key,last_completed,mark_completed


class WeeklyMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.file=self.root/"automation-policy.json"

    def test_disabled_by_default_and_invalid_policy_fails_closed(self):
        self.assertFalse(read_policy(self.file)["enabled"])
        for content in ('{}','{"weekly_maintenance":{"enabled":true}}',
                        '{"weekly_maintenance":{"enabled":true,"weekday_utc":99,"hour_utc":1}}'):
            self.file.write_text(content)
            self.assertFalse(read_policy(self.file)["enabled"])

    def test_weekly_window_is_empty_only_and_utc(self):
        policy={"enabled":True,"weekday_utc":6,"hour_utc":3}
        date=datetime(2026,11,8,3,5,tzinfo=timezone.utc) # Sunday
        self.assertTrue(due(policy,date,0,None))
        self.assertFalse(due(policy,date,1,None))
        self.assertFalse(due(policy,date,0,period_key(date)))
        self.assertFalse(due(policy,date.replace(minute=16),0,None))
        self.assertFalse(due(policy,date.replace(hour=4),0,None))
        self.assertFalse(due(policy,date.replace(day=9),0,None))

    def test_maintenance_receipt_survives_snapshot(self):
        policy={"enabled":True,"weekday_utc":6,"hour_utc":3}
        date=datetime(2026,11,8,3,0,tzinfo=timezone.utc)
        mark_completed(self.root,date)
        self.assertEqual(last_completed(self.root),period_key(date))
        self.assertFalse(due(policy,date,0,last_completed(self.root)))
        saved=json.loads((self.root/".cloud-weekly-maintenance.json").read_text())
        self.assertEqual(saved,{"week":period_key(date)})


if __name__=="__main__":
    unittest.main()
