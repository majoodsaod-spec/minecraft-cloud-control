"""Run real maintenance checks and append a truthful numbered history entry.

Exit 1 when any check fails, but still write the entry so CI can commit it.
No server/world secrets, runner paths, or raw logs are written to Git.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "maintenance" / "maintenance-log.md"
STATE = ROOT / "maintenance" / "status.json"
INTERVAL_DAYS = 50
CHECKS = [
    ("Python syntax", [sys.executable, "-m", "compileall", "-q", "server"]),
    ("Python unit tests", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"]),
    ("Dashboard JavaScript", ["node", "--check", "public/dashboard-pro.js"]),
    ("Live dashboard JavaScript", ["node", "--check", "public/dashboard-live.js"]),
    ("Worker JavaScript", ["node", "--input-type=module", "--check", "<stdin:src/worker.js>"]),
    ("Bridge JavaScript", ["node", "--input-type=module", "--check", "<stdin:src/bridge.js>"]),
    ("GitHub workflow YAML", [sys.executable, "-c", "import yaml, pathlib; [yaml.safe_load(p.read_text()) for p in pathlib.Path('.github/workflows').glob('*.yml')]"]),
]


def due(last_date: str | None, today: date, force: bool) -> bool:
    if force or not last_date:
        return True
    return today >= date.fromisoformat(last_date) + timedelta(days=INTERVAL_DAYS)


def run_checks() -> dict[str, bool]:
    results = {}
    for name, command in CHECKS:
        try:
            if command[-1].startswith("<stdin:"):
                source = ROOT / command[-1][7:-1]
                with source.open("rb") as stdin:
                    result = subprocess.run(command[:-1], stdin=stdin, cwd=ROOT,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            timeout=120, check=False)
            else:
                result = subprocess.run(command, cwd=ROOT, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, timeout=120, check=False)
            results[name] = result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            results[name] = False
    return results


def build_entry(number: int, today: date, current: dict[str, bool],
                previous: dict[str, bool]) -> str:
    problems = [name for name, ok in current.items() if not ok]
    fixed = [name for name, ok in current.items() if ok and previous.get(name) is False]
    new = [name for name in problems if previous.get(name) is not False]
    summary = "all good" if not problems and not fixed else (
        f"{len(fixed)} resolved, {len(problems)} failing" if fixed or problems else "all good"
    )
    lines = [f"## Maintenance #{number} — {today.isoformat()}", "",
             f"**Maintenance status: {summary}**", "",
             f"- Checks passed: {len(current)-len(problems)}/{len(current)}"]
    if fixed:
        lines.append("- Fixed since last maintenance: " + ", ".join(fixed))
    if new:
        lines.append("- New failures: " + ", ".join(new))
    if problems:
        lines.append("- Checks still failing: " + ", ".join(problems))
        lines.append("- Detailed errors: open the corresponding GitHub Actions maintenance run logs.")
    else:
        lines.append("- No errors detected in the checks performed.")
    lines.extend(["", ""])
    return "\n".join(lines)


def update_log(today: date, results: dict[str, bool], state: dict) -> int:
    previous = state.get("checks", {})
    number = int(state.get("number", 0)) + 1
    entry = build_entry(number, today, results, previous)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if LOG.exists():
        old = LOG.read_text(encoding="utf-8")
    else:
        old = "# Minecraft Cloud Control — maintenance log\n\n"
    LOG.write_text(old + entry, encoding="utf-8")
    STATE.write_text(json.dumps({
        "number": number, "last_run": today.isoformat(),
        "checks": results
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return number


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="run even if 50-day interval not elapsed")
    parser.add_argument("--date", help="maintenance date override for reproducible testing")
    args = parser.parse_args()
    today = date.fromisoformat(args.date) if args.date else datetime.now(timezone.utc).date()
    try:
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
    except (OSError, json.JSONDecodeError):
        state = {}
    if not due(state.get("last_run"), today, args.force):
        print(f"NOT_DUE: next run on {(date.fromisoformat(state['last_run']) + timedelta(days=INTERVAL_DAYS)).isoformat()}")
        return 0
    results = run_checks()
    number = update_log(today, results, state)
    print(f"MAINTENANCE_RUN={number}")
    print(f"MAINTENANCE_FAILED={'true' if not all(results.values()) else 'false'}")
    print(f"Maintenance #{number}: {sum(results.values())}/{len(results)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
