"""A console command must not bypass the verified Paper save/backup path."""
import unittest
from server.runtime_bridge import LiveBridge, unsafe_shutdown_command
from contextlib import redirect_stdout
import io


class SafeConsoleTests(unittest.TestCase):
    def test_stop_and_restart_aliases_use_safe_control(self):
        for command in (
            "stop", "/stop", "restart", "/restart",
            "/minecraft:stop", "minecraft:stop now",
            "bukkit:restart", "/spigot:restart",
            "  /MINECRAFT:STOP", "  /spigot:RESTART "
        ):
            with self.subTest(command=command):
                self.assertTrue(unsafe_shutdown_command(command))

    def test_normal_admin_and_backup_commands_still_work(self):
        for command in (
            "say Hello", "/list", "save-all flush", "whitelist on",
            "time set day", "minecraft:give Steve stone"
        ):
            with self.subTest(command=command):
                self.assertFalse(unsafe_shutdown_command(command))



class OptionalBridgeStartupTests(unittest.TestCase):
    def test_non_https_cloudflare_url_does_not_abort_paper(self):
        bridge = LiveBridge.__new__(LiveBridge)
        bridge.url = "http://unsupported.example"
        bridge.token = "redacted"
        bridge.thread = None
        with redirect_stdout(io.StringIO()):
            self.assertIsNone(bridge.start())
        self.assertIsNone(bridge.thread)
        self.assertEqual(bridge.url, "")
        self.assertEqual(bridge.token, "")


if __name__ == "__main__":
    unittest.main()
