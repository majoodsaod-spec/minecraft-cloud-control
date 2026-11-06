"""Paper server lifecycle for a single, bounded GitHub Actions runner session."""
from __future__ import annotations

import argparse
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
    current.update({"server-ip": "", "server-port": "25565", "online-mode": "true",
                    "view-distance": "6", "simulation-distance": "4",
                    "motd": "Minecraft Cloud Control"})
    path.write_text("".join(f"{k}={v}\n" for k, v in current.items()))


def run(jar: Path) -> None:
    set_properties()
    proc = subprocess.Popen(
        ["java", "-Xms512M", "-Xmx3G", "-jar", str(jar), "--nogui"],
        cwd=DATA, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    ready = threading.Event()
    lock = threading.Lock()
    players = set()
    observed = {"last_join": time.monotonic(), "count": 0}
    def send(cmd: str) -> None:
        if proc.poll() is None:
            assert proc.stdin is not None
            proc.stdin.write(cmd + "\n")
            proc.stdin.flush()
    def logs() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="", flush=True)
            if "Done (" in line and "For help" in line:
                ready.set()
            joined = JOIN.search(line)
            left = LEAVE.search(line)
            count = COUNT.search(line)
            with lock:
                if joined:
                    players.add(joined.group(1))
                    observed["last_join"] = time.monotonic()
                if left:
                    players.discard(left.group(1))
                if count:
                    observed["count"] = int(count.group(1))
    threading.Thread(target=logs, daemon=True).start()
    def interrupted(_sig, _frame):
        STOPPED.set()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    graceful = False
    try:
        if not ready.wait(180) or proc.poll() is not None:
            raise RuntimeError("Paper failed to start")
        started = time.monotonic()
        warned = set()
        print("Paper online; hard shutdown at 5h30m", flush=True)
        while proc.poll() is None and not STOPPED.is_set():
            now = time.monotonic()
            elapsed = now - started
            remaining = MAX_SECONDS - elapsed
            with lock:
                last_join = observed["last_join"]
            for mark in WARN_AT:
                if remaining <= mark and mark not in warned and remaining > 0:
                    warned.add(mark)
                    send(f"say Server will restart in {mark} seconds. Please join again shortly.")
            if elapsed >= MAX_SECONDS:
                print("Scheduled 5h30m handoff", flush=True)
                break
            if now - last_join >= IDLE_SECONDS:
                print("No player joined for an hour; restarting", flush=True)
                send("say No players joined in the past hour. Server restarting in 15 seconds; rejoin shortly.")
                time.sleep(15)
                break
            time.sleep(1)
        if proc.poll() is not None:
            raise RuntimeError(f"Paper terminated unexpectedly: {proc.returncode}")
        if not STOPPED.is_set():
            send("say Server is restarting now. Please join again shortly.")
            send("kick @a Server restarting; please join again shortly.")
            time.sleep(2)
        send("save-all flush")
        time.sleep(5)
        send("stop")
        proc.wait(timeout=90)
        if proc.returncode != 0:
            raise RuntimeError(f"Paper shutdown failed: {proc.returncode}")
        graceful = True
    finally:
        if proc.poll() is None:
            try:
                send("stop")
                proc.wait(timeout=90)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait()
        if graceful and (DATA / "world" / "level.dat").exists():
            snapshot()
        else:
            raise RuntimeError("No verified clean shutdown; refusing backup/automatic handoff")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.parse_args()
    WORK.mkdir(exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    restore_snapshot()
    config = json.loads(CONFIG.read_text())
    jar = download_paper(config["minecraft_version"])
    run(jar)


if __name__ == "__main__":
    main()
