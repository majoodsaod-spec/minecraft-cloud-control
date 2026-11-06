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

## Cloudflare Worker dashboard deployment

This repository deploys to the existing **Cloudflare Worker** named `minecraft-cloud-control`, not Cloudflare Pages Functions.

- Wrangler config: `wrangler.jsonc` (used by `npx wrangler deploy`).
- Static website: `public/index.html` and `public/dashboard-live.js`.
- Secure API script: `src/worker.js`; `/api/*` requests run through the Worker.
- The old `functions/` Pages Functions folder is intentionally removed. Keep the configured Cloudflare deployment command **`npx wrangler deploy`** and build root as the repository root.

### Required Cloudflare setup

In Cloudflare **Workers & Pages → minecraft-cloud-control → Settings → Variables and Secrets**, set encrypted **secrets** for the Worker:

- `ADMIN_PASSWORD`: a unique, strong password for the dashboard.
- `GITHUB_TOKEN`: a fine-grained GitHub PAT scoped only to `majoodsaod-spec/minecraft-cloud-control`, with Actions **read/write** and Contents **read/write** permissions.
- `GITHUB_REPO` (optional): defaults to `majoodsaod-spec/minecraft-cloud-control`.

After the next successful deployment, Cloudflare should allow adding Worker secrets (previously blocked because it was static-assets-only). If not, check the deployment status first. Then redeploy after adding the secrets and open the site. The dashboard prompts for the admin password, which is held in this browser tab's session storage. No GitHub token belongs in the frontend.

Protect the site with **Cloudflare Access** as an additional security layer if possible.

### Connected and planned controls

**Connected:** see GitHub workflow status; start a workflow; cancel a run (unsafe for unsaved world changes); view the latest backups; commit supported `server.properties` updates for the next session. The server reads `server/server.properties` during startup.

**Not connected yet:** live console, real-time player list or kicks, direct plugin uploads, arbitrary file manager, instant safe backups, or zero-downtime restarts. The interface leaves these as previews until a protected runtime backend exists.

GitHub Actions is temporary CI infrastructure, not reliable always-on hosting. The workflow deletes backup artifacts older than the newest ten after a successful handoff, but important worlds should also be backed up to durable storage.
