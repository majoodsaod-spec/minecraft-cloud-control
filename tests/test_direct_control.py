"""Real HTTP regression checks for the private NetBird Paper control agent.

Loopback binding is test-only; production requires a private NetBird IP.
No Minecraft subprocess, VPN, Cloudflare, GitHub token or live player required.
"""
from __future__ import annotations

from collections import deque
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from server import direct_control


class FakeBridge:
    def __init__(self):
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.ready.set()
        self.players = {"Steve"}
        self.log_lines = deque(["Paper ready"])
        self.observed = {"empty_since": None}
        self.started = time.monotonic() - 5
        self.session = "test-run-123"
        self.sent = []

    def _memory_mb(self):
        return 123

    def _execute(self, request):
        self.sent.append(request)
        return "received"


class DirectControlTests(unittest.TestCase):
    def test_refuses_public_or_missing_or_short_credentials(self):
        fake = FakeBridge()
        for address, token in [
            ("0.0.0.0", "eightchars"),
            ("127.0.0.1", "eightchars"),
            ("8.8.8.8", "eightchars"),
            ("100.93.164.78", ""),
            ("100.93.164.78", "short"),
        ]:
            with self.subTest(address=address, length=len(token)):
                control = direct_control.DirectControl(fake, address=address, token=token)
                self.assertFalse(control.start())
                self.assertIsNone(control.httpd)

    def test_status_requires_token_and_command_is_authenticated(self):
        original = direct_control.ThreadingHTTPServer

        def test_only_bind(_private_address, handler):
            return original(("127.0.0.1", 0), handler)

        bridge = FakeBridge()
        with patch.object(direct_control, "ThreadingHTTPServer", side_effect=test_only_bind):
            control = direct_control.DirectControl(
                bridge, address="100.93.164.78", token="eightchars"
            )
            self.assertTrue(control.start())
            self.assertIsNotNone(control.httpd)

        port = control.httpd.server_port
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = f"http://127.0.0.1:{port}/api"
        try:
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                opener.open(base + "/status", timeout=3)
            self.assertEqual(rejected.exception.code, 401)

            req = urllib.request.Request(
                base + "/status", headers={"Authorization": "Bearer eightchars"}
            )
            with opener.open(req, timeout=3) as response:
                status = json.load(response)
            self.assertTrue(status["ready"])
            self.assertEqual(status["session"], "test-run-123")
            self.assertEqual(status["players"], ["Steve"])
            self.assertEqual(status["memoryMiB"], 123)

            command = urllib.request.Request(
                base + "/command",
                data=json.dumps({"type": "save", "args": {}}).encode(),
                headers={
                    "Authorization": "Bearer eightchars",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with opener.open(command, timeout=3) as response:
                result = json.load(response)
            self.assertTrue(result["ok"])
            self.assertEqual(bridge.sent, [{"type": "save", "args": {}}])

            # Commands with base64 file content can exceed 64 KiB even
            # when the original file is within the 256 KiB bridge limit.
            large_request = urllib.request.Request(
                base + "/command",
                data=json.dumps({
                    "type": "files-upload",
                    "args": {"path": "example.txt", "content_base64": "A" * 180000},
                }).encode(),
                headers={
                    "Authorization": "Bearer eightchars",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with opener.open(large_request, timeout=3) as response:
                self.assertTrue(json.load(response)["ok"])
            self.assertEqual(len(bridge.sent), 2)
        finally:
            control.stop()


if __name__ == "__main__":
    unittest.main()
