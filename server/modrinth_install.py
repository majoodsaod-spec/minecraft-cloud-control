"""Verified Modrinth installs performed on the Minecraft runner, never on the PC.

Only Modrinth project/version IDs are accepted; the download URL and checksum
come from Modrinth's authenticated HTTPS API, not untrusted desktop input.
"""
from __future__ import annotations
import hashlib
import json
import re
import urllib.request
from pathlib import Path
from zipfile import ZipFile, BadZipFile

API="https://api.modrinth.com/v2"
UA="MinecraftCloud/1.0 (server-side Modrinth installer)"
IDENT=re.compile(r"^[A-Za-z0-9]{3,32}$")
PLUGIN_LOADERS={"paper","purpur","spigot","bukkit"}
MAX_SIZE=55*1024*1024
MC_VERSION="26.3"

# Metadata lives beside the JARs and survives verified world snapshots.
REGISTRY=".modrinth-installed.json"
def installed_inventory(data:Path):
    found={}
    path=data/"plugins"/REGISTRY
    if path.is_file():
        try:
            saved=json.loads(path.read_text(encoding="utf-8"))
            if isinstance(saved,dict):
                for project,entry in saved.items():
                    if not isinstance(entry,dict) or not IDENT.fullmatch(project):
                        continue
                    kind=entry.get("kind")
                    disk=(data/"plugins" if kind=="plugin" else data/"world/datapacks")
                    suffix=".jar" if kind=="plugin" else ".zip"
                    if kind in ("plugin","datapack") and (disk/("modrinth-"+project+suffix)).is_file():
                        found[project]=entry
        except (ValueError,OSError):
            pass
    for kind,folder,suffix in (("plugin",data/"plugins",".jar"),("datapack",data/"world/datapacks",".zip")):
        if folder.is_dir():
            for file in folder.glob("modrinth-*"+suffix):
                project=file.name[len("modrinth-"):-len(suffix)]
                if IDENT.fullmatch(project) and project not in found:
                    found[project]={"kind":kind,"versionId":None,"version":"Unknown","title":project}
    return found

def save_installed(data:Path,project_id:str,version_id:str,kind:str,title:str,version:str):
    folder=data/"plugins"
    folder.mkdir(parents=True,exist_ok=True)
    dest=folder/REGISTRY
    registry=installed_inventory(data)
    registry[project_id]={"kind":kind,"versionId":version_id,"version":version,"title":title}
    temporary=folder/(REGISTRY+".tmp")
    try:
        temporary.write_text(json.dumps(registry,indent=2,sort_keys=True)+"\n",encoding="utf-8")
        temporary.replace(dest)
    finally:
        temporary.unlink(missing_ok=True)

def get_json(url):
    request=urllib.request.Request(url,headers={"User-Agent":UA,"Accept":"application/json"})
    with urllib.request.urlopen(request,timeout=20) as response:
        if response.status!=200:raise ValueError("Modrinth metadata unavailable")
        return json.load(response)

def compatible(version,kind):
    games=version.get("game_versions") or []
    loaders=set(version.get("loaders") or [])
    if MC_VERSION not in games:
        raise ValueError("No verified version for Minecraft "+MC_VERSION)
    if kind=="plugin" and not loaders.intersection(PLUGIN_LOADERS):
        raise ValueError("Version does not support Paper/Spigot")
    if kind=="datapack" and "datapack" not in loaders:
        raise ValueError("Version is not a Minecraft datapack")

