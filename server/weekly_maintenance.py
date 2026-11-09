"""Safe, opt-in maintenance cadence for the transient Paper runner."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path


def read_policy(path: Path) -> dict:
    defaults={"enabled":False,"weekday_utc":6,"hour_utc":3}
    try:
        document=json.loads(Path(path).read_text(encoding="utf-8"))
        value=document["weekly_maintenance"]
        if not isinstance(value,dict) or set(value)!={"enabled","weekday_utc","hour_utc"}:
            return defaults
        enabled=value["enabled"]
        day=value["weekday_utc"]
        hour=value["hour_utc"]
        if not isinstance(enabled,bool) or type(day) is not int or type(hour) is not int:
            return defaults
        if not 0<=day<=6 or not 0<=hour<=23:
            return defaults
        return {"enabled":enabled,"weekday_utc":day,"hour_utc":hour}
    except (OSError,UnicodeError,ValueError,KeyError,TypeError):
        return defaults


def period_key(now: datetime) -> str:
    iso=now.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def due(policy: dict, now: datetime, online: int, completed: str | None) -> bool:
    if now.tzinfo is None:
        raise ValueError("UTC-aware datetime required")
    now=now.astimezone(timezone.utc)
    if not policy.get("enabled") or online!=0:
        return False
    return (now.weekday()==policy.get("weekday_utc")
            and now.hour==policy.get("hour_utc")
            and now.minute<15
            and completed!=period_key(now))


def last_completed(data: Path) -> str | None:
    try:
        value=json.loads((data/".cloud-weekly-maintenance.json").read_text(encoding="utf-8"))
        text=value.get("week")
        return text if isinstance(text,str) and len(text)==8 else None
    except (OSError,UnicodeError,ValueError,AttributeError):
        return None


def mark_completed(data: Path, now: datetime) -> None:
    path=data/".cloud-weekly-maintenance.json"
    tmp=path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"week":period_key(now)})+"\n",encoding="utf-8")
    tmp.replace(path)
