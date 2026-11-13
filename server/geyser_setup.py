"""Prepare Geyser and Floodgate for safe Java/Bedrock cross-play.

The optional Playit NetherNet snippet lives in an Actions secret, NEVER in
repository files or uploaded world archives.
"""
from __future__ import annotations

import os
from pathlib import Path
import zipfile

import yaml


def _merge(target: dict, patch: dict) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = value


def configure_geyser(data: Path) -> None:
    folder = data / "plugins" / "Geyser-Spigot"
    path = folder / "config.yml"
    jar = data / "plugins" / "Geyser-Spigot.jar"
    if not jar.is_file():
        print("Geyser plugin unavailable; skipping Bedrock configuration", flush=True)
        return
    folder.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    else:
        with zipfile.ZipFile(jar) as archive:
            # Geyser normally generates this file itself, but preparing before
            # the first startup avoids an online-authentication mismatch.
            template = next((name for name in ("config.yml", "geyser.yml")
                             if name in archive.namelist()), None)
            config = yaml.safe_load(archive.read(template).decode("utf-8")) if template else {}
    if not isinstance(config, dict):
        raise RuntimeError("Invalid Geyser configuration")
    bedrock = config.setdefault("bedrock", {})
    if not isinstance(bedrock, dict):
        raise RuntimeError("Invalid Geyser Bedrock section")
    bedrock.update({"address": "0.0.0.0", "port": 19132, "clone-remote-port": False, "transport": "nethernet"})
    java = config.setdefault("java", {})
    if not isinstance(java, dict):
        raise RuntimeError("Invalid Geyser Java section")
    java["auth-type"] = "floodgate"
    # Some older Geyser builds call this section 'remote'.
    if isinstance(config.get("remote"), dict):
        config["remote"]["auth-type"] = "floodgate"

    playit = os.environ.get("GEYSER_PLAYIT_CONFIG", "").strip()
    if playit:
        # Users copy the exact snippet from Playit > Bedrock (NetherNet) tunnel
        # > Configuration help > Geyser into this Actions secret.
        overrides = yaml.safe_load(playit)
        if not isinstance(overrides, dict) or not isinstance(overrides.get("bedrock"), dict):
            raise RuntimeError("GEYSER_PLAYIT_CONFIG must include a bedrock: YAML section")
        _merge(bedrock, overrides["bedrock"])
        # Keep the server's real ports and secure login policy unchanged.
        bedrock["transport"] = "nethernet"
        bedrock["address"] = "0.0.0.0"
        bedrock["port"] = 19132
        bedrock["clone-remote-port"] = False
        java["auth-type"] = "floodgate"
        print("Applied private Playit NetherNet signaling settings", flush=True)
    else:
        print("Bedrock plugin configured locally; external NetherNet tunnel signaling not configured", flush=True)

    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
