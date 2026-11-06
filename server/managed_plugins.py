"""Download a conservative set of maintained Paper plugins on runner startup.

Binary JARs are intentionally not stored in the source repository. Sources are
official GitHub, Modrinth, and Geyser endpoints. All downloads are checked for
size and JAR structure; pinned hashes are validated when available.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import zipfile

ESSENTIALS_URL = "https://github.com/EssentialsX/Essentials/releases/download/2.22.0/EssentialsX-2.22.0.jar"
ESSENTIALS_SHA256 = "bda4685105977fca2e209820a9f0ad24275bd103390a03236f38e59bfdac58e6"
GEYSER_API = "https://download.geysermc.org/v2/projects/{project}/versions/latest/builds/latest"
MODRINTH_API = "https://api.modrinth.com/v2/project/chunky/version"
USER_AGENT = "minecraft-cloud-control/1.0 (Paper plugin installer)"
MAX_JAR_SIZE = 55 * 1024 * 1024


def fetch_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def download_jar(url: str, destination: Path, checksum: str | None = None) -> None:
    if not url.startswith("https://"):
        raise ValueError("Plugin download must use HTTPS")
    temp = destination.with_suffix(".jar.download")
    temp.unlink(missing_ok=True)
    digest = hashlib.sha256()
    total = 0
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=90) as response, temp.open("wb") as out:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_JAR_SIZE:
                    raise ValueError("Plugin JAR larger than size limit")
                digest.update(chunk)
                out.write(chunk)
        if total < 1024:
            raise ValueError("Downloaded JAR is unexpectedly small")
        if checksum and digest.hexdigest().lower() != checksum.lower():
            raise ValueError("Plugin checksum mismatch")
        with zipfile.ZipFile(temp) as archive:
            names = set(archive.namelist())
            if "plugin.yml" not in names and "paper-plugin.yml" not in names:
                raise ValueError("Downloaded file has no Paper/Spigot plugin descriptor")
            if archive.testzip() is not None:
                raise ValueError("Invalid plugin archive")
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)


def geyser_build(project: str, filename: str) -> tuple[str, str | None]:
    info = fetch_json(GEYSER_API.format(project=project))
    downloads = info.get("downloads", {})
    artifact = downloads.get("spigot", {})
    checksum = artifact.get("sha256")
    return GEYSER_API.format(project=project) + "/downloads/spigot", checksum


def chunky_build() -> tuple[str, str | None]:
    versions = fetch_json(MODRINTH_API)
    for version in versions:
        supported = version.get("game_versions", [])
        loaders = set(version.get("loaders", []))
        if "26.3" not in supported or not loaders.intersection({"paper", "bukkit", "spigot", "purpur"}):
            continue
        files = version.get("files", [])
        files = sorted((f for f in files if f.get("filename", "").lower().endswith(".jar")),
                       key=lambda f: not f.get("primary", False))
        if files:
            return files[0]["url"], files[0].get("hashes", {}).get("sha256")
    raise RuntimeError("No Chunky release declares compatibility with Paper 26.3")


def install_managed_plugins(plugins: Path, state: dict[str, bool]) -> list[str]:
    plugins.mkdir(parents=True, exist_ok=True)
    specs = [
        ("EssentialsX.jar", lambda: (ESSENTIALS_URL, ESSENTIALS_SHA256)),
        ("Chunky.jar", chunky_build),
        ("Geyser-Spigot.jar", lambda: geyser_build("geyser", "spigot")),
        ("floodgate-spigot.jar", lambda: geyser_build("floodgate", "spigot")),
    ]
    installed = []
    for filename, resolve in specs:
        target = plugins / filename
        if state.get(filename, True) is False:
            target.unlink(missing_ok=True)
            print(f"Managed plugin disabled: {filename}", flush=True)
            continue
        if target.exists() and zipfile.is_zipfile(target):
            installed.append(filename)
            continue
        try:
            url, sha256 = resolve()
            download_jar(url, target, sha256)
            print(f"Verified plugin installed: {filename}", flush=True)
            installed.append(filename)
        except Exception as exc:
            target.unlink(missing_ok=True)
            print(f"WARNING: Managed plugin {filename} unavailable: {type(exc).__name__}", flush=True)
    # Never run one cross-play half without the other. Java clients must still
    # be able to play if a third-party download endpoint is temporarily down.
    bedrock_pair={"Geyser-Spigot.jar","floodgate-spigot.jar"}
    if not bedrock_pair.issubset(set(installed)):
        for filename in bedrock_pair:
            (plugins / filename).unlink(missing_ok=True)
        installed=[name for name in installed if name not in bedrock_pair]
        print("WARNING: Bedrock cross-play unavailable this session; Java server continues safely", flush=True)
    return installed