def install_modrinth(data:Path, project_id:str, version_id:str, kind:str):
    if kind not in ("plugin","datapack") or not isinstance(project_id,str) or not IDENT.fullmatch(project_id):
        raise ValueError("Invalid Modrinth project")
    if not isinstance(version_id,str) or not IDENT.fullmatch(version_id):
        raise ValueError("Invalid Modrinth version")
    project=get_json(API+"/project/"+project_id)
    version=get_json(API+"/version/"+version_id)
    if version.get("project_id")!=project.get("id"):
        raise ValueError("Version does not belong to the chosen project")
    compatible(version,kind)
    for dependency in version.get("dependencies") or []:
        if dependency.get("dependency_type")=="required":
            raise ValueError("This version requires another dependency. Install its required dependency first.")
    suffix=".jar" if kind=="plugin" else ".zip"
    files=[f for f in version.get("files",[]) if
           str(f.get("filename","")).lower().endswith(suffix) and
           f.get("file_type") not in ("sources-jar","dev-jar","javadoc-jar")]
    if not files:raise ValueError("No compatible release file")
    chosen=next((f for f in files if f.get("primary")),files[0])
    hashes=chosen.get("hashes") or {}
    # Modrinth v2 typically provides SHA-512, not SHA-256.
    algorithm="sha512" if hashes.get("sha512") else "sha256"
    expected=str(hashes.get(algorithm,"")).lower()
    url=chosen.get("url","")
    length=128 if algorithm=="sha512" else 64
    if not re.fullmatch(r"[a-f0-9]{"+str(length)+r"}",expected) or not url.startswith("https://cdn.modrinth.com/"):
        raise ValueError("Release has no trusted Modrinth CDN URL and strong file hash")
    advertised=chosen.get("size",0)
    if not isinstance(advertised,int) or not 1024<=advertised<=MAX_SIZE:
        raise ValueError("Release file exceeds safe size limit")
    # Stable, collision-resistant name avoids silently replacing another jar.
    target_dir=data/("plugins" if kind=="plugin" else "world/datapacks")
    target_dir.mkdir(parents=True,exist_ok=True)
    name="modrinth-"+project["id"]+suffix
    target=target_dir/name
    # Queued installs remain the desired state across GitHub runner restarts.
    # If the verified file already exists in the restored snapshot, do not
    # download it again on every cycle.
    if target.is_file() and target.stat().st_size==advertised:
        existing=hashlib.new(algorithm)
        with target.open("rb") as source:
            for part in iter(lambda:source.read(1024*128),b""):
                existing.update(part)
        if existing.hexdigest()==expected:
            save_installed(data,project_id,version_id,kind,project.get("title",project_id),version.get("version_number",""))
            return {"name":project.get("title",project_id),"projectId":project_id,"versionId":version_id,"file":str(target.relative_to(data)),
                    "version":version.get("version_number",""),"kind":kind,
                    "restartRequired":kind=="plugin","installed":True,"alreadyInstalled":True}
    temporary=target_dir/(name+".download")
    digest=hashlib.new(algorithm)
    total=0
    try:
        req=urllib.request.Request(url,headers={"User-Agent":UA})
        with urllib.request.urlopen(req,timeout=60) as response, temporary.open("wb") as dest:
            if response.geturl().split("/")[2]!="cdn.modrinth.com":
                raise ValueError("Unexpected download host")
            while chunk:=response.read(1024*128):
                total+=len(chunk)
                if total>MAX_SIZE:raise ValueError("Download exceeds safe size limit")
                digest.update(chunk)
                dest.write(chunk)
        if total!=advertised or digest.hexdigest()!=expected:
            raise ValueError("Download checksum or size mismatch")
        try:
            with ZipFile(temporary) as archive:
                if archive.testzip() is not None:raise ValueError("Corrupt archive")
                names=set(archive.namelist())
                if kind=="plugin" and not {"plugin.yml","paper-plugin.yml"}.intersection(names):
                    raise ValueError("Jar is not a Paper plugin")
                if kind=="datapack" and "pack.mcmeta" not in names:
                    raise ValueError("Zip has no root datapack manifest")
        except BadZipFile:
            raise ValueError("Downloaded file is not a valid archive")
        temporary.replace(target)
        save_installed(data,project_id,version_id,kind,project.get("title",project_id),version.get("version_number",""))
    finally:
        temporary.unlink(missing_ok=True)
    return {"name":project.get("title",project_id),"projectId":project_id,"versionId":version_id,"file":str(target.relative_to(data)),
            "version":version.get("version_number",""),"kind":kind,
            "restartRequired":kind=="plugin","installed":True}
