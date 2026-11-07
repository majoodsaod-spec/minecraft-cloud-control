#!/usr/bin/env python3
"""Fail-open power check for the GitHub-hosted Minecraft runner.

Cloudflare /api/desired is a best-effort *control signal*, not a prerequisite
for running or backing up Paper. An explicit validated "off" is respected.
Timeouts, quota errors, HTTP 5xx, invalid JSON and unavailable Cloudflare
must not turn GitHub Actions into a failed, unbacked-up Minecraft session.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request


def desired_state(url, token, *, opener=urllib.request.urlopen, sleep=time.sleep):
    if not url or not token:
        print("Cloudflare control is not configured; server is enabled.", flush=True)
        return "on"
    endpoint = url.rstrip("/") + "/api/desired"
    # Never include token or endpoint (which can contain private URLs) in logs.
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                endpoint,
                headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
            )
            with opener(request, timeout=12) as response:
                payload = response.read(65536)
            parsed = json.loads(payload)
            desired = parsed.get("desired") if isinstance(parsed, dict) else None
            if desired not in ("on", "off"):
                raise ValueError("Response must include desired='on' or 'off'")
            print(f"Cloudflare power preference: {desired}", flush=True)
            return desired
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
            # Report only the error *type* to prevent accidental token disclosure.
            reason = getattr(exc, "code", type(exc).__name__)
            print(f"::warning::Cloudflare power check attempt {attempt + 1}/3 failed ({reason}).", flush=True)
            if attempt < 2:
                sleep(attempt + 1)
    print(
        "::warning::Cloudflare power state unavailable. Keeping Minecraft enabled "
        "instead of failing the GitHub Actions run. An explicit 'off' still works "
        "when the control service is reachable.",
        flush=True,
    )
    return "on"


def main():
    state = desired_state(
        os.environ.get("CONTROL_URL", ""),
        os.environ.get("BRIDGE_TOKEN", ""),
    )
    enabled = "false" if state == "off" else "true"
    if state == "off":
        print("Dashboard explicitly requested the server to stay stopped.", flush=True)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as file:
            file.write(f"enabled={enabled}\n")
    else:
        print(f"enabled={enabled}", flush=True)


if __name__ == "__main__":
    main()
