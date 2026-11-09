"""Select safe Minecraft world artifacts for pruning, without deleting anything.

Input: tab-separated created_at, artifact ID, producing run ID, size in bytes
from GitHub Actions API. Only output deletion candidates when the current
workflow's successfully uploaded backup is visible. Always keep ten backups.
"""
from __future__ import annotations

import argparse
import sys

KEEP = 10


def select_prunable(lines: list[str], current_run: str, keep: int = KEEP) -> tuple[list[tuple[str, int]], int]:
    artifacts: dict[str, tuple[str, str, int]] = {}
    for line in lines:
        fields = line.rstrip("\n").split("\t")
        if len(fields) != 4:
            continue
        created, artifact_id, run_id, raw_size = fields
        if not artifact_id.isdecimal() or not run_id.isdecimal() or not raw_size.isdecimal():
            continue
        artifacts[artifact_id] = (created, run_id, int(raw_size))
    ordered = sorted(artifacts.items(), key=lambda item: (item[1][0], int(item[0])), reverse=True)
    # No pruning if the freshly verified backup is not yet indexed by the API.
    # This also preserves all available backups if an upload was skipped.
    if not any(run_id == current_run for _, (_, run_id, _) in ordered):
        return [], 0
    if not ordered or ordered[0][1][1] != current_run:
        return [], 0
    candidates = [(artifact_id, data[2]) for artifact_id, data in ordered[max(keep, 2):]]
    return candidates, sum(size for _, size in candidates)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current-run", required=True)
    parser.add_argument("--keep", type=int, default=KEEP)
    args = parser.parse_args()
    if not args.current_run.isdecimal() or args.keep < 10:
        parser.error("Expected numeric current run ID and at least ten retained backups")
    ids, saved = select_prunable(sys.stdin.readlines(), args.current_run, args.keep)
    print(f"Retaining at least {args.keep} newest verified world backups; "
          f"eligible to reclaim {saved / 1048576:.1f} MiB.", file=sys.stderr)
    for artifact_id, size in ids:
        print(f"{artifact_id}\t{size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
