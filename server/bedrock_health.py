"""Safe, per-session Geyser/Playit diagnostics for the private desktop dashboard.

Only report booleans, fixed messages and the public join address. Never
include the Geyser signaling token, its YAML, or the Floodgate private key.
Geyser reporting a registered signaling connection does NOT prove an external
Bedrock player can reach the server.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import threading
import time

import yaml


def _listening(port: int) -> dict[str, bool | None]:
    """Read Linux's socket tables without opening a new connection or port."""
    result: dict[str, bool | None] = {"tcp": None, "udp": None}
    for kind in ("tcp", "udp"):
        available = False
        bound = False
        for filename in ("/proc/net/" + kind, "/proc/net/" + kind + "6"):
            try:
                lines = Path(filename).read_text(encoding="ascii").splitlines()[1:]
            except OSError:
                continue
            available = True
            for line in lines:
                fields = line.split()
                if len(fields) < 4:
                    continue
                try:
                    local_port = int(fields[1].split(":")[-1], 16)
                except ValueError:
                    continue
                if local_port == port and (kind == "udp" or fields[3] == "0A"):
                    bound = True
        if available:
            result[kind] = bound
    return result


class BedrockHealth:
    def __init__(self, data: Path, *, playit_snippet: bool | None = None,
                 playit_agent: bool | None = None, public_address: dict | None = None):
        self.data = Path(data)
        self.lock = threading.Lock()
        self.geyser_enabled = False
        self.floodgate_enabled = False
        self.signaling_registered = False
        self.registration_error = False
        self.last_error = ""
        self.started_at = time.monotonic()
        self.playit_snippet = bool(os.environ.get("GEYSER_PLAYIT_CONFIG", "").strip()) if playit_snippet is None else playit_snippet
        self.invalid_playit = os.environ.get("GEYSER_PLAYIT_CONFIG_INVALID", "").lower() == "true"
        self.playit_agent = os.environ.get("PLAYIT_AGENT_CONFIGURED", "").lower() == "true" if playit_agent is None else playit_agent
        self.public_address = public_address if public_address is not None else self._public_address()
        self.config = self._config_check()
        self._port_sample = {"tcp": None, "udp": None}
        self._port_sample_at = 0.0

    def _public_address(self):
        path = Path(__file__).with_name("bedrock.json")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            host = value.get("host", "")
            port = value.get("port", 19132)
            if isinstance(host, str) and re.fullmatch(r"[a-zA-Z0-9.-]{1,253}", host) and isinstance(port, int) and 1 <= port <= 65535:
                return {"host": host, "port": port}
        except (OSError, ValueError, TypeError):
            pass
        return {"host": "", "port": 19132}

    def _config_check(self):
        plugins = self.data / "plugins"
        geyser = (plugins / "Geyser-Spigot.jar").is_file()
        floodgate = (plugins / "floodgate-spigot.jar").is_file()
        path = plugins / "Geyser-Spigot" / "config.yml"
        result = {"geyserInstalled": geyser, "floodgateInstalled": floodgate,
                  "configValid": False, "nethernet": False, "floodgateAuth": False,
                  "port": 19132, "bindAddress": ""}
        if not path.is_file():
            return result
        try:
            config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if not isinstance(config, dict):
                return result
            bedrock = config.get("bedrock", {})
            java = config.get("java", config.get("remote", {}))
            if not isinstance(bedrock, dict) or not isinstance(java, dict):
                return result
            port = bedrock.get("port", 19132)
            address = bedrock.get("address", "0.0.0.0")
            result["port"] = port if type(port) is int and 1 <= port <= 65535 else 19132
            result["bindAddress"] = address if address in ("0.0.0.0", "::") else "other"
            result["nethernet"] = bedrock.get("transport") == "nethernet"
            result["floodgateAuth"] = java.get("auth-type") == "floodgate"
            result["configValid"] = (result["nethernet"] and result["floodgateAuth"]
                                    and result["port"] == 19132
                                    and result["bindAddress"] == "0.0.0.0")
        except (OSError, UnicodeError, yaml.YAMLError, TypeError):
            pass
        return result

    def observe(self, line: str) -> None:
        """Capture decisive startup events before Paper's rolling console loses them."""
        lowered = line.lower()
        with self.lock:
            if "enabling geyser-spigot" in lowered:
                self.geyser_enabled = True
            if "enabling floodgate" in lowered or "enabling floodgate-spigot" in lowered:
                self.floodgate_enabled = True
            if "registered with the external signaling service" in lowered and "not registered" not in lowered:
                self.signaling_registered = True
                self.registration_error = False
                self.last_error = ""
            if any(x in lowered for x in (
                "failed to register with the external signaling",
                "failed to connect to the external signaling",
                "could not connect to the external signaling",
                "unable to connect to the external signaling",
                "invalid signaling token",
            )):
                self.registration_error = True
                self.signaling_registered = False
                self.last_error = "Geyser could not register with Playit signaling. Recheck the tunnel's Geyser YAML secret."
            if "disconnected from the external signaling service" in lowered:
                self.signaling_registered = False

    def snapshot(self, paper_ready: bool = False) -> dict:
        now = time.monotonic()
        with self.lock:
            registered = self.signaling_registered
            geyser_enabled = self.geyser_enabled
            floodgate_enabled = self.floodgate_enabled
            error = self.registration_error
            last_error = self.last_error
            if now - self._port_sample_at >= 5:
                self._port_sample = _listening(int(self.config["port"]))
                self._port_sample_at = now
            listener = dict(self._port_sample)
        cfg = self.config
        if not cfg["geyserInstalled"] or not cfg["floodgateInstalled"]:
            status, message = "unavailable", "Geyser and Floodgate must both be installed and enabled."
        elif self.invalid_playit:
            status, message = "invalid_setup", "Geyser configuration failed. Re-copy the private Playit NetherNet Geyser YAML into GEYSER_PLAYIT_CONFIG."
        elif not cfg["configValid"]:
            status, message = "misconfigured", "Geyser must use NetherNet on 0.0.0.0:19132 with Floodgate authentication."
        elif not self.playit_snippet:
            status, message = "needs_setup", "Add GEYSER_PLAYIT_CONFIG from Playit > Bedrock (NetherNet) > Configuration help > Geyser."
        elif not self.playit_agent:
            status, message = "agent_missing", "Playit agent did not start on this runner. Check PLAYIT_SECRET_KEY and the agent startup step."
        elif error:
            status, message = "error", last_error
        elif registered:
            status, message = "signaling_registered", "Geyser registered with the external signaling service. A Bedrock client must still test joining."
        elif paper_ready:
            status, message = "awaiting_signaling", "Paper is online, but Geyser has not confirmed external signaling registration."
        else:
            status, message = "starting", "Waiting for Paper, Floodgate and Geyser startup."
        if status == "signaling_registered" and listener["udp"] is False:
            status, message = "listener_missing", "Signaling registered, but the local Bedrock UDP listener is missing."
        return {
            "status": status, "message": message,
            "geyserInstalled": cfg["geyserInstalled"], "floodgateInstalled": cfg["floodgateInstalled"],
            "geyserEnabled": geyser_enabled, "floodgateEnabled": floodgate_enabled,
            "nethernetConfigured": cfg["nethernet"], "floodgateAuth": cfg["floodgateAuth"],
            "configValid": cfg["configValid"], "playitSettingsConfigured": self.playit_snippet,
            "playitAgentConfigured": self.playit_agent, "signalingRegistered": registered,
            "localTcpListening": listener["tcp"], "localUdpListening": listener["udp"],
            "localPort": cfg["port"], "host": self.public_address.get("host", ""),
            "port": self.public_address.get("port", 19132),
            "externalReachabilityVerified": False,
        }
