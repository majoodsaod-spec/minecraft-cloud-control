"""Restart decisions for a Minecraft server supervisor.

Pure, side-effect-free policy; no GitHub runner, Paper or cloud-storage dependency.
A supervisor applies the returned action, announces a shutdown, saves and backs up.
"""

from dataclasses import dataclass
from enum import Enum


class Action(str, Enum):
    CONTINUE = "continue"
    RESTART = "restart"


@dataclass(frozen=True)
class RestartPolicy:
    idle_check_seconds: int = 60 * 60
    forced_restart_seconds: int = 5 * 60 * 60 + 30 * 60
    warning_seconds: tuple[int, ...] = (300, 60, 10)

    def __post_init__(self):
        if self.idle_check_seconds <= 0:
            raise ValueError("idle check must be positive")
        if self.forced_restart_seconds <= self.idle_check_seconds:
            raise ValueError("forced restart must exceed idle check")
        if any(v <= 0 or v >= self.forced_restart_seconds for v in self.warning_seconds):
            raise ValueError("warning times must be between 0 and deadline")


@dataclass(frozen=True)
class Decision:
    action: Action
    reason: str
    seconds_until_forced_restart: int
    warnings_to_send: tuple[int, ...] = ()


def evaluate(
    uptime_seconds: int,
    online_players: int,
    previously_sent_warnings: set[int] | frozenset[int] = frozenset(),
    policy: RestartPolicy = RestartPolicy(),
) -> Decision:
    """Evaluate an hourly idle check and a hard restart deadline.

    Call frequently (e.g. once per second). `online_players` is the *current*
    online count, never a count of players who joined within the past hour.

    Supervisors must separately record which warnings have actually been sent.
    The policy does not perform shutdowns, backups, or job dispatch.
    """
    if uptime_seconds < 0 or online_players < 0:
        raise ValueError("uptime and online_players must be nonnegative")

    remaining = max(0, policy.forced_restart_seconds - uptime_seconds)
    if remaining == 0:
        return Decision(Action.RESTART, "forced_deadline", 0)

    # Only apply the zero-player rule at hourly checkpoints.
    if uptime_seconds > 0 and uptime_seconds % policy.idle_check_seconds == 0:
        if online_players == 0:
            return Decision(Action.RESTART, "hourly_zero_players", remaining)

    # Send warning at the first poll at/after each threshold,
    # once per session; supervisor persists the sent set.
    warnings = tuple(
        seconds
        for seconds in sorted(policy.warning_seconds, reverse=True)
        if remaining <= seconds and seconds not in previously_sent_warnings
    )
    return Decision(Action.CONTINUE, "players_online_or_not_hourly_check", remaining, warnings)
