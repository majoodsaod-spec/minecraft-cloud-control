"""Fail-closed scheduled recovery gate.

A backup can be safely restored after a verified handoff failure, but automatic
recovery must not silently roll back players when a newer Paper run crashed,
was cancelled, or timed out without producing its own verified backup.
"""
import argparse
import json
import os
import subprocess
import sys

BAD = {"failure", "cancelled", "timed_out", "action_required"}


def allowed(backup_run_id, artifacts, runs, current_run_id):
    if not isinstance(artifacts, list) or not isinstance(runs, list):
        return False, "GitHub history is incomplete"
    backups = [a for a in artifacts if isinstance(a, dict)
               and a.get("name") == "minecraft-world" and not a.get("expired")]
    if backup_run_id:
        backed = [a for a in backups if a.get("workflow_run", {}).get("id") == backup_run_id]
        if not backed:
            return False, "Selected verified backup is missing"
        last_backup = max((a.get("created_at", "") for a in backed), default="")
    else:
        if backups:
            return False, "An existing backup must be selected before recovery"
        last_backup = ""
    # A failed/cancelled runner started AFTER the most recent verified backup
    # may contain unsaved gameplay progress. Stop here for manual diagnosis.
    for run in runs:
        if not isinstance(run, dict) or run.get("id") == current_run_id:
            continue
        if run.get("conclusion") not in BAD:
            continue
        if run.get("id") == backup_run_id:
            continue
        if run.get("created_at", "") > last_backup:
            return False, f"Unbacked Paper run #{run.get('id')} ended {run.get('conclusion')}"
    if not backup_run_id and any(isinstance(run, dict) and run.get("event") != "schedule"
                                 for run in runs if run.get("id") != current_run_id):
        return False, "Existing Paper history has no verified backup; manual recovery required"
    return True, "Verified snapshot has no later unbacked failed runner"


def query(repo, endpoint):
    result = subprocess.run(["gh", "api", f"repos/{repo}/{endpoint}"],
                            capture_output=True, text=True, timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError("GitHub run or backup listing unavailable")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise RuntimeError("Invalid GitHub response")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backup-run", default="")
    args = parser.parse_args()
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    current = int(os.environ.get("GITHUB_RUN_ID", "0"))
    try:
        backup = int(args.backup_run) if args.backup_run else None
        history = query(repo, "actions/workflows/paper-state-test.yml/runs?per_page=100")
        archives = query(repo, "actions/artifacts?name=minecraft-world&per_page=100")
        safe, reason = allowed(backup, archives.get("artifacts"),
                               history.get("workflow_runs"), current)
    except (ValueError, TypeError, OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        safe, reason = False, f"Recovery verification unavailable ({type(exc).__name__})"
    if safe:
        print(f"Scheduled recovery allowed: {reason}")
        return 0
    print(f"::warning::Automatic Paper recovery blocked: {reason}. "
          "Inspect failed runs and restore a verified backup manually.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
