"""Low-overhead collection of actual Paper tick statistics.

The runtime sends Paper's built-in 'tps' and 'mspt' console commands at a
bounded interval. Only verified command output may update these readings.
Unknown, unsupported, or stale formats remain unavailable rather than
showing invented values.
"""
from __future__ import annotations

import re
import threading
import time

ANSI = re.compile(r"\x1b\[[0-9;]*m")
MINECRAFT_COLOR = re.compile(r"§[0-9a-fk-or]", re.IGNORECASE)
NUMBER = r"([0-9]+(?:\.[0-9]+)?)"
TPS = re.compile(r"TPS from last[^:]*:\s*\*?"+NUMBER, re.IGNORECASE)
MSPT = re.compile(r"MSPT from last[^:]*:\s*"+NUMBER, re.IGNORECASE)
TICK_HEADER = re.compile(r"Tick durations\s*\(min/avg/max\)\s*from last", re.IGNORECASE)
TICK_TRIPLE = re.compile(NUMBER+r"\s*/\s*"+NUMBER+r"\s*/\s*"+NUMBER)


class PaperMetrics:
    def __init__(self):
        self.lock = threading.Lock()
        self.tps = None
        self.mspt = None
        self.tps_at = 0.0
        self.mspt_at = 0.0
        self._expect_triples = 0

    def observe(self, raw: str) -> None:
        if not isinstance(raw, str):
            return
        line = MINECRAFT_COLOR.sub("", ANSI.sub("", raw))
        now = time.monotonic()
        with self.lock:
            tps_match = TPS.search(line)
            if tps_match:
                value = float(tps_match.group(1))
                if 0 <= value <= 20.5:
                    self.tps = round(value, 2)
                    self.tps_at = now
            mspt_match = MSPT.search(line)
            if mspt_match:
                value = float(mspt_match.group(1))
                if 0 <= value <= 100000:
                    self.mspt = round(value, 2)
                    self.mspt_at = now
            if TICK_HEADER.search(line):
                self._expect_triples = 3
                return
            if self._expect_triples:
                self._expect_triples -= 1
                triple = TICK_TRIPLE.search(line)
                if triple:
                    value = float(triple.group(2))  # avg, not min or max
                    if 0 <= value <= 100000:
                        self.mspt = round(value, 2)
                        self.mspt_at = now
                    self._expect_triples = 0

    def snapshot(self) -> dict:
        now = time.monotonic()
        with self.lock:
            return {
                "tps": self.tps if now-self.tps_at <= 45 else None,
                "mspt": self.mspt if now-self.mspt_at <= 45 else None,
            }
