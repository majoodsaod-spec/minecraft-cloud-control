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

**Save & restart** follows the same safe sequence and starts a replacement session after a verified backup. Automatic restart occurs at a maximum of 5 hours 30 minutes of Paper uptime, or after 60 continuous minutes with no players online; these timers and online player counts are reported by the runner. Scheduled recovery respects the persistent dashboard **off** state.

Only the ten newest `minecraft-world` artifacts are retained after a verified successful backup. The cleanup workflow first confirms the newest archive is visible via GitHub's API, and skips deletion if it cannot verify the new backup. This is not a substitute for off-platform backups. GitHub Actions is not a reliable always-on host; queueing and restarts can cause downtime, and world saves are not guaranteed if the host disappears.

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
| Worlds & backups | List the newest ten verified world artifacts, view authenticated aggregate world storage, safely restore a selected world, and atomically download snapshots |
| Performance (Windows) | Real Paper TPS/MSPT, CPU, Java RSS, ephemeral runner disk capacity, a bounded time-series chart, sustained-condition warnings, and opt-in one-minute Spark profiling |
| Automations (Windows) | Opt-in empty-server weekly UTC maintenance window; configuration takes effect when the next runner starts and uses the normal verified save-and-restart process |
| Connections | Bridge connection state and runtime configuration information |

The live bridge polls every 5 seconds, the full dashboard state polls every 30 seconds, and visible countdown values tick once per second. The browser never receives the GitHub token or bridge token. Plugin uploads and file operations are bounded for safety; larger/binary transfers and changing arbitrary live world files are not supported. The console relays commands but cannot guarantee immediate execution or return direct synchronous command responses.

## Performance, monitoring and scheduled maintenance

The desktop Overview displays genuine Paper TPS/MSPT from the built-in console commands rather than approximating them from host CPU. Missing or stale readings display dashes. CPU process utilization may exceed 100% on multi-core runners; storage metrics describe the disposable GitHub runner, **not** GitHub artifact retention. The agent collects bounded one-minute aggregate statistics in `.cloud-performance-history.json` inside the verified world snapshot; it does not record player names, addresses, or chat content. The native desktop app retrieves this history over the authenticated direct connection. Live samples are limited to ten minutes or the latest 120 displayed readings.

The **Run 60-second Spark profile** action is optional and requires confirmation. Paper reports the profiler link in Live Console when finished. Profiling may consume server resources; it never starts automatically.

The **Automations** page edits `server/automation-policy.json` on GitHub. Weekly maintenance defaults to disabled. When enabled, an eligible runner checks the chosen weekday/hour in UTC, and only begins a normal safe stop, world backup, and restart if it is empty throughout a 15-second warning. An empty-server maintenance receipt is included in the next backup so that the same week is not automatically retriggered. If players join, the maintenance window is skipped. This is best effort because GitHub runners can be stopped or delayed; it is **not** guaranteed wall-clock scheduling. After changing the policy, start a new runner or wait for a safe handoff before expecting the change to apply.

World restores initiated while a server is active require the current server to finish safe shutdown **and** publish a new backup artifact; otherwise the restore aborts. Downloads are written as temporary files and renamed only after the transfer finishes. Keep off-platform copies of important worlds; GitHub artifact retention is not durable storage.

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
| PerformanceAnalyzer 3.1+ | Read-only TPS, MSPT, GC and lag-incident diagnostics | Only a current release explicitly supporting 26.3 with a published SHA-256 is installed; older builds with entity cleaner or anti-cheat features are rejected |

Research checked current offerings including LessLag, Let Me Despawn, ServerTune, ClearLag, entity optimizers, and Fabric-only optimization mods. Most either delete/merge items, change entity spawning or AI, throttle redstone or hoppers, or are incompatible with Paper. They are **intentionally excluded** to preserve survival mechanics.

No additional heavy or gameplay-altering optimization plugins are automatically added. For only 3–5 players, Paper's built-in optimizations plus conservative view/simulation distances are usually preferable to stacking speculative plugins.

Plugin state is stored in `server/plugins/plugins-state.json`; disable or enable a managed plugin from the dashboard, then restart safely. Other uploaded plugins remain supported. The Console page includes one-click read-only performance commands (`spark tps`, `spark health`, `perfstatus`, `perfincidents 5`). Monitoring records causes of lag; it does not automatically improve FPS/TPS. The Chunky job tracks its own progress in the saved server data. Chunk generation is intentionally limited and does not run while players are online. You can change its radius by setting the GitHub Actions repository **variable** `CHUNKY_PREGEN_RADIUS` to a number from 0 to 1024 (0 disables automatic pregeneration). The default is 512. If you want more terrain pre-generated, do it during an empty-server session rather than expanding the radius aggressively.

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


### Let Me Despawn · optimized with protected survival mechanics

Let Me Despawn **1.26.10.3 (Paper/Bukkit release for Minecraft 26.3)** is installed automatically from the official Modrinth release metadata with SHA-256 verification. Fabric/NeoForge JARs and incompatible older versions are never installed.

The plugin uses its **maintainer's normal despawn behavior**, which is the strongest configuration appropriate for this server without enabling extra item or mob-cleanup systems:

- Unnamed mobs which become persistent *only because they picked up equipment* may despawn naturally when distant from players, rather than lingering permanently.
- Their carried/picked-up equipment is dropped when the mob naturally despawns; the plugin does not run a separate item-clear task.
- Named mobs remain protected. Tamed or intentionally persistent mobs are not deliberately targeted by this configuration.
- No lower mob caps, entity stacking, aggressive despawn radius changes, hopper throttling, farm nerfs, or item-removal plugins are enabled.

