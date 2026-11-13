"""Offline regressions for the real Geyser/Playit health reporting contract."""
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml
from server import bedrock_health


class BedrockHealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        plugins = self.root / "plugins"
        (plugins / "Geyser-Spigot").mkdir(parents=True)
        (plugins / "Geyser-Spigot.jar").write_bytes(b"jar")
        (plugins / "floodgate-spigot.jar").write_bytes(b"jar")
        self.config = plugins / "Geyser-Spigot" / "config.yml"
        self.config.write_text(yaml.safe_dump({
            "bedrock": {"address": "0.0.0.0", "port": 19132, "transport": "nethernet"},
            "java": {"auth-type": "floodgate"},
        }), encoding="utf-8")
        self.listener = patch.object(bedrock_health, "_listening",
                                     return_value={"tcp": True, "udp": True})
        self.listener.start()
        self.addCleanup(self.listener.stop)

    def health(self, secret=True):
        return bedrock_health.BedrockHealth(
            self.root, playit_snippet=secret, playit_agent=True,
            public_address={"host": "bedrock.example.org", "port": 19132})

    def test_registration_is_reported_without_claiming_public_reachability(self):
        health = self.health()
        self.assertEqual(health.snapshot(True)["status"], "awaiting_signaling")
        health.observe("[Server thread/INFO]: Enabling Geyser-Spigot v1237")
        health.observe("[Server thread/INFO]: Enabling floodgate v2")
        health.observe("Registered with the external signaling service")
        state = health.snapshot(True)
        self.assertEqual(state["status"], "signaling_registered")
        self.assertTrue(state["geyserEnabled"])
        self.assertTrue(state["floodgateEnabled"])
        self.assertTrue(state["signalingRegistered"])
        self.assertFalse(state["externalReachabilityVerified"])
        self.assertEqual(state["host"], "bedrock.example.org")

    def test_missing_secret_is_actionable_but_not_exposed(self):
        health = self.health(secret=False)
        health.observe("Registered with the external signaling service")
        self.assertEqual(health.snapshot(True)["status"], "needs_setup")
        self.assertNotIn("token", str(health.snapshot(True)).lower())

    def test_missing_plugin_or_wrong_bind_address_is_reported(self):
        (self.root / "plugins" / "floodgate-spigot.jar").unlink()
        self.assertEqual(self.health().snapshot(True)["status"], "unavailable")
        (self.root / "plugins" / "floodgate-spigot.jar").write_bytes(b"jar")
        value = yaml.safe_load(self.config.read_text())
        value["bedrock"]["address"] = "127.0.0.1"
        self.config.write_text(yaml.safe_dump(value))
        self.assertEqual(self.health().snapshot(True)["status"], "misconfigured")

    def test_disconnection_and_failure_reset_registration(self):
        health = self.health()
        health.observe("Registered with the external signaling service")
        health.observe("Disconnected from the external signaling service")
        self.assertFalse(health.snapshot(True)["signalingRegistered"])
        health.observe("Failed to register with the external signaling service: invalid signaling token TOP_SECRET")
        state = health.snapshot(True)
        self.assertEqual(state["status"], "error")
        self.assertNotIn("TOP_SECRET", str(state))
        health.observe("Registered with the external signaling service")
        self.assertEqual(health.snapshot(True)["status"], "signaling_registered")

    def test_local_listener_is_required_for_ready_state(self):
        health = self.health()
        health.observe("Registered with the external signaling service")
        with patch.object(bedrock_health, "_listening", return_value={"tcp": True, "udp": False}):
            self.assertEqual(health.snapshot(True)["status"], "listener_missing")


if __name__ == "__main__":
    unittest.main()
