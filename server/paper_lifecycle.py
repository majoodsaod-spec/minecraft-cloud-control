"""One bounded CI cycle: restore test world, launch Paper locally, stop, archive.

This intentionally never exposes a public Minecraft port or chains workflows.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "server" / "lifecycle_config.json"
WORK = ROOT / ".lifecycle-work"
DATA = WORK / "paper"
PREV = ROOT / "previous"
OUTPUT = ROOT / "cycle-output"
# Snapshot the entire server data directory, not only dimensions. This includes
# playerdata, advancements, statistics, inventories/ender chests, plugin data,
# player UUID lists, config files and world metadata.
SKIP_NAMES = {"logs", "crash-reports", "cache", ".cache", "libraries"}
SKIP_FILES = {"session.lock", "usercache.json"}



def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def restore(cycle: int) -> None:
    if cycle == 1:
        return
    archive, checksum = PREV / "worlds.zip", PREV / "worlds.zip.sha256"
    if not archive.is_file() or not checksum.is_file():
        raise RuntimeError("Missing previous cycle snapshot")
    if digest(archive) != checksum.read_text().strip():
        raise RuntimeError("Previous cycle snapshot checksum mismatch")
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if "manifest.json" not in names:
            raise RuntimeError("Snapshot missing manifest")
        manifest = json.loads(z.read("manifest.json"))
        if manifest["cycle"] != cycle - 1:
            raise RuntimeError("Wrong previous cycle in manifest")
        for entry in z.infolist():
            p = Path(entry.filename)
            if p.is_absolute() or ".." in p.parts:
                raise RuntimeError("Unsafe path in snapshot")
            if p.parts[0] in SKIP_NAMES or p.name in SKIP_FILES or p.parts[0] == "paper.jar":
                raise RuntimeError("Unexpected snapshot file")
        z.extractall(DATA)
    (DATA / "manifest.json").unlink(missing_ok=True)
    print(f"Restored verified world snapshot from cycle {cycle-1}", flush=True)


def download_paper(version: str) -> Path:
    # PaperMC downloads v3; User-Agent identifies the testing project.
    base = f"https://fill.papermc.io/v3/projects/paper/versions/{version}/builds"
    request = urllib.request.Request(
        base, headers={"User-Agent": "minecraft-cloud-control/0.1 (https://github.com/majoodsaod-spec/minecraft-cloud-control)"}
    )
    with urllib.request.urlopen(request, timeout=30) as res:
        builds = json.load(res)
    if not isinstance(builds, list):
        raise RuntimeError(f"Unexpected Paper builds response: {builds!r}")
    stable = [b for b in builds if b.get("channel") == "STABLE"]
    if not stable:
        raise RuntimeError(f"No STABLE Paper build available for {version}")
    stable.sort(key=lambda b: int(b["id"]), reverse=True)
    download = stable[0]["downloads"]["server:default"]
    url = download["url"]
    expected_sha = download["checksums"]["sha256"]
    if not url.startswith("https://"):
        raise RuntimeError("Unexpected Paper download URL")
    dest = WORK / "paper.jar"
    req = urllib.request.Request(
        url, headers={"User-Agent": "minecraft-cloud-control/0.1 (https://github.com/majoodsaod-spec/minecraft-cloud-control)"}
    )
    with urllib.request.urlopen(req, timeout=120) as res, dest.open("wb") as out:
        shutil.copyfileobj(res, out)
    if dest.stat().st_size < 1000000:
        raise RuntimeError("Paper download unexpectedly small")
    if digest(dest) != expected_sha:
        raise RuntimeError("Paper download SHA-256 mismatch")
    print(f"Downloaded Paper {version}, build {stable[0]['id']}", flush=True)
    return dest


def run_paper(jar: Path, seconds: int, timeout: int) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    if not (DATA / "eula.txt").exists():
        (DATA / "eula.txt").write_text("eula=true\n")
    # Isolated localhost-only CI server; prevent remote player connections.
    if not (DATA / "server.properties").exists():
        (DATA / "server.properties").write_text(
        "server-ip=127.0.0.1\nserver-port=25565\nonline-mode=true\n"
        "max-players=1\nview-distance=4\nsimulation-distance=4\n"
        "spawn-protection=0\nmotd=Minecraft Cloud CI lifecycle test\n"
    )
    cmd = ["java", "-Xms512M", "-Xmx3G", "-jar", str(jar), "--nogui"]
    process = subprocess.Popen(
        cmd, cwd=DATA, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    ready = threading.Event()
    lines = []

    def consume():
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            lines.append(line)
            if "Done (" in line and 'For help, type "help"' in line:
                ready.set()
    thread = threading.Thread(target=consume, daemon=True)
    thread.start()
    try:
        if not ready.wait(timeout):
            raise RuntimeError("Paper did not report startup readiness")
        if process.poll() is not None:
            raise RuntimeError("Paper exited unexpectedly")
        print("Paper startup confirmed; testing short local session", flush=True)
        time.sleep(seconds)
    finally:
        if process.poll() is None:
            assert process.stdin is not None
            try:
                process.stdin.write("save-all flush\n")
                process.stdin.flush()
                time.sleep(3)
                process.stdin.write("stop\n")
                process.stdin.flush()
                process.wait(timeout=90)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=10)
                raise RuntimeError("Paper graceful shutdown failed; refusing snapshot")
    if process.returncode != 0:
        raise RuntimeError(f"Paper exited with code {process.returncode}")
    if not (DATA / "world" / "level.dat").is_file():
        raise RuntimeError("World level.dat missing; refusing snapshot")


def snapshot(cycle: int) -> None:
    OUTPUT.mkdir(exist_ok=True)
    archive = OUTPUT / "worlds.zip"
    manifest = json.dumps({"cycle": cycle, "created_utc": int(time.time())}).encode()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5) as z:
        z.writestr("manifest.json", manifest)
        for entry in DATA.rglob("*"):
            if not entry.is_file():
                continue
            relative = entry.relative_to(DATA)
            if any(part in SKIP_NAMES for part in relative.parts) or entry.name in SKIP_FILES:
                continue
            if relative.parts[0] == "paper.jar":
                continue
            z.write(entry, relative.as_posix())
    (OUTPUT / "worlds.zip.sha256").write_text(digest(archive))
    # Recheck our archive before leaving this job.
    with zipfile.ZipFile(archive) as z:
        assert json.loads(z.read("manifest.json"))["cycle"] == cycle
        bad = z.testzip()
        if bad:
            raise RuntimeError(f"Corrupt ZIP entry: {bad}")
    print(f"Cycle {cycle} finished. Snapshot SHA256 {digest(archive)}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle", type=int, required=True)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())
    maximum = int(config["max_cycles"])
    if maximum != 3:
        raise RuntimeError("This CI demonstration is fixed to exactly 3 bounded cycles")
    if not 1 <= args.cycle <= maximum:
        raise RuntimeError("Cycle outside configured bounds")
    WORK.mkdir(exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    restore(args.cycle)
    jar = download_paper(config["minecraft_version"])
    run_paper(jar, config["run_duration_seconds"], config["server_startup_timeout_seconds"])
    snapshot(args.cycle)


if __name__ == "__main__":
    main()
