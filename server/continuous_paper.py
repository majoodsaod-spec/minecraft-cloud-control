"""Paper server lifecycle for a single, bounded GitHub Actions runner session."""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
import urllib.request
import zipfile

from paper_lifecycle import DATA, OUTPUT, PREV, WORK, CONFIG, SKIP_NAMES, SKIP_FILES, digest, download_paper
from runtime_bridge import LiveBridge
from direct_control import DirectControl
from managed_plugins import install_managed_plugins
from geyser_setup import configure_geyser
from pending_files import apply_pending
from pending_modrinth import apply_modrinth_queue

IDLE_SECONDS = 3600
MAX_SECONDS = 5 * 3600 + 30 * 60
WARN_AT = (300, 60, 10)
JOIN = re.compile(r"\]: (.+?) joined the game")
LEAVE = re.compile(r"\]: (.+?) left the game")
COUNT = re.compile(r"There are (\d+) of a max of \d+ players online")
STOPPED = threading.Event()


def restore_snapshot() -> None:
    archive = PREV / "worlds.zip"
    checksum = PREV / "worlds.zip.sha256"
    if not archive.exists() and not checksum.exists():
        if os.environ.get("REQUIRE_RESTORE") == "true":
            raise RuntimeError("Required backup not found. Refusing to start an empty world.")
        print("First run: creating a new world", flush=True)
        return
    if not archive.is_file() or not checksum.is_file() or digest(archive) != checksum.read_text().strip():
        raise RuntimeError("Snapshot missing or SHA256 mismatch; refusing to start")
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            path = Path(info.filename)
            if (path.is_absolute() or ".." in path.parts or
                    any(part in SKIP_NAMES for part in path.parts) or
                    path.name in SKIP_FILES or
                    path.parts[0] in ("paper.jar", "manifest.json")):
                if path.name == "manifest.json":
                    continue
                raise RuntimeError("Unsafe backup entry: " + info.filename)
        if z.testzip() is not None:
            raise RuntimeError("Corrupt snapshot")
        z.extractall(DATA)
    (DATA / "manifest.json").unlink(missing_ok=True)
    print("Restored verified world backup", flush=True)


def snapshot() -> None:
    OUTPUT.mkdir(exist_ok=True)
    archive = OUTPUT / "worlds.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=4) as z:
        z.writestr("manifest.json", json.dumps({"created_utc": int(time.time())}))
        for path in DATA.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(DATA)
            if any(part in SKIP_NAMES for part in rel.parts) or path.name in SKIP_FILES:
                continue
            # Geyser's Playit NetherNet signaling token must never enter a
            # publicly accessible artifact. Re-create config from JAR + secret.
            if rel.as_posix() in ("plugins/Geyser-Spigot/config.yml", "plugins/floodgate/key.pem"):
                continue
            if rel.parts[0] == "paper.jar":
                continue
            z.write(path, rel.as_posix())
    (OUTPUT / "worlds.zip.sha256").write_text(digest(archive))
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise RuntimeError("Backup validation failed")
    print("Verified snapshot saved", flush=True)


def set_properties() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "eula.txt").write_text("eula=true\n")
    path = DATA / "server.properties"
    current = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                current[key] = value
    # Defaults only; preserve configured values saved by the Cloudflare panel.
    configured = WORK.parent / "server" / "server.properties"
    if configured.exists():
        for line in configured.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                current[key] = value
    defaults = {"view-distance": "6", "simulation-distance": "4",
                "motd": "Minecraft Cloud Control"}
    for key, value in defaults.items():
        current.setdefault(key, value)
    # Bind on all runner interfaces for the local Playit agent; keep authenticated accounts.
    current.update({"server-ip": "", "server-port": "25565", "online-mode": "true"})
    path.write_text("".join(f"{k}={v}\n" for k, v in current.items()))


