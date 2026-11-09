"""Bounded performance history survives a verified snapshot handoff safely."""
import json
from pathlib import Path
import tempfile
import unittest
from server.performance_history import PerformanceHistory,MAX_SAMPLES


class PerformanceHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)

    def test_records_once_per_minute_and_reload_preserves_history(self):
        history=PerformanceHistory(self.path)
        values={"cpu":51.2,"memory":1024,"diskFree":10240,
                "tps":20.0,"mspt":3.5,"players":3}
        self.assertTrue(history.record(values, now=100))
        self.assertFalse(history.record(values, now=120))
        self.assertTrue(history.record(values, now=161))
        restored=PerformanceHistory(self.path)
        self.assertEqual(len(restored.snapshot()),2)
        self.assertEqual(restored.snapshot()[0]["players"],3)
        self.assertNotIn("usernames",json.dumps(restored.snapshot()))

    def test_malformed_history_is_ignored(self):
        (self.path/".cloud-performance-history.json").write_text("{bad")
        self.assertEqual(PerformanceHistory(self.path).snapshot(),[])

    def test_history_is_bounded_and_sensitive_fields_are_discarded(self):
        history=PerformanceHistory(self.path)
        for i in range(MAX_SAMPLES+15):
            history.record({"cpu":25,"memory":100,"players":2,
                            "user":"PRIVATE","ip":"127.0.0.1"},now=100+i*61)
        loaded=PerformanceHistory(self.path).snapshot()
        self.assertEqual(len(loaded),MAX_SAMPLES)
        self.assertNotIn("PRIVATE",json.dumps(loaded))
        self.assertNotIn("127.0.0.1",json.dumps(loaded))

    def test_unavailable_memory_never_writes_fake_record(self):
        history=PerformanceHistory(self.path)
        self.assertFalse(history.record({"cpu":2},now=100))
        self.assertEqual(history.snapshot(),[])


if __name__=="__main__":
    unittest.main()
