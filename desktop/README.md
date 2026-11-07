# Minecraft Cloud — Windows desktop application

A lightweight, native Windows 10/11 control center for
[`majoodsaod-spec/minecraft-cloud-control`](https://github.com/majoodsaod-spec/minecraft-cloud-control).

Built using **Tauri 2**, the **Windows WebView2 runtime**, Rust, and plain HTML/CSS/JavaScript.
No React, Chromium bundle, Electron, remote fonts, analytics, or extra desktop server.

## Download the installer

Open **[GitHub Actions → Build Minecraft Cloud Windows installer](https://github.com/majoodsaod-spec/minecraft-cloud-control/actions/workflows/build-windows.yml)**.

1. Open a successful build run, or choose **Run workflow** if you want a fresh installer.
2. Under **Artifacts**, download **Minecraft-Cloud-Windows-Installer**.
3. Extract the ZIP and launch the `*-setup.exe` installer.
4. Windows SmartScreen may warn because the executable is **not code-signed**. Check that the installer comes from your own repository and the expected GitHub run.

Every change to `desktop/**` builds a Windows NSIS setup executable automatically. The workflow also supports manual builds. Artifacts expire after 30 days; you can rerun the build to get a fresh installer.

## Getting started

1. Open the installed **Minecraft Cloud** app.
2. Select **Connections**.
3. Create a GitHub fine-grained PAT scoped only to this repository with **Actions: read/write** and **Contents: read/write**, and paste it into **Connect GitHub**.
4. Your token is stored using **Windows Credential Manager**; it is never written to the GitHub repository or browser localStorage.
5. **Optional:** supply your existing Cloudflare Worker URL and dashboard admin password to enable live Paper console, player telemetry and safe restart when the bridge is online.

The app's GitHub functions work **without Cloudflare**:
- Start a Minecraft Actions workflow if a server run isn't already active.
- View all GitHub Actions workflows and runs, inspect jobs and step results.
- Cancel ordinary non-Minecraft Actions runs.
- Edit and commit repository files (changes apply on the next Minecraft session).
- Browse and download world backup artifacts to the Windows Downloads folder.

### Why can't I cancel the Minecraft server's GitHub run?

GitHub's cancel API kills the server's runner without giving Paper an opportunity to save and upload its verified world backup. The desktop app **explicitly blocks** such cancellation. **Safe Save & Stop** and **Safe Restart** send authenticated live commands through the existing Cloudflare bridge while it is functioning. When the bridge is unavailable, the controls remain protected rather than risking lost world progress.

### App technology and reliability

- Frontend: ~23 KB of vanilla JavaScript plus a small stylesheet; no JS framework or npm dependency.
- Native shell: Tauri 2/Windows WebView2 with standard NSIS per-user setup.
- Backend: Rust with API calls directly to `api.github.com`; credentials use Windows' native secure store.
- Security: Cloudflare connection is optional; no game-server keys are embedded in builds. A GitHub PAT is entered only **after installation**, on your own PC.
- Build: free GitHub Actions Windows runner on a public repository; there is no guarantee of build success until the workflow finishes.
- Live operations still need the currently deployed Worker/agent; a desktop window by itself is not a direct network tunnel into a temporary GitHub Actions runner.
- Installers are not digitally signed, so Windows may display its standard untrusted-publisher prompt.

## Build locally

Install Rust, the Windows C++ Build Tools, WebView2, and the Tauri CLI:

```powershell
cargo install tauri-cli --version "^2" --locked
python -m pip install Pillow==11.3.0
python desktop/scripts/make_icon.py
cd desktop
cargo tauri build --bundles nsis
```

The resulting installer is in `desktop/src-tauri/target/release/bundle/nsis/`.

## Security caveats

Never post PATs or dashboard passwords in GitHub Issues, Actions logs, chat, or screenshots. Revoke any leaked PAT immediately. Keep the app installed only on trusted Windows accounts. Direct GitHub access does not remove GitHub Actions run-time or hosting limitations.

## GitHub connected, but no live Paper updates?

**GitHub authentication and Minecraft's live bridge are separate.** The desktop app can read workflows, start runs, inspect jobs, edit repository files and download backups directly via GitHub. GitHub's REST API does **not** give it the Minecraft process's current player list, memory, console command channel or server heartbeat.

The Overview now distinguishes a **failed server run**, an **active GitHub runner (Paper unverified)**, and a **verified live Paper heartbeat** instead of confusing a missing live bridge with a missing GitHub connection. When Cloudflare is unavailable, open **Live Console → Load GitHub logs** for a **read-only, potentially delayed** snapshot of the current/last GitHub Actions job. GitHub may not expose an in-progress job's logs until later. This fallback cannot send Minecraft console commands or verify server uptime.

For actual live status and command execution, configure your existing Cloudflare Worker URL and dashboard admin password in **Connections** and ensure its Minecraft bridge is healthy. Connecting GitHub alone cannot replace this server-side relay.

If you see **Latest server run failed**, open **GitHub Actions → Details → job logs** to diagnose the crash before starting another session. Do not force-cancel a live Minecraft job to refresh status.

To get changes to the desktop application, download and install an updated successful Windows installer build from the [Windows installer workflow](https://github.com/majoodsaod-spec/minecraft-cloud-control/actions/workflows/build-windows.yml).

## Quick Update — upgrade the app without manually reinstalling

Starting with the first installer built after this change, Minecraft Cloud includes a **Quick Update** button in its top bar and in **Connections → Windows app updates**. It uses your already-connected GitHub account directly; Cloudflare is not involved.

1. Open Minecraft Cloud and connect GitHub.
2. Click **Quick Update**. A small indicator appears when a newer successful Windows installer build is available.
3. Confirm **Install update**. The app downloads the latest artifact from your repository, extracts the verified build's NSIS setup executable into a temporary directory, launches it, and closes itself so Windows can replace the existing app.
4. Follow the Windows installer prompts. Open Minecraft Cloud again normally; your Windows-stored credentials stay available.

The current app version **does not yet contain this button**, so **one manual installer download** is necessary to get the updater. After installing that build, future upgrades can start inside the app.

**What this is and isn't:** This is an *in-place, one-click installer upgrade*, not differential patching. GitHub Actions still builds the installer; the app downloads the complete installer automatically but does **not** require you to browse Artifacts, extract ZIPs, or install an unrelated second copy. Builds get a monotonically increasing `0.1.<GitHub workflow run number>` app version and a compiled-in GitHub Actions run ID so the updater can distinguish your installed build from a newer one. It only considers successful builds on the repository's `main` branch with the expected artifact name, verifies the expected single setup executable inside the archive, and never accepts arbitrary executable URLs from the UI.

**Security:** GitHub artifact installers are not currently code-signed; Windows may show a SmartScreen prompt. Only update from your own repository and trusted successful workflow runs. The process leaves Minecraft workflows and world backups untouched. Expired/missing build artifacts cannot be installed by Quick Update.

### Active GitHub run, but blank player statistics

A GitHub Actions workflow marked `in_progress` means only that its workflow is active; **it does not confirm that Paper started**. When the Cloudflare live bridge is down or has not been configured in the desktop app, Paper player counts, memory, idle time and actual server uptime are unavailable. They must not be estimated from GitHub workflow state.

The Overview now displays **GitHub workflow status, run number, and approximate elapsed time separately** from Paper metrics. Use **View Minecraft logs** for a direct GitHub read-only job-log snapshot when available.

To enable actual live metrics, open **Connections** and enter the prefilled Minecraft Cloud Worker URL and your **Cloudflare dashboard admin password** (the GitHub personal access token is not this password), then select **Save and test live connection**. A Cloudflare Durable Object quota outage or a broken bridge still needs repairing separately; no Windows UI change can invent the missing telemetry. You do **not** need to change the Minecraft server's Playit address.
