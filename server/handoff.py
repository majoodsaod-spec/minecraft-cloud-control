"""Bounded, duplicate-aware GitHub Actions handoff after a verified backup.

The caller MUST invoke this only after the successful minecraft-world artifact
upload and when the dashboard has not requested a stop. Never cancel an active
runner and never dispatch when GitHub cannot confirm current workflow state.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

ACTIVE = {"requested", "waiting", "pending", "queued", "in_progress"}
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
BRANCH = re.compile(r"^[A-Za-z0-9_.\-/]+$")


class HandoffError(RuntimeError):
    pass


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True,
                            timeout=30, check=False)
    return result.returncode, result.stdout


def active_other_run(repo: str, current: int, branch: str):
    code, output = gh("api", f"repos/{repo}/actions/workflows/paper-state-test.yml/runs?per_page=50")
    if code != 0:
        raise HandoffError("GitHub run lookup unavailable; refusing duplicate-prone dispatch")
    try:
        runs = json.loads(output)["workflow_runs"]
    except (KeyError, ValueError, TypeError) as exc:
        raise HandoffError("GitHub run listing is malformed") from exc
    if not isinstance(runs, list):
        raise HandoffError("GitHub run listing is malformed")
    for run in runs:
        if not isinstance(run, dict):
            continue
        if (run.get("status") in ACTIVE and run.get("head_branch") == branch
                and run.get("id") != current):
            return run.get("id")
    return None


def dispatch_handoff(repo: str, current: int, branch: str, *,
                     pause=time.sleep, check=active_other_run, command=gh):
    if not REPO.fullmatch(repo) or not BRANCH.fullmatch(branch) or ".." in branch:
        raise HandoffError("Invalid repository or branch")
    if not isinstance(current, int) or current <= 0:
        raise HandoffError("Invalid predecessor workflow ID")
    for attempt in range(1, 4):
        existing = check(repo, current, branch)
        if existing is not None:
            print(f"Successor or other Paper runner already active (run {existing}); no duplicate dispatched.")
            return "already-active"
        code, _output = command(
            "workflow", "run", "paper-state-test.yml", "--repo", repo,
            "--ref", branch, "-f", f"previous_run={current}",
        )
        if code == 0:
            print(f"Paper successor requested after verified backup from {current}.")
            return "dispatched"
        # A failed CLI request could still have reached GitHub. Wait for its
        # run listing to become visible before contemplating another request.
        pause(8 * attempt)
        existing = check(repo, current, branch)
        if existing is not None:
            print(f"GitHub reported a successor run ({existing}); suppressing duplicate retry.")
            return "already-active"
        if attempt < 3:
            print(f"::warning::Successor dispatch failed; retrying {attempt}/3 after checking GitHub state.")
    raise HandoffError("No successor confirmed after bounded retries. Safe scheduled recovery is required.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--branch", required=True)
    args = parser.parse_args()
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    try:
        dispatch_handoff(repo, args.run_id, args.branch)
    except (HandoffError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"::error::{type(exc).__name__}: {str(exc)[:160]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
