"""Safety tests for server-side dashboard bridge command handling."""
import os
import tempfile
import threading
import time
import unittest
from collections import deque
from pathlib import Path

from server.runtime_bridge import LiveBridge


class BridgeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sent = []
        self.restart = threading.Event()
        self.shutdown = threading.Event()
        self.data = Path(self.tmp.name)
        self.bridge = LiveBridge(
            self.data, "test-session", set(), threading.Lock(), deque(),
            threading.Event(), self.sent.append, self.restart, self.shutdown,
            {"last_join": time.monotonic(), "count": 0}, os.getpid()
        )

    def test_shutdown_is_separate_from_restart(self):
        self.bridge._execute({"type": "shutdown", "args": {}})
        self.assertTrue(self.shutdown.is_set())
        self.assertFalse(self.restart.is_set())

    def test_restart_is_separate_from_shutdown(self):
        self.bridge._execute({"type": "restart", "args": {}})
        self.assertTrue(self.restart.is_set())
        self.assertFalse(self.shutdown.is_set())

    def test_console_blocks_unsafe_direct_stop(self):
        with self.assertRaises(ValueError):
            self.bridge._execute({"type": "console", "args": {"command": "stop"}})
        self.assertEqual(self.sent, [])

    def test_file_write_and_read(self):
        self.bridge._execute({"type": "files-write", "args": {
            "path": "config/settings.yml", "content": "enabled: true\n"
        }})
        found = self.bridge._execute({"type": "files-read", "args": {
            "path": "config/settings.yml"
        }})
        self.assertEqual(found["content"], "enabled: true\n")

    def test_world_file_edits_are_blocked(self):
        with self.assertRaises(ValueError):
            self.bridge._execute({"type": "files-write", "args": {
                "path": "world/level.dat", "content": "bad"
            }})

    def test_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            self.bridge._path("../secret.txt")

    def test_invalid_player_is_rejected(self):
        with self.assertRaises(ValueError):
            self.bridge._execute({"type": "kick", "args": {"player": "Invalid Player!"}})

    def test_memory_telemetry_returns_number(self):
        value = self.bridge._memory_mb()
        self.assertTrue(value is None or value >= 0)


if __name__ == "__main__":
    unittest.main()
