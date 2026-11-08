"""Private, token-authenticated control endpoint on the NetBird interface only.

No public listener, Cloudflare dependency, RCON port, or extra Python packages.
The existing LiveBridge command validation is reused for safe console, files,
players and graceful stop/restart; Paper's verified backup flow is unchanged.
"""
from __future__ import annotations

import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import os
import threading
import time


class DirectControl:
    def __init__(self, bridge, *, address=None, token=None):
        self.bridge = bridge
        self.address = address if address is not None else os.environ.get("NETBIRD_IP", "")
        self.token = token if token is not None else os.environ.get("MINECRAFT_DIRECT_TOKEN", "")
        self.httpd = None
        self.thread = None

    def start(self):
        if not self.address or len(self.token) < 8:
            print("Direct NetBird control disabled: missing private IP or token shorter than 8 characters", flush=True)
            return False
        # A private interface is mandatory, never wildcard/loopback/public.
        import ipaddress
        try:
            ip = ipaddress.ip_address(self.address)
            if ip.version != 4 or not ip in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError("Not a NetBird CGNAT IPv4")
        except ValueError:
            print("Direct NetBird control disabled: invalid overlay IP", flush=True)
            return False
        parent = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MinecraftCloudDirect"
            sys_version = ""
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *args):
                # Never print API credentials, console commands, or request URLs.
                return

            def reply(self, code, data):
                payload = json.dumps(data, separators=(",", ":")).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def authorized(self):
                supplied = self.headers.get("Authorization", "")
                expected = "Bearer " + parent.token
                if not hmac.compare_digest(supplied.encode(), expected.encode()):
                    self.reply(401, {"error": "Unauthorized"})
                    return False
                return True

            def snapshot(self):
                b = parent.bridge
                with b.lock:
                    players = sorted(str(name)[:48] for name in b.players)[:100]
                    logs = list(b.log_lines)[-100:]
                    empty_since = b.observed.get("empty_since")
                ready = b.ready.is_set()
                uptime = max(0, int(time.monotonic() - b.started)) if ready else 0
                empty_for = max(0, int(time.monotonic() - empty_since)) if empty_since is not None and not players else 0
                return {
                    "ready": ready, "phase": "running" if ready else "starting",
                    "session": b.session, "updatedAt": int(time.time() * 1000),
                    "uptime": uptime, "restartIn": max(0, 19800 - uptime),
                    "emptyFor": empty_for, "players": players, "logs": logs,
                    "memoryMiB": b._memory_mb(), "memoryLimitMiB": 8192,
                    "connection": "netbird",
                }

            def stream(self):
                # Private, bearer-authenticated SSE. Emit immediately on a log,
                # player, readiness or phase change, with a periodic telemetry
                # sample. Never expose the endpoint on a public interface.
                # Disable Nagle coalescing of small SSE frames; logs should
                # reach the connected desktop without waiting for more bytes.
                self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                previous = None
                last_sent = 0.0
                try:
                    while not parent.bridge.shutdown_event.is_set() and not parent.bridge.restart_event.is_set():
                        snapshot = self.snapshot()
                        # Uptime and timestamps change every second, but send
                        # those only on heartbeat; changes to actual game data
                        # should be delivered as soon as they are observed.
                        content = {key: value for key, value in snapshot.items()
                                   if key not in ("updatedAt", "uptime", "restartIn", "emptyFor", "memoryMiB")}
                        now = time.monotonic()
                        if content != previous or now - last_sent >= 1:
                            event = ("data: " + json.dumps(snapshot, separators=(",", ":")) + "\n\n").encode("utf-8")
                            self.wfile.write(event)
                            self.wfile.flush()
                            previous = content
                            last_sent = now
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                    return

            def do_GET(self):
                if not self.authorized():
                    return
                if self.path == "/api/events":
                    return self.stream()
                if self.path != "/api/status":
                    return self.reply(404, {"error": "Unknown endpoint"})
                self.reply(200, self.snapshot())

            def do_POST(self):
                if not self.authorized():
                    return
                if self.path != "/api/command":
                    return self.reply(404, {"error": "Unknown endpoint"})
                length = self.headers.get("Content-Length")
                # Base64-encoded file writes expand by ~4/3. Match the
                # bridge's 256 KiB file cap plus JSON framing overhead.
                if not length or not length.isdecimal() or not 0 < int(length) <= 512 * 1024:
                    return self.reply(413, {"error": "Invalid command size"})
                try:
                    body = json.loads(self.rfile.read(int(length)))
                    if not isinstance(body, dict) or not isinstance(body.get("type"), str):
                        raise ValueError("Invalid command")
                    args = body.get("args", {})
                    if not isinstance(args, dict):
                        raise ValueError("Invalid command arguments")
                    # Reuse proven permission validation from Cloudflare bridge.
                    outcome = parent.bridge._execute({"type": body["type"], "args": args})
                    self.reply(200, {"ok": True, "result": outcome})
                except (ValueError, TypeError, KeyError) as exc:
                    self.reply(400, {"error": str(exc)[:180]})
                except Exception:
                    self.reply(500, {"error": "Command failed; inspect Minecraft runner log"})

        try:
            self.httpd = ThreadingHTTPServer((self.address, 8765), Handler)
            self.httpd.daemon_threads = True
            self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True, name="NetBird Paper control")
            self.thread.start()
            print(f"Direct NetBird Paper control listening on private overlay IP {self.address}:8765", flush=True)
            return True
        except OSError:
            print("Direct NetBird control couldn't bind to its private overlay address", flush=True)
            return False

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
