# Minecraft Cloud Control

A server-first, responsive management dashboard for a Paper 26.3 Minecraft Java server running on temporary GitHub Actions runners. The dashboard is a Cloudflare Worker with a securely authenticated bridge to the live Paper process.

## Start, save, and stop

The **Start server** button requests a new server session, restores the latest verified world archive (when one exists), synchronizes plugins and configuration, and starts Paper/Playit.

**Save & stop** is deliberately different from cancelling a job. While the live bridge is connected it requests a safe stop:

1. Displays a pending shutdown state, then **Saving** when Paper begins shutting down.
2. Announces the shutdown and kicks every player currently tracked by the server.
3. Sends `save-all flush` and allows the save to complete before issuing `stop`.
4. Waits for Paper to exit successfully.
5. Saves the world, playerdata, inventories, advancements, plugin data, and configuration in a ZIP with SHA-256 verification.
6. Uploads the verified archive as a `minecraft-world` artifact.
7. Marks the dashboard **Stopped** only after upload succeeds, and does **not** start another session.

Stopping is refused when the live bridge is offline; it does not silently cancel the workflow or claim that a backup succeeded. If the runner crashes, is forcibly cancelled or times out, unsaved progress can still be lost. Wait for the **Stopped** phase and a new backup entry before treating the save as successful.

**Save & restart** follows the same safe sequence and starts a replacement session after a verified backup. Automatic restart occurs at a maximum of 5 hours 30 minutes of Paper uptime, or if no player joins for 60 minutes; these timers and online player counts are reported by the runner. Scheduled recovery respects the persistent dashboard **off** state.

Only the ten newest `minecraft-world` artifacts are retained after successful backup. This is not a substitute for off-platform backups. GitHub Actions is not a reliable always-on host; queueing and restarts can cause downtime, and world saves are not guaranteed if the host disappears.

## Dashboard features

| Area | Current implementation |
| --- | --- |
| Overview | Paper readiness, online players, uptime, real process memory consumption, maximum-uptime restart countdown, idle restart countdown, latest backup, and animated shutdown progress |
| Server control | Start, safe Save & Stop, safe Save & Restart; commands require an authenticated live bridge |
| Server settings | Edit supported `server.properties` values and save persistent settings; apply on next startup |
| Players | Live tracked usernames; kick, ban, pardon, whitelist, operator controls while Paper is online |
| Console | Recent live Paper stdout logs, commands, and command acknowledgments; output is not an interactive TTY |
| File manager | Browse directories, read, edit, and delete small text files. Binary files and live world-data writes are blocked |
| Plugins | Upload JARs up to 5 MiB, list them, enable/disable or remove; changes apply at next startup |
| Worlds & backups | List verified backup artifacts, request a runtime world save, perform a safe restart for a complete backup, or restore a selected backup while stopped |
| Connections | Bridge connection state and runtime configuration information |

The live bridge polls every 5 seconds, the full dashboard state polls every 30 seconds, and visible countdown values tick once per second. The browser never receives the GitHub token or bridge token. Plugin uploads and file operations are bounded for safety; larger/binary transfers and changing arbitrary live world files are not supported. The console relays commands but cannot guarantee immediate execution or return direct synchronous command responses.

## Deploy the Cloudflare dashboard

Keep the existing Cloudflare Worker deployment named `minecraft-cloud-control` with the repository root as the build root and deployment command `npx wrangler deploy`.

- `wrangler.jsonc`: Worker config, bundled static assets, and a SQLite Durable Object migration.
- `src/worker.js`: authenticated control API, GitHub API access, and bridge handling.
- `src/bridge.js`: Durable Object status, desired server state, and queued commands.
- `public/index.html`, `public/dashboard-theme.css`, `public/dashboard-live.js`, `public/dashboard-pro.js`: dashboard.
- `server/runtime_bridge.py`: outbound authenticated runner agent.

### Cloudflare Worker secrets

In **Workers & Pages → minecraft-cloud-control → Settings → Variables and Secrets**, set **encrypted**:

- `ADMIN_PASSWORD`: unique strong password used to sign in.
- `GITHUB_TOKEN`: GitHub fine-grained PAT scoped only to `majoodsaod-spec/minecraft-cloud-control`, repository permissions Actions **read/write** and Contents **read/write**.
- `BRIDGE_TOKEN`: a new random secret of 48+ characters, distinct from the admin password and GitHub token.
- `GITHUB_REPO` (optional, plain variable): defaults to `majoodsaod-spec/minecraft-cloud-control`.

### GitHub Actions repository secrets

In **Repository → Settings → Secrets and variables → Actions**, set:

- `PLAYIT_SECRET_KEY`: your existing Playit agent secret (rotate it if previously exposed).
- `CLOUDFLARE_CONTROL_URL`: exact HTTPS dashboard Worker URL, e.g. `https://minecraft-cloud-control.<account>.workers.dev` (without a trailing slash).
- `CLOUDFLARE_BRIDGE_TOKEN`: **exactly the same secret value** as the Cloudflare Worker `BRIDGE_TOKEN`.

After updating secrets, deploy Cloudflare successfully and **start a fresh server session**. An already-running runner will not gain newly added Actions secrets until its next workflow run.

### Verify operation

1. Check that Cloudflare's most recent deployment succeeded.
2. Open the dashboard and sign in using `ADMIN_PASSWORD`.
3. Press Start. Check the server session starts and the bridge reports **Online**.
4. Verify online player data and the restart countdown. Send a harmless console command such as `say Hello`.
5. Without players or valuable world changes, try **Save & stop**. Observe **Preparing to stop → Saving → Stopping → Backing up → Stopped** and verify the new artifact exists.
6. Press Start again and confirm the previous world is restored.

Test before putting valuable worlds on the server. Never place tokens in browser code, screenshots or chat messages. A token ever shown in a screenshot should be revoked and replaced. Protect admin access with Cloudflare Access if available.

## Automatic checks

The `Dashboard checks` workflow validates Python syntax, runs bridge and policy tests, and checks browser/Worker JavaScript syntax after relevant code changes. Passing these tests does not substitute for an actual Cloudflare deployment and end-to-end Paper backup/restore test.
