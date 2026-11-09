"""Offline file operations applied after verified snapshot restore, before Paper.

The immutable backup is never edited. Operations are restricted to ordinary
configuration text files and safe empty directories outside world/playerdata.
Completed operation receipts are stored in the NEXT verified snapshot, making
queued operations idempotent across server handoffs.

Do not use this module to manage plugin JARs or world/player data.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

from pending_files import safe_path

ID = re.compile(r"^[a-z0-9-]{12,80}$")
SEGMENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*$")
PROTECTED_PARTS = {
    "world", "playerdata", "stats", "advancements", "cache", "libraries",
    "logs", "crash-reports", "plugins-disabled", "floodgate"
}
RECEIPT = ".cloud-applied-ops.json"
LIMIT = 100


def safe_directory(value: str) -> str:
    if not isinstance(value, str) or not 0 < len(value) <= 180:
        raise ValueError("Invalid folder path")
    parts = value.split("/")
    if len(parts) > 8 or any(not SEGMENT.fullmatch(p) or p.startswith(".")
                             for p in parts):
        raise ValueError("Unsafe folder path")
    if any(p.lower() in PROTECTED_PARTS or p.lower().startswith("world_")
           for p in parts):
        raise ValueError("World, player and protected folders cannot be changed")
    if parts[0].lower() == "plugins" and len(parts) <= 1:
        raise ValueError("Cannot modify plugins root folder")
    if any(p.lower() in {"geyser-spigot", "floodgate-spigot"}
           for p in parts[1:] if parts[0].lower() == "plugins"):
        raise ValueError("Managed plugin folders are protected")
    return value


def _safe_file(path):
    safe_path(path)
    parts = path.split("/")
    if any(p.lower() in PROTECTED_PARTS or p.lower().startswith("world_")
           for p in parts):
        raise ValueError("Protected file path")
    return path


def _verified_destination(data: Path, name: str) -> Path:
    root = data.resolve()
    target = (root / name).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError("Path escapes server directory")
    # Never traverse symlinks, including symlinked parent folders.
    current = root
    for part in name.split("/"):
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlinked server paths cannot be changed")
    return target


def validate_operation(item: dict) -> dict:
    if not isinstance(item, dict) or set(item) - {"id", "type", "path", "target"}:
        raise ValueError("Invalid queued operation")
    op_id = item.get("id")
    kind = item.get("type")
    path = item.get("path")
    if not isinstance(op_id, str) or not ID.fullmatch(op_id):
        raise ValueError("Invalid queued operation ID")
    if kind == "mkdir":
        safe_directory(path)
        if "target" in item:
            raise ValueError("Folder creation does not accept a target")
    elif kind == "delete":
        _safe_file(path)
        if "target" in item:
            raise ValueError("Delete does not accept a target")
    elif kind == "rename":
        _safe_file(path)
        _safe_file(item.get("target"))
        if path == item["target"] or Path(path).parent != Path(item["target"]).parent:
            raise ValueError("Rename must stay in the same directory")
    else:
        raise ValueError("Unsupported queued file operation")
    return item


def load_operations(manifest: Path) -> list[dict]:
    if not manifest.is_file():
        return []
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("Unsupported operations manifest")
    ops = data.get("operations")
    if not isinstance(ops, list) or len(ops) > LIMIT:
        raise ValueError("Invalid operations queue")
    seen = set()
    for item in ops:
        validate_operation(item)
        if item["id"] in seen:
            raise ValueError("Duplicate queued operation ID")
        seen.add(item["id"])
    return ops


def _fingerprint(item):
    return hashlib.sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _receipts(data: Path):
    file = data / RECEIPT
    if not file.is_file():
        return {}
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or len(value) > 1000:
        raise ValueError("Invalid operation receipts")
    return value


def apply_pending_operations(data: Path, manifest: Path, edits_manifest: Path | None = None):
    items = load_operations(manifest)
    if not items:
        return 0
    data = data.resolve()
    edits = {}
    if edits_manifest and edits_manifest.is_file():
        edits = json.loads(edits_manifest.read_text(encoding="utf-8"))
        if not isinstance(edits, dict):
            raise ValueError("Invalid staged edit manifest")
    # Validate the COMPLETE queue and all target paths before making changes.
    changes = []
    for item in items:
        path = _verified_destination(data, item["path"])
        target = _verified_destination(data, item["target"]) if item["type"] == "rename" else None
        if item["type"] in {"delete", "rename"} and item["path"] in edits:
            raise ValueError("Queued file operation conflicts with a text edit")
        if target and item["target"] in edits:
            raise ValueError("Queued rename destination conflicts with a text edit")
        changes.append((item, path, target))

    receipts = _receipts(data)
    changed = 0
    for item, path, target in changes:
        receipt_key = _fingerprint(item)
        if receipts.get(item["id"]) == receipt_key:
            continue
        kind = item["type"]
        if kind == "mkdir":
            if path.exists() and not path.is_dir():
                raise ValueError("A file already occupies the queued folder path")
            path.mkdir(parents=True, exist_ok=True)
        elif kind == "delete":
            if path.is_dir():
                raise ValueError("Queued delete cannot remove directories")
            if path.exists():
                if not path.is_file():
                    raise ValueError("Queued delete path is not a normal file")
                path.unlink()
        elif kind == "rename":
            if path.exists():
                if not path.is_file() or target.exists():
                    raise ValueError("Queued rename would overwrite an existing file")
                if not target.parent.is_dir():
                    raise ValueError("Queued rename target directory does not exist")
                path.rename(target)
            elif not target.is_file():
                raise ValueError("Queued rename source disappeared and target is missing")
        receipts[item["id"]] = receipt_key
        # Atomic receipt update so interrupted runner startups cannot leave
        # a partly written receipt in a future verified world snapshot.
        temp = data / (RECEIPT + ".tmp")
        try:
            temp.write_text(json.dumps(receipts, sort_keys=True, indent=2) + "\n",
                            encoding="utf-8")
            os.replace(temp, data / RECEIPT)
        finally:
            temp.unlink(missing_ok=True)
        changed += 1
    print(f"Offline file operations: {changed} newly applied / {len(items)} queued", flush=True)
    return changed
