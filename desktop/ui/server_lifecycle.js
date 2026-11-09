/* Server lifecycle progress is a state machine, not a percentage.
   In particular, GitHub handoff creates a NEW runner but it is still part
   of the same restart. Never return to Requested during that handoff. */
(function (root) {
  "use strict";

  const stages = Object.freeze({
    starting: Object.freeze(["Requested", "Runner", "Loading world", "Paper ready"]),
    stopping: Object.freeze(["Requested", "Saving world", "Backing up", "Stopped"]),
    restarting: Object.freeze(["Requested", "Saving world", "Backing up", "Starting", "Paper ready"]),
    restoring: Object.freeze(["Requested", "Saving world", "Backing up", "Restoring", "Paper ready"])
  });
  const ACTIVE = new Set(["requested", "waiting", "queued", "pending", "in_progress"]);
  const BAD = new Set(["failure", "cancelled", "timed_out", "action_required"]);
  const SHUTDOWN = new Set(["shutdown_requested", "saving", "stopping", "backing_up", "stopped"]);
  const COMPLETE_HOLD_MS = 2500;

  function create(kind, session = null, runId = null, now = Date.now()) {
    if (!Object.hasOwn(stages, kind)) throw Error("Unknown server operation");
    return {
      kind,
      session: session ? String(session) : null,
      runId: runId == null ? null : String(runId),
      at: now,
      stageIndex: 0,
      completedAt: null,
      failed: false
    };
  }

  function advance(operation, telemetry = {}) {
    if (!operation) return null;
    const now = Number.isFinite(telemetry.now) ? telemetry.now : Date.now();
    const phase = String(telemetry.phase || "").toLowerCase();
    const session = telemetry.session ? String(telemetry.session) : null;
    const runId = telemetry.runId == null ? null : String(telemetry.runId);
    const runStatus = String(telemetry.runStatus || "");
    const conclusion = String(telemetry.runConclusion || "");
    const ready = Boolean(telemetry.ready) && !SHUTDOWN.has(phase);
    const active = ACTIVE.has(runStatus);
    const sessionChanged = Boolean(operation.session && session && session !== operation.session);
    const runChanged = Boolean(operation.runId && runId && runId !== operation.runId);
    const newRunner = (runChanged && active) || sessionChanged;
    // Never treat an old Paper heartbeat as an event from the next runner.
    const originalSession = !operation.session || !session || session === operation.session;
    let proposed = operation.stageIndex;

    if (operation.kind === "restarting" || operation.kind === "restoring") {
      if (originalSession && !runChanged) {
        if (phase === "saving" || phase === "stopping") proposed = Math.max(proposed, 1);
        if (phase === "backing_up" || phase === "stopped") proposed = Math.max(proposed, 2);
      }
      // Dispatching the successor after backup completion is stage 3,
      // NOT a second Requested step.
      if (newRunner) proposed = Math.max(proposed, 3);
      if (ready && (sessionChanged || (runChanged && !operation.session))) {
        proposed = stages[operation.kind].length - 1;
      }
    } else if (operation.kind === "starting") {
      if (active) proposed = Math.max(proposed, 1);
      if (phase === "starting" && session && (!operation.session || sessionChanged)) {
        proposed = Math.max(proposed, 2);
      }
      if (ready && (!operation.session || sessionChanged || runChanged)) {
        proposed = stages.starting.length - 1;
      }
    } else if (operation.kind === "stopping") {
      if (phase === "saving" || phase === "stopping") proposed = Math.max(proposed, 1);
      if (phase === "backing_up") proposed = Math.max(proposed, 2);
      if (!active && !ready && (runStatus === "completed" || phase === "stopped")) {
        proposed = stages.stopping.length - 1;
      }
    }

    // A crash is not a successful handoff. Keep the last real progress stage
    // and surface a failure instead of pretending the restart finished.
    if (BAD.has(conclusion) && runStatus === "completed" &&
        (!operation.runId || !runChanged || !active)) {
      operation.failed = true;
    }
    operation.stageIndex = Math.max(operation.stageIndex, Math.min(proposed, stages[operation.kind].length - 1));
    const complete = operation.stageIndex === stages[operation.kind].length - 1;
    if (complete && !operation.failed && operation.completedAt === null) {
      operation.completedAt = now;
    }
    if (operation.completedAt !== null && now - operation.completedAt >= COMPLETE_HOLD_MS) {
      return null;
    }
    return operation;
  }

  function label(operation) {
    return stages[operation.kind][operation.stageIndex];
  }

  function detail(operation) {
    if (operation.failed) {
      return "The server workflow ended unexpectedly. Review GitHub logs before attempting another restart.";
    }
    const messages = {
      starting: [
        "Start requested. Waiting for GitHub to create the runner.",
        "GitHub runner is preparing the server.",
        "Restoring the world and starting Paper.",
        "Paper is ready."
      ],
      stopping: [
        "Safe shutdown requested.",
        "Paper is disconnecting players and flushing world data.",
        "Uploading and verifying the saved world backup.",
        "World saved and server stopped."
      ],
      restarting: [
        "Safe restart requested.",
        "Paper is disconnecting players and saving world data.",
        "Verifying the backup and handing off to the next runner.",
        "The successor GitHub runner is starting Paper.",
        "Paper is ready on the new runner."
      ],
      restoring: [
        "Restore requested.",
        "Saving the current world before restoration.",
        "Finishing the verified backup.",
        "The new runner is restoring the selected world snapshot.",
        "Paper is ready with the restored world."
      ]
    };
    return messages[operation.kind][operation.stageIndex];
  }

  root.ServerLifecycle = { stages, create, advance, label, detail };
})(window);
