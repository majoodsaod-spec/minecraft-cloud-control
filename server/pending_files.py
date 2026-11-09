"""Apply staged text changes to the restored server snapshot before Paper starts.

The GitHub Actions backup remains immutable. Only files in server/pending-files.json
are applied, with strict path / content protection. Changes remain queued in
GitHub across later sessions, so the repo overlay is a stable source of truth.
"""
from pathlib import Path
import hashlib
import json
import os
import re

TEXT={".txt",".json",".yml",".yaml",".properties",".conf",".cfg",".toml",".md"}
PROTECTED={"key.pem","usercache.json","ops.json","whitelist.json",
           "banned-players.json","banned-ips.json","eula.txt","credentials.json",
           "secrets.json","server.properties"}
FORBIDDEN={"playerdata","advancements","stats","cache","libraries","logs","crash-reports"}
PATTERN=re.compile(r"^[a-zA-Z0-9_.\-/]+$")

def safe_path(name):
    if not isinstance(name,str) or not 0<len(name)<=180 or not PATTERN.fullmatch(name):
        raise ValueError("Invalid staged filename")
    parts=Path(name).parts
    if Path(name).is_absolute() or any(p in ("",".","..") or p.startswith(".") for p in parts):
        raise ValueError("Unsafe staged path")
    if any(p.lower() in FORBIDDEN or p.lower()=="world" or p.lower().startswith("world_") for p in parts):
        raise ValueError("World and player data cannot be staged")
    if Path(name).name.lower() in PROTECTED or Path(name).suffix.lower() not in TEXT:
        raise ValueError("Protected or non-text staged file")
    if len(parts)>2 and parts[0]=="plugins" and parts[1].lower()=="geyser-spigot" and parts[-1]=="config.yml":
        raise ValueError("Protected Geyser configuration")
    return name


def world_folders(data:Path, configured_properties:Path|None=None):
    """Protect worlds even when the level-name is not literally 'world'."""
    roots={"world","world_nether","world_the_end"}
    for config in (Path(data)/"server.properties",configured_properties):
        if config is None or not Path(config).is_file():
            continue
        for line in Path(config).read_text(encoding="utf-8").splitlines():
            if not line.startswith("level-name="):
                continue
            name=line.split("=",1)[1].strip().lower()
            if name and "/" not in name and "\\" not in name:
                roots.update({name,name+"_nether",name+"_the_end"})
    return roots


def reject_world_path(data:Path, path:str, configured_properties:Path|None=None):
    if path.split("/")[0].lower() in world_folders(data,configured_properties):
        raise ValueError("World data cannot be staged")


def apply_pending(data:Path,manifest:Path,configured_properties:Path|None=None):
    if not manifest.is_file():return 0
    changes=json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(changes,dict) or len(changes)>250:
        raise ValueError("Invalid server file overlay")
    # Validate all changes before applying any; refuse untrusted paths.
    verified=[]
    for name,value in changes.items():
        safe_path(name)
        reject_world_path(data,name,configured_properties)
        if not isinstance(value,str) or "\0" in value or len(value.encode("utf-8"))>131072:
            raise ValueError("Invalid staged file contents")
        target=(data/name).resolve()
        if not target.is_relative_to(data.resolve()):
            raise ValueError("Staged path escapes server directory")
        verified.append((target,value))
    # Receipts survive in verified backups, so the user can distinguish
    # changes already applied to Paper from edits still awaiting a startup.
    receipts_path=data/".cloud-applied-edits.json"
    receipts={}
    if receipts_path.is_file():
        receipts=json.loads(receipts_path.read_text(encoding="utf-8"))
        if not isinstance(receipts,dict) or len(receipts)>1000:
            raise ValueError("Invalid staged file receipts")
    changed=0
    for target,value in verified:
        path=target.relative_to(data.resolve()).as_posix()
        digest=hashlib.sha256(value.encode("utf-8")).hexdigest()
        if receipts.get(path)==digest:
            continue
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(value,encoding="utf-8")
        receipts[path]=digest
        changed+=1
    if changed:
        temp=data/".cloud-applied-edits.json.tmp"
        try:
            temp.write_text(json.dumps(receipts,indent=2,sort_keys=True)+"\n",encoding="utf-8")
            os.replace(temp,receipts_path)
        finally:
            temp.unlink(missing_ok=True)
    print(f"Staged server text edits: {changed} newly applied / {len(verified)} queued",flush=True)
    return changed
