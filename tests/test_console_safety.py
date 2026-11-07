"""A console command must not bypass the verified Paper save/backup path."""
import unittest
from server.runtime_bridge import unsafe_shutdown_command


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


if __name__ == "__main__":
    unittest.main()
