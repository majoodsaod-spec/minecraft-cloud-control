"""Apply desired state for Modrinth-managed Paper plugin JARs.

All actions are applied after a verified world restore and before Paper starts.
No plugin configuration directories, playerdata or worlds are deleted.
Disabled JARs remain inside the verified snapshot for safe re-enablement.
Unmanaged and bundled server plugins are never touched.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re

from modrinth_install import installed_inventory

IDENT = re.compile(r"^[A-Za-z0-9]{3,32}$")
ACTIONS = {"disable", "enable", "remove"}
MANIFEST_NAME = "server/pending-content-actions.json"
DISABLED = ".disabled-modrinth"


def desired_actions(manifest: Path) -> dict:
    if not Path(manifest).is_file():
        return {}
    value = json.loads(Path(manifest).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError("Invalid queued plugin actions")
    for project, action in value.items():
        if not isinstance(project, str) or not IDENT.fullmatch(project):
            raise ValueError("Invalid managed plugin ID")
        if action not in ACTIONS:
            raise ValueError("Unsupported plugin action")
    return value


def write_registry(data: Path, registry: dict):
    path = Path(data) / "plugins" / ".modrinth-installed.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(registry, sort_keys=True, indent=2) + "\n",
                       encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def apply_content_actions(data: Path, manifest: Path):
    actions = desired_actions(manifest)
    if not actions:
        return []
    plugins = Path(data) / "plugins"
    plugins.mkdir(parents=True, exist_ok=True)
    disabled = plugins / DISABLED
    inventory = installed_inventory(Path(data))
    results = []
    for project, action in actions.items():
        active = plugins / ("modrinth-" + project + ".jar")
        inactive = disabled / ("modrinth-" + project + ".jar")
        # A missing plugin may have been removed in an earlier runner.
        # Never guess a JAR filename beyond the verified Modrinth ID.
        if action == "disable":
            if active.is_file():
                if inactive.exists():
                    raise ValueError("Disabled copy already exists; refusing to overwrite")
                disabled.mkdir(parents=True, exist_ok=True)
                active.replace(inactive)
            elif not inactive.is_file():
                raise ValueError("Plugin not found; cannot disable")
            entry = inventory.get(project, {"kind": "plugin", "title": project,
                                            "versionId": None, "version": "Unknown"})
            inventory[project] = {**entry, "kind": "plugin", "enabled": False}
        elif action == "enable":
            if inactive.is_file():
                if active.exists():
                    raise ValueError("Active plugin already exists; refusing to overwrite")
                inactive.replace(active)
            elif not active.is_file():
                raise ValueError("Plugin not found; cannot enable")
            entry = inventory.get(project, {"kind": "plugin", "title": project,
                                            "versionId": None, "version": "Unknown"})
            inventory[project] = {**entry, "kind": "plugin", "enabled": True}
        elif action == "remove":
            active.unlink(missing_ok=True)
            inactive.unlink(missing_ok=True)
            inventory.pop(project, None)
        # Keep plugin data/config folders untouched. Atomic registry update.
        write_registry(data, inventory)
        results.append({"projectId": project, "action": action, "applied": True})
    print("Applied " + str(len(results)) + " queued managed plugin action(s)", flush=True)
    return results
