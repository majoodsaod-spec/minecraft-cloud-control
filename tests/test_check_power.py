import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server"))
import check_power


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self, size):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class PowerStateTests(unittest.TestCase):
    def test_explicit_off_prevents_start(self):
        state = check_power.desired_state(
            "https://example.workers.dev", "token",
            opener=lambda req, timeout: FakeResponse(b'{"desired":"off"}'),
            sleep=lambda secs: None,
        )
        self.assertEqual(state, "off")

    def test_explicit_on_allows_start(self):
        self.assertEqual(check_power.desired_state(
            "https://example.workers.dev", "token",
            opener=lambda req, timeout: FakeResponse(b'{"desired":"on"}'),
            sleep=lambda secs: None,
        ), "on")

    def test_http_500_does_not_fail_server_job(self):
        attempts = []
        def server_error(req, timeout):
            attempts.append(timeout)
            raise urllib.error.HTTPError(req.full_url, 500, "Cloudflare failure", {}, None)
        output = io.StringIO()
        with redirect_stdout(output):
            state = check_power.desired_state(
                "https://example.workers.dev", "token",
                opener=server_error, sleep=lambda secs: None,
            )
        self.assertEqual(state, "on")
        self.assertEqual(len(attempts), 3)
        self.assertIn("::warning::Cloudflare power state unavailable", output.getvalue())

    def test_bad_json_is_non_fatal(self):
        self.assertEqual(check_power.desired_state(
            "https://example.workers.dev", "token",
            opener=lambda req, timeout: FakeResponse(b"<html>500</html>"),
            sleep=lambda secs: None,
        ), "on")

    def test_invalid_desired_does_not_invent_off(self):
        self.assertEqual(check_power.desired_state(
            "https://example.workers.dev", "token",
            opener=lambda req, timeout: FakeResponse(json.dumps({"desired":"maybe"}).encode()),
            sleep=lambda secs: None,
        ), "on")

    def test_missing_config_allows_start(self):
        self.assertEqual(check_power.desired_state("", ""), "on")

    def test_off_writes_disabled_to_actions_output(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "output"
            env = {
                "CONTROL_URL": "https://example.workers.dev",
                "BRIDGE_TOKEN": "redacted",
                "GITHUB_OUTPUT": str(path),
            }
            with patch.dict("os.environ", env), patch.object(
                check_power, "desired_state", return_value="off"
            ):
                check_power.main()
            self.assertEqual(path.read_text(), "enabled=false\n")


if __name__ == "__main__":
    unittest.main()
