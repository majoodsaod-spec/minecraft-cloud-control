"""Minimal, crash-safe lifecycle diagnostics for the Paper runner.

No credentials, player names or world content are written. This is *only*
observability: failures still abort startup and cannot skip backup validation.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import re
from pathlib import Path
import time


class LifecycleRecorder:
    def __init__(self, path: Path, clock=None):
        self.path = Path(path)
        self.clock = clock or time.monotonic
        self.started = self.clock()
        self.report = {
            "schema": 1,
            "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "state": "starting",
            "durations": {},
            "failedStage": None,
            "failureType": None,
        }
        self._save()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.report, indent=2, sort_keys=True) + "\n",
                             encoding="utf-8")
        temporary.replace(self.path)

    def record(self, stage: str, seconds: float):
        if not stage.replace("_", "").isalnum() or len(stage) > 48:
            raise ValueError("Invalid lifecycle stage")
        self.report["durations"][stage] = round(max(0.0, float(seconds)), 2)
        self._save()

    @contextmanager
    def stage(self, name: str):
        began = self.clock()
        try:
            yield
        except BaseException as exc:
            self.record(name, self.clock() - began)
            self.failure(name, type(exc).__name__)
            raise
        else:
            self.record(name, self.clock() - began)

    def failure(self, stage: str, error_type: str):
        # Explicitly only store the exception *type*: some exception messages
        # can include private URLs, paths or bearer tokens.
        self.report.update(state="failed", failedStage=stage,
                           failureType=error_type[:80])
        self._save()

    def mark(self, state: str):
        if state not in {"starting", "ready", "saved"}:
            raise ValueError("Invalid lifecycle state")
        self.report["state"] = state
        self.report["totalElapsed"] = round(max(0.0, self.clock() - self.started), 2)
        self._save()

    def public_timings(self):
        return dict(self.report["durations"])


WORLD_NAME = re.compile(r"^[A-Za-z0-9 _.-]{1,80}$")


def expected_world_directory(root: Path, configured_properties: Path | None = None):
    """Use the effective level-name, never blindly assume worlds are named 'world'."""
    data = Path(root).resolve()
    name = "world"
    for path in (data / "server.properties", configured_properties):
        if path is None or not Path(path).is_file():
            continue
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if line.startswith("#") or not line.startswith("level-name="):
                continue
            name = line.split("=", 1)[1].strip()
    if not WORLD_NAME.fullmatch(name) or name in {".", ".."} or name.startswith("."):
        raise RuntimeError("Invalid level-name; refusing access outside server world directory")
    directory = (data / name).resolve()
    if not directory.is_relative_to(data) or directory == data:
        raise RuntimeError("World folder escapes server directory")
    return directory


def verify_restored_world(root: Path, restore_required: bool,
                          configured_properties: Path | None = None):
    """Fail closed when a required world is missing after snapshot extraction."""
    if restore_required:
        world = expected_world_directory(root, configured_properties) / "level.dat"
        if not world.is_file() or world.is_symlink() or world.stat().st_size < 16:
            raise RuntimeError("Required world level.dat is missing or invalid after restore")


def markdown_summary(path: Path):
    """Safe job summary, even if Paper failed before it could start."""
    if not Path(path).is_file():
        return "### Paper lifecycle\nNo runner diagnostic report was produced.\n"
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        durations = value.get("durations", {})
        if not isinstance(durations, dict):
            durations = {}
        rows = ["### Paper lifecycle",
                f"State: **{value.get('state', 'unknown')}**",
                "",
                "| Phase | Elapsed |", "|---|---:|"]
        for name, seconds in durations.items():
            if name.replace("_", "").isalnum() and isinstance(seconds, (int, float)):
                rows.append(f"| {name.replace('_', ' ').title()} | {seconds:.2f} s |")
        if value.get("failedStage"):
            rows.extend(["", f"Failed phase: **{value['failedStage']}** "
                               f"({value.get('failureType', 'unknown')})"])
        return "\n".join(rows) + "\n"
    except (OSError, ValueError, TypeError):
        return "### Paper lifecycle\nDiagnostic report could not be decoded.\n"
