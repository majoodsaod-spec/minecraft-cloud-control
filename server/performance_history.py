"""Small, privacy-minimal performance history persisted in verified world backups."""
from __future__ import annotations
import json
import os
from pathlib import Path
import threading
import time

MAX_SAMPLES = 240
MAX_BYTES = 256 * 1024
FIELDS = ("cpu", "memory", "diskFree", "tps", "mspt", "players")


def bounded_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not 0 <= value <= 100000000:
        return None
    return round(value, 2)


class PerformanceHistory:
    def __init__(self, data: Path):
        self.file = Path(data) / ".cloud-performance-history.json"
        self.lock = threading.Lock()
        self.samples = []
        self.last_written = 0.0
        self._load()

    def _load(self):
        try:
            if not self.file.is_file() or self.file.stat().st_size > MAX_BYTES:
                return
            stored = json.loads(self.file.read_text(encoding="utf-8"))
            if not isinstance(stored, list):
                return
            for row in stored[-MAX_SAMPLES:]:
                if not isinstance(row, dict):
                    continue
                at = row.get("at")
                if not isinstance(at, int) or at < 0:
                    continue
                sample = {"at": at}
                for key in FIELDS:
                    sample[key] = bounded_number(row.get(key))
                self.samples.append(sample)
        except (OSError, UnicodeError, ValueError):
            self.samples = []

    def record(self, values: dict, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self.lock:
            if now-self.last_written < 60:
                return False
            row = {"at": int(time.time())}
            for key in FIELDS:
                row[key] = bounded_number(values.get(key))
            # Avoid adding a fake reading if the server has not yet started.
            if row["memory"] is None:
                return False
            self.samples.append(row)
            self.samples = self.samples[-MAX_SAMPLES:]
            temporary = self.file.with_suffix(".json.tmp")
            try:
                temporary.write_text(json.dumps(self.samples, separators=(",", ":")),
                                     encoding="utf-8")
                os.replace(temporary, self.file)
            except OSError:
                temporary.unlink(missing_ok=True)
                return False
            self.last_written = now
            return True

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(row) for row in self.samples]