def synchronize_plugins() -> None:
    """Persist plugin settings via snapshot; plugin JAR versions via Git."""
    repo_plugins = WORK.parent / "server" / "plugins"
    installed = DATA / "plugins"
    installed.mkdir(parents=True, exist_ok=True)
    manifest_path = repo_plugins / "plugins-state.json"
    enabled = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    source = {p.name: p for p in repo_plugins.glob("*.jar")
              if enabled.get(p.name, True)} if repo_plugins.exists() else {}
    # Preserve jars installed by the in-app Modrinth marketplace; they live
    # in verified world snapshots, not the public source repository.
    # Managed jars keep their own installation/disable logic below.
    for old in installed.glob("*.jar"):
        if old.name.startswith("modrinth-"):
            continue
        if old.name not in source and old.name in enabled and enabled.get(old.name) is False:
            old.unlink()
    for name, jar in source.items():
        shutil.copyfile(jar, installed / name)
    managed = install_managed_plugins(installed, enabled)
    # Floodgate credentials must not persist in public-facing artifacts.
    (DATA / "plugins" / "floodgate" / "key.pem").unlink(missing_ok=True)
    configure_geyser(DATA)
    print(f"Configured {len(source)} uploaded and {len(managed)} managed Paper plugins", flush=True)


def run(jar: Path) -> None:
    synchronize_plugins()
    set_properties()
    proc = subprocess.Popen(
        ["java", "-Xms2G", "-Xmx8G", "-jar", str(jar), "--nogui"],
        cwd=DATA, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    ready = threading.Event()
    lock = threading.Lock()
    input_lock = threading.Lock()  # Cloudflare and NetBird share the same Paper stdin.
    players = set()
    log_lines = deque(maxlen=100)
    bridge_restart = threading.Event()
    bridge_shutdown = threading.Event()
    observed = {"empty_since": time.monotonic(), "count": 0}
    def send(cmd: str) -> None:
        # Keep each command line atomic across the direct API, Cloudflare
        # bridge and lifecycle thread. Never interleave 'save-all' with a
        # concurrent admin command while a shutdown is in progress.
        with input_lock:
            if proc.poll() is None:
                assert proc.stdin is not None
                proc.stdin.write(cmd + "\n")
                proc.stdin.flush()
    def logs() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="", flush=True)
            with lock:
                log_lines.append(line.rstrip()[:400])
            if "Done (" in line and "For help" in line:
                ready.set()
            joined = JOIN.search(line)
            left = LEAVE.search(line)
            count = COUNT.search(line)
            with lock:
                if joined:
                    players.add(joined.group(1))
                    observed["empty_since"] = None
                if left:
                    players.discard(left.group(1))
                    if not players:
                        # Start a brand-new 60 minute idle period only when
                        # the *last* player disconnects.
                        observed["empty_since"] = time.monotonic()
                if count:
                    observed["count"] = int(count.group(1))
    threading.Thread(target=logs, daemon=True).start()
    def interrupted(_sig, _frame):
        STOPPED.set()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    bridge=LiveBridge(DATA,os.environ.get("GITHUB_RUN_ID",str(int(time.time()))),
                      players,lock,log_lines,ready,send,bridge_restart,bridge_shutdown,observed,proc.pid)
    direct=DirectControl(bridge)
    graceful = False
    try:
        bridge.start()
        direct.start()
        if not ready.wait(180) or proc.poll() is not None:
            raise RuntimeError("Paper failed to start")
        started = time.monotonic()
        bridge.started = started
        with lock:
            # A server with no players begins counting from Paper readiness,
            # not from the time Java was first launched.
            observed["empty_since"] = None if players else started
        warned = set()
        # Pregenerate a modest starter area only while no players are online.
        # Chunky saves its own task progress across verified world snapshots.
        chunky_available = (DATA / "plugins" / "Chunky.jar").is_file()
        chunky_marker = DATA / "plugins" / "Chunky" / ".cloud-pregen-started"
        try:
            chunky_radius = int(os.environ.get("CHUNKY_PREGEN_RADIUS", "512"))
        except ValueError:
            chunky_radius = 512
        chunky_radius = max(0, min(1024, chunky_radius))
        pregen_active = False
        if chunky_available and chunky_radius:
            with lock:
                no_players = not players
            if no_players:
                if chunky_marker.is_file():
                    send("chunky continue world")
                else:
                    send(f"chunky start world square 0 0 {chunky_radius}")
                    chunky_marker.parent.mkdir(parents=True, exist_ok=True)
                    chunky_marker.write_text(f"radius={chunky_radius}\n")
                pregen_active = True
                print(f"Chunky starter pre-generation running while empty (radius {chunky_radius} blocks)", flush=True)
        print("Paper online; hard shutdown at 5h30m", flush=True)
        while proc.poll() is None and not STOPPED.is_set():
            now = time.monotonic()
            elapsed = now - started
            remaining = MAX_SECONDS - elapsed
            with lock:
                empty_since = observed["empty_since"]
                online_count = len(players)
            empty_for = max(0, now - empty_since) if not online_count and empty_since is not None else 0
            if chunky_available and chunky_radius:
                if pregen_active and online_count:
                    send("chunky pause world")
                    pregen_active = False
                    print("Paused Chunky: a player joined", flush=True)
                elif not pregen_active and not online_count and empty_for >= 60 and remaining > 300:
                    send("chunky continue world")
                    pregen_active = True
                    print("Resumed Chunky: server empty", flush=True)
            for mark in WARN_AT:
                if remaining <= mark and mark not in warned and remaining > 0:
                    warned.add(mark)
                    send(f"say Server will restart in {mark} seconds. Please join again shortly.")
            if bridge_shutdown.is_set():
                print("Cloudflare requested safe stop: kick, save, backup, stay offline",flush=True)
                break
            if bridge_restart.is_set():
                print("Cloudflare requested safe restart",flush=True)
                break
            if elapsed >= MAX_SECONDS:
                print("Scheduled 5h30m handoff", flush=True)
                break
            if not online_count and empty_for >= IDLE_SECONDS:
                print("Server has been continuously empty for an hour; preparing safe restart", flush=True)
                # Players can still join during the 15 second notice. Cancel
                # the idle restart immediately if they do.
                send("say Server has been empty for 1 hour. Restarting in 15 seconds unless someone joins.")
                canceled = False
                for _ in range(15):
                    if STOPPED.is_set() or bridge_shutdown.is_set() or bridge_restart.is_set():
                        break
                    time.sleep(1)
                    with lock:
                        if players:
                            canceled = True
                            break
                if canceled:
                    print("Idle restart canceled: a player joined", flush=True)
                    send("say Idle restart canceled because a player joined.")
                    continue
                break
            time.sleep(1)
        if proc.poll() is not None:
            raise RuntimeError(f"Paper terminated unexpectedly: {proc.returncode}")
        if not STOPPED.is_set():
            bridge.phase("saving","Kicking players and saving all world data")
            message = "Server is stopping; world is being saved. Join again later." if bridge_shutdown.is_set() else "Server is restarting; join again shortly."
            send("say " + message)
            with lock:
                current_players = list(players)
            for player in current_players:
                send("kick " + player + " " + message)
            # Keep a short grace period for client disconnect packets.
            time.sleep(1)
        if pregen_active:
            send("chunky pause world")
            time.sleep(1)
        # stdin commands are ordered. Paper's synchronous save-all flush
        # completes before stop, and stop performs its own world save.
        # Waiting for the process to exit is the actual durability barrier;
        # arbitrary extra sleep here adds latency without verifying a save.
        bridge.phase("saving","Flushing worlds and stopping Paper safely")
        send("save-all flush")
        send("stop")
        proc.wait(timeout=90)
        if proc.returncode != 0:
            raise RuntimeError(f"Paper shutdown failed: {proc.returncode}")
        graceful = True
    finally:
        direct.stop()
        if proc.poll() is None:
            try:
                send("stop")
                proc.wait(timeout=90)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait()
        if graceful and (DATA / "world" / "level.dat").exists():
            bridge.phase("backing_up","Creating and verifying world backup")
            snapshot()
            # Direct NetBird shutdown must stay OFF even if Cloudflare is
            # unavailable or still reports desired=on. This flag is consumed
            # by the workflow only after successful backup validation.
            if bridge_shutdown.is_set():
                (OUTPUT / "stop-requested").write_text("true\n")
                print("Safe stop recorded; successor workflow will not be dispatched", flush=True)
        else:
            raise RuntimeError("No verified clean shutdown; refusing backup/automatic handoff")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    WORK.mkdir(exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    restore_snapshot()
    apply_pending(DATA, WORK.parent / "server" / "pending-files.json")
    apply_modrinth_queue(DATA, WORK.parent / "server" / "pending-modrinth.json")
    config = json.loads(CONFIG.read_text())
    jar = download_paper(config["minecraft_version"])
    run(jar)


if __name__ == "__main__":
    main()
