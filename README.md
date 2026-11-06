# Minecraft Cloud Control

Static dashboard plus an experimental Paper Minecraft server lifecycle workflow.

## Continuous Paper workflow

Use **Actions → Continuous Paper Minecraft Server → Run workflow** to start the first session. Each session restores the most recent verified artifact if one exists, downloads a verified Paper build, starts Paper, and keeps it up until a restart condition:

- At **5 hours 30 minutes** of Paper uptime, it warns online players at 5 minutes, 1 minute, and 10 seconds, announces the shutdown, kicks all players, flushes saves, stops Paper, and verifies a ZIP backup.
- If **no player has joined in 60 minutes**, the same graceful shutdown/backup/restart happens sooner. The timer resets when a player joins.
- After successful artifact upload, the workflow dispatches a **new workflow run**, which downloads and verifies the exact previous run's snapshot, restores the world, and starts Paper anew. The next session receives a fresh GitHub-hosted runner time limit.
- A **daily scheduled recovery check** can start a session after a broken handoff. It skips when another run is active. Continuous handoffs already rerun the workflow many times within any 30-day period.

The artifact `minecraft-world` preserves world files, playerdata, advancements, inventories and server config, with SHA-256 verification. The workflow retains only the ten newest unexpired `minecraft-world` artifacts, pruning older ones after a verified backup has been uploaded and a successor workflow has been dispatched. Individual artifacts have a maximum retention setting of 90 days (subject to repository policy). Keep an independent off-GitHub backup for important worlds.

### Player connectivity

GitHub Actions runners have no stable public inbound Minecraft port. To make the server reachable, set the Actions repository secret `PLAYIT_SECRET_KEY` to an existing Playit agent secret and configure a Minecraft Java tunnel in Playit to local TCP port **25565**. The workflow starts the agent through the official container image. Without that secret, Paper is only useful for local CI testing, not external players.

### Operational limitations

GitHub-hosted runners are temporary CI machines, **not guaranteed always-on game hosts**. Jobs may be delayed, cancelled, rate-limited, or blocked by GitHub usage limits. There will be downtime while saving, uploading, queueing, restoring, and restarting. Automatic handoff only occurs after a verified, successfully uploaded backup. A runner terminated before clean shutdown cannot guarantee preservation of its latest world changes. Daily recovery is not a substitute for durable always-on hosting.

GitHub cron cannot express exact rolling 30-day intervals; the daily recovery trigger is deliberate. Normal automatic restarts happen much more frequently than once every 30 days.

## Dashboard

The root `index.html` is a zero-dependency mobile-friendly dashboard for **Cloudflare Pages** (framework preset **None**, build command empty, output directory `/`). The Pages Function `functions/api/control.js` is the authenticated backend for its GitHub Actions controls.

### Required Cloudflare Pages configuration

In Cloudflare → Workers & Pages → this Pages project → **Settings → Variables and Secrets**, create encrypted **secrets** for the production environment (and preview environment if you use it):

- `ADMIN_PASSWORD`: generate a unique, strong administrator password, separate from Minecraft credentials.
- `GITHUB_TOKEN`: fine-grained GitHub PAT scoped **only** to `majoodsaod-spec/minecraft-cloud-control`, granting Actions **read/write** and Contents **read/write**. Store only in Cloudflare, never in the browser or source files.
- `GITHUB_REPO` (optional): defaults to `majoodsaod-spec/minecraft-cloud-control`.

Redeploy the Pages project after adding secrets. The Cloudflare Pages deployment must support **Pages Functions**; a static-only upload cannot execute `/api/control`. Ideally also protect the entire Pages site with **Cloudflare Access** to restrict visitors before they reach the dashboard. The dashboard prompts for the admin password and stores it only in the current browser tab's `sessionStorage`, never in the repo.

### What the dashboard can and cannot control

**Connected:** view GitHub workflow state and the 10 most recent backups; request a fresh server run; cancel an active run (unsafe for unsaved progress); change supported `server.properties` settings and commit them to GitHub. Properties are read at the next server session, not hot-applied. Click **Connect** and enter `ADMIN_PASSWORD` to enable these controls.

**Not implemented:** real-time Paper console, live player counts/kicks/bans, whitelist commands, arbitrary server file editing, plugin JAR uploads, immediate safe backup, restart-with-save on demand, and direct Cloudflare-to-Playit integration. Those require an authenticated runtime control channel or external persistent backend. The dashboard clearly labels its remaining pages as previews; their local data is not synchronized to Paper.

**Important:** GitHub Actions isn't a reliable always-on game host, and a cancelled job may lose changes since the last successful backup. Automatic deletion of backups cannot eliminate storage charges or quota overruns when each world ZIP itself becomes large. Never put secrets in `index.html` or `dashboard-live.js`.
