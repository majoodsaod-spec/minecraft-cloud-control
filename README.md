# Minecraft Cloud Control

Static dashboard plus an experimental Paper Minecraft server lifecycle workflow.

## Continuous Paper workflow

Use **Actions → Continuous Paper Minecraft Server → Run workflow** to start the first session. Each session restores the most recent verified artifact if one exists, downloads a verified Paper build, starts Paper, and keeps it up until a restart condition:

- At **5 hours 30 minutes** of Paper uptime, it warns online players at 5 minutes, 1 minute, and 10 seconds, announces the shutdown, kicks all players, flushes saves, stops Paper, and verifies a ZIP backup.
- If **no player has joined in 60 minutes**, the same graceful shutdown/backup/restart happens sooner. The timer resets when a player joins.
- After successful artifact upload, the workflow dispatches a **new workflow run**, which downloads and verifies the exact previous run's snapshot, restores the world, and starts Paper anew. The next session receives a fresh GitHub-hosted runner time limit.
- A **daily scheduled recovery check** can start a session after a broken handoff. It skips when another run is active. Continuous handoffs already rerun the workflow many times within any 30-day period.

The artifact `minecraft-world` preserves world files, playerdata, advancements, inventories and server config, with SHA-256 verification. Retention is 90 days (subject to repository policy); for permanent worlds, use an independent persistent backup location. Do not delete the last successful backup.

### Player connectivity

GitHub Actions runners have no stable public inbound Minecraft port. To make the server reachable, set the Actions repository secret `PLAYIT_SECRET_KEY` to an existing Playit agent secret and configure a Minecraft Java tunnel in Playit to local TCP port **25565**. The workflow starts the agent through the official container image. Without that secret, Paper is only useful for local CI testing, not external players.

### Operational limitations

GitHub-hosted runners are temporary CI machines, **not guaranteed always-on game hosts**. Jobs may be delayed, cancelled, rate-limited, or blocked by GitHub usage limits. There will be downtime while saving, uploading, queueing, restoring, and restarting. Automatic handoff only occurs after a verified, successfully uploaded backup. A runner terminated before clean shutdown cannot guarantee preservation of its latest world changes. Daily recovery is not a substitute for durable always-on hosting.

GitHub cron cannot express exact rolling 30-day intervals; the daily recovery trigger is deliberate. Normal automatic restarts happen much more frequently than once every 30 days.

## Dashboard

The root `index.html` is a zero-dependency mobile-friendly static dashboard intended for Cloudflare Pages (framework preset **None**, build command empty, root output directory). Its local drafts and UI previews are not connected to the Minecraft server or to GitHub Actions. Never embed secrets in browser-visible files.
