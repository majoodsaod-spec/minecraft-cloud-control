"""Ensure maintenance logs contain genuine results without spurious commits."""
from datetime import date
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from server import maintenance


class MaintenanceTests(unittest.TestCase):
    def test_fifty_day_interval(self):
        first=date(2026,1,1)
        self.assertTrue(maintenance.due(None,first,False))
        self.assertFalse(maintenance.due("2026-01-01",date(2026,2,19),False))
        self.assertTrue(maintenance.due("2026-01-01",date(2026,2,20),False))
        self.assertTrue(maintenance.due("2026-01-01",date(2026,1,2),True))

    def test_first_pass_records_all_good(self):
        entry=maintenance.build_entry(1,date(2026,11,7),
                                     {"Python syntax":True,"JavaScript":True},{})
        self.assertIn("Maintenance #1",entry)
        self.assertIn("Maintenance status: all good",entry)
        self.assertIn("No errors detected",entry)

    def test_errors_and_fixes_are_distinguished(self):
        previous={"Python syntax":False,"Python unit tests":True}
        current={"Python syntax":True,"Python unit tests":False}
        entry=maintenance.build_entry(2,date(2027,1,1),current,previous)
        self.assertIn("Fixed since last maintenance: Python syntax",entry)
        self.assertIn("New failures: Python unit tests",entry)
        self.assertNotIn("all good",entry)

    def test_creates_numbered_log_even_for_same_status(self):
        with tempfile.TemporaryDirectory() as temp:
            log=Path(temp)/"maintenance-log.md"
            status=Path(temp)/"status.json"
            with patch.object(maintenance,"LOG",log), patch.object(maintenance,"STATE",status):
                first=maintenance.update_log(date(2026,11,7),{"Python syntax":True},{})
                state=json.loads(status.read_text())
                second=maintenance.update_log(date(2026,12,27),{"Python syntax":True},state)
                self.assertEqual((first,second),(1,2))
                output=log.read_text()
                self.assertIn("Maintenance #1",output)
                self.assertIn("Maintenance #2",output)
                self.assertEqual(output.count("Maintenance status: all good"),2)


if __name__=="__main__":
    unittest.main()
