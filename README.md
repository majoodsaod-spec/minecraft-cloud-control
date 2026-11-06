# Minecraft Cloud Control

A lightweight, mobile-friendly Minecraft server management dashboard built as a zero-dependency static site.

## Cloudflare Pages deployment

Connect this GitHub repository to **Cloudflare Pages** and use:

- Framework preset: **None**
- Production branch: **main**
- Build command: **leave empty**
- Build output directory: **/** (repository root)

Cloudflare Pages publishes the root `index.html` file. Each new commit to `main` should automatically trigger a deployment if Git integration is enabled.

## Currently implemented

- Responsive dark navigation and overview
- Searchable editable configuration schema
- Boolean toggle switches, number inputs, dropdowns
- Browser-local draft persistence via `localStorage`
- Downloadable `server.properties` and JSON draft
- Local-only plugin JAR selection / staging
- UI previews for files, players, world backups, console, and integration status

## Not yet connected

- Real Minecraft hosting
- Server Start / Stop / Restart
- Remote file upload or plugin installation
- Live status, console commands and player lists
- Google Drive OAuth, backups, restores or synchronization
- Playit tunnel agent

The UI deliberately does **not** claim to perform remote operations until a secure, supported backend is available.

## Security notes

Never put GitHub access tokens, Google refresh tokens, Playit secrets, or any server credentials in `index.html` or other browser-visible files. Implement authentication and remote mutations only through a protected backend. Plugin JARs are executable code and should be treated as untrusted.

## Minecraft-specific notes

The "Allow headless pistons" setting is a **Paper-version-specific placeholder** and is intentionally excluded from the generic `server.properties` export. The backend must supply the correct Paper YAML schema for the installed version.

## Hosting note

GitHub-hosted Actions runners are designed for software CI and related workflows, not for ongoing personal Minecraft gameplay hosting. A separate game-hosting-compatible compute service will be required for the full panel.