**This does modify vanilla gameplay:** a mob that picked up an item may eventually despawn where vanilla would have kept it. Dropped equipment can still naturally expire under the vanilla item timer if nobody collects it. Players should name-tag any special mobs they want preserved. Do not interpret “drops the item” as a guarantee that an unattended dropped item will remain forever.

The plugin is enabled in `server/plugins/plugins-state.json` and can be toggled on the dashboard's Plugins page. It takes effect after a safe server restart; its precise current behavior and Bukkit config must be verified from the live Paper startup logs. We deliberately do not inject guessed mod-loader configuration keys into a Bukkit plugin config.


## Interactive live file manager

The Files page is a full server-backed explorer, not a free-text path editor. When the running Paper bridge is online it automatically loads the real server root and an expandable folder tree (up to two nested levels initially). The right panel lists directory contents with names, sizes, timestamps, sorting, search, and clickable folders. No folder path needs to be typed.

- Breadcrumb navigation, server root, parent folder, refresh, and expandable tree
- New directories, rename, safe text editing, delete with confirmation, and downloads
- Styled **Upload files** and **Select plugin JAR** pickers consistent with the dashboard design
- Upload multiple UTF-8 configuration/text files (up to 256 KiB each); live file downloads limited to 256 KiB because the authenticated bridge uses small command acknowledgements
- File contents and changes come from the current GitHub Actions runner, not a fake GitHub repository filesystem
- Protected Geyser/Playit secrets, Floodgate keys, operator lists, binary JAR modification, and world/player mutations remain inaccessible
- File edits survive future sessions only after a **successful verified backup**; save/restart safely when finished
- File operations require the server to be online and the Worker dashboard to be deployed with the matching backend version

The server protects plugin JARs by routing them through the existing Plugins page rather than arbitrary live uploads. Large binary/world-file transfer and recursive folder deletion are intentionally not included in the live command bridge; use verified backups for world data.


## GitHub Actions storage and maintenance

World snapshots are produced only after a graceful Paper shutdown and checked with SHA-256. The **ten newest** valid `minecraft-world` GitHub Actions artifacts are kept, with a maximum artifact lifetime of **90 days**. Older backups are cleaned up after the newly uploaded backup is listed by GitHub; cleanup cannot run when backup/upload fails. The run summary reports how much artifact storage was reclaimed. Backups can still expire if the server is stopped for a long time, so download important worlds off GitHub regularly.

GitHub automatically disables scheduled workflows in a public repository after 60 days with no repository activity. This project intentionally does **not** generate dummy commits merely to evade inactivity checks. Use legitimate code/dependency maintenance and check GitHub's Actions page if scheduled recovery is disabled. GitHub-hosted runners should not be relied on as an always-on game-server host; these storage optimizations do not change GitHub's platform restrictions.


## Numbered maintenance log (every 50 days)

The [Minecraft maintenance log workflow](.github/workflows/maintenance-log.yml) checks whether 50 days have passed since the last actual maintenance report. Daily scheduled eligibility checks do **not** create Git commits, but a due run performs real validation and commits a numbered record to [maintenance/maintenance-log.md](maintenance/maintenance-log.md) and machine-readable results to `maintenance/status.json`.

Example entries (illustrative, not actual test results):

```text
Maintenance #1 — YYYY-MM-DD
Maintenance status: all good
Checks passed: 7/7

Maintenance #2 — YYYY-MM-DD
Maintenance status: 1 resolved, 0 failing
Fixed since last maintenance: Python syntax
```

Checks cover Python source syntax, Python tests, both dashboard scripts, Worker and bridge JavaScript syntax, and GitHub Actions workflow YAML. A passing check that failed in the previous report is marked *fixed since last maintenance*. This reports a verified recovery; it does **not** imply that automation repaired any code. New and continuing failures are recorded, and a failing maintenance run is marked unsuccessful **after** committing its report. Even repeated all-good runs get distinct numbered entries at the 50-day interval. Actual reports deliberately omit secrets and raw logs.

You can initiate a manual check in **Actions → Minecraft maintenance log → Run workflow**. It creates a new entry even before 50 days have elapsed. To allow the workflow to push its report, repository Actions settings must permit `GITHUB_TOKEN` with contents write access and must not block GitHub Actions bot commits. A scheduled workflow might be disabled by GitHub's 60-day public-repository inactivity rule; generating reports is not a guarantee that scheduled workflows or continuous Minecraft hosting will remain available.


## Native Windows desktop app

The repository now includes a lightweight, polished **Tauri Windows app** in [`desktop/`](desktop/README.md), with a macOS-inspired interface, secure Windows Credential Manager integration, and direct GitHub API access. It can inspect workflow runs, manually dispatch workflows, cancel **non-Minecraft** Actions runs, edit repository text files, and download world backups without Cloudflare.

Live Paper console, player telemetry and **safe** Save & Stop / Save & Restart remain available when the optional Cloudflare live bridge is healthy. The app deliberately refuses to force-cancel the Minecraft runner, which would bypass the verified backup sequence.

An automatic Windows NSIS installer workflow is available at [Build Minecraft Cloud Windows installer](https://github.com/majoodsaod-spec/minecraft-cloud-control/actions/workflows/build-windows.yml). Download the `Minecraft-Cloud-Windows-Installer` build artifact from a successful run, unzip it and run the `*-setup.exe` installer. See [the desktop guide](desktop/README.md) for requirements, token permissions, security and local build details.
