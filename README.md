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


## Managed survival plugins and Bedrock cross-play

The server automatically installs the following **maintained** plugins from official release endpoints at startup; binary files are deliberately not committed to GitHub:

| Plugin | Purpose | How it is handled |
| --- | --- | --- |
| EssentialsX 2.22.0 | Homes, teleport requests, messaging and common survival utilities | Version-pinned release with checksum from official Modrinth metadata; currently officially supports 26.1.2 (26.3 compatibility requires testing); adds commands, but does not change terrain or vanilla mechanics |
| Chunky | Pregenerate chunks to reduce world-exploration lag | Only generates a **512-block-radius area around (0, 0)** while no players are online; pauses as soon as anyone joins and before every shutdown; automatically resumes saved progress during later quiet periods |
| Geyser-Spigot | Minecraft Bedrock/Java compatibility | Current official build on each server start, Bedrock NetherNet transport on local port 19132 |
| Floodgate | Let authenticated Bedrock users join without Java Edition accounts | Official build, with Geyser set to `auth-type: floodgate` |
| spark | Built-in Paper profiler | Paper already bundles spark; no duplicate JAR is installed. Use `/spark health` or `/spark profiler start --timeout 600` |

No additional heavy or gameplay-altering optimization plugins are automatically added. For only 3–5 players, Paper's built-in optimizations plus conservative view/simulation distances are usually preferable to stacking speculative plugins.

Plugin state is stored in `server/plugins/plugins-state.json`; disable or enable a managed plugin from the dashboard, then restart safely. Other uploaded plugins remain supported. The Chunky job tracks its own progress in the saved server data. Chunk generation is intentionally limited and does not run while players are online. You can change its radius by setting the GitHub Actions repository **variable** `CHUNKY_PREGEN_RADIUS` to a number from 0 to 1024 (0 disables automatic pregeneration). The default is 512. If you want more terrain pre-generated, do it during an empty-server session rather than expanding the radius aggressively.

### Connect Bedrock players via Playit NetherNet

**A separate Playit Bedrock (NetherNet) tunnel is required.** A Java-only Playit tunnel does not make the Bedrock port accessible. Geyser's local port 19132 is not automatically your public join address.

1. In your Playit account, keep the existing **Minecraft Java** tunnel for Java players.
2. Add a second tunnel with type **Minecraft Bedrock (NetherNet)** (not the old Minecraft Bedrock/RakNet type) on the same running Playit agent.
3. Open that new tunnel's **Configuration help → Geyser → Copy**. The copied YAML includes a **private signaling token**. Never paste it into chat, dashboard public fields, source code or screenshots.
4. In GitHub → Repository Settings → Secrets and variables → Actions, create the **repository secret** `GEYSER_PLAYIT_CONFIG`, and paste the complete copied YAML snippet exactly as provided, including its `bedrock:` section.
5. After a **safe restart**, the runtime merges this secret into Geyser's generated config. It enforces `transport: nethernet`, internal port `19132`, and Floodgate authentication. The private signaling token is not committed to the repository.
6. In your Minecraft dashboard → **Connections → Bedrock Edition**, enter the public hostname and port shown in your Playit Bedrock tunnel (usually 19132 for NetherNet), then save. This is what will appear on the Overview panel.
7. Test from Minecraft Bedrock → Play → Servers → Add Server, using the **actual host and port** you entered. Watch the server console for Geyser's successful signaling registration.

The dashboard does not invent an IP or claim an untested tunnel is online. A saved host/port is display information; the live tunnel must still be created in Playit and verified from a Bedrock client.

**Security:** Because the repository is public, the server explicitly excludes the sensitive Geyser config and Floodgate key from world archives. Their credentials are re-created or injected at startup. If you've ever committed these secrets or saved older backups containing them, rotate them. Other world data remains in verified backup archives.

References: [Geyser setup](https://geysermc.org/wiki/geyser/setup/), [Floodgate setup](https://geysermc.org/wiki/floodgate/setup/), [Playit NetherNet setup](https://playit.gg/support/use-geyser-on-fabric/), [Chunky commands](https://github.com/pop4959/Chunky/wiki/Commands), [Paper spark](https://docs.papermc.io/paper/profiling/).
