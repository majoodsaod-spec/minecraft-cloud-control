"""Install GitHub-staged Modrinth releases into the restored Paper world.

The queue lives in the source repository, never inside a mutable backup.
Apply after verified restore and before the Paper process starts.
"""
import json
import re
from pathlib import Path
from modrinth_install import install_modrinth

_ID = re.compile(r"^[A-Za-z0-9]{3,32}$")
KINDS = {"plugin", "datapack"}

def queued_installs(manifest: Path):
    if not manifest.is_file():
        return []
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(data,dict) or len(data)>100:
        raise ValueError("Invalid Modrinth install queue")
    items=[]
    for project_id, record in data.items():
        if not isinstance(project_id,str) or not _ID.fullmatch(project_id):
            raise ValueError("Invalid queued project ID")
        if not isinstance(record,dict):
            raise ValueError("Invalid queued Modrinth record")
        version_id=record.get("versionId")
        kind=record.get("kind")
        if not isinstance(version_id,str) or not _ID.fullmatch(version_id) or kind not in KINDS:
            raise ValueError("Invalid queued Modrinth version or type")
        items.append((project_id,version_id,kind))
    return items

def apply_modrinth_queue(data:Path, manifest:Path):
    queued=queued_installs(manifest)
    if not queued:
        return []
    installed=[]
    for project_id,version_id,kind in queued:
        try:
            result=install_modrinth(data,project_id,version_id,kind)
            installed.append(result)
            print("Installed queued Modrinth "+kind+": "+project_id,flush=True)
        except (ValueError,OSError,TimeoutError) as error:
            # Keep the queued request for a later session. Never delete an
            # existing installed plugin when a CDN request fails.
            print("::warning::Queued Modrinth "+kind+" "+project_id+
                  " could not be installed: "+str(error)[:180],flush=True)
    print("Queued Modrinth installs: "+str(len(installed))+"/"+str(len(queued)),flush=True)
    return installed
