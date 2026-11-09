import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const ui=read("desktop/ui/app.js");
const html=read("desktop/ui/index.html");
const rust=read("desktop/src-tauri/src/lib.rs");
const build=read("desktop/src-tauri/build.rs");
const workflow=read(".github/workflows/build-windows.yml");
const config=JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
const market=read("desktop/ui/marketplace.js");
const marketStyle=read("desktop/ui/marketplace.css");
const manager=read("desktop/ui/server_management.js");
const managerCss=read("desktop/ui/server_management.css");
const serverRust=read("desktop/src-tauri/src/server_files.rs");

test("Quick Update gives immediate visible feedback and installs in one interaction",()=>{
  assert.match(ui,/case "check-update":return quickUpdate\(\)/);
  assert.match(ui,/updateMessage\("Checking GitHub for the newest Windows installer/);
  assert.match(ui,/desktop-update-progress/);
  assert.match(ui,/stage==="downloading"/);
  assert.match(ui,/state\.updateChecking/);
  assert.match(html,/id="updateStatus"[^>]*role="status"|id="updateStatus"[^>]*aria-live=/);
  assert.match(rust,/app\.emit\("desktop-update-progress"/);
});

test("Quick Update is wired to the native backend and visible in the toolbar",()=>{
  assert.doesNotThrow(()=>new Function(ui));
  assert.match(html,/id="quickUpdate"[^>]+data-action="check-update"/);
  assert.match(ui,/case "check-update":/);
  assert.match(ui,/desktop_check_update/);
  assert.match(ui,/desktop_install_update/);
  assert.match(rust,/desktop_check_update,desktop_install_update/);
});

test("GitHub updater only accepts newer successful main builds",()=>{
  assert.match(rust,/branch=main&status=success/);
  assert.match(rust,/run\["status"\]\.as_str\(\)!=Some\("completed"\)/);
  assert.match(rust,/run\["conclusion"\]\.as_str\(\)!=Some\("success"\)/);
  assert.match(rust,/run_id>installed_build\(\)/);
  assert.match(rust,/update.latest_build!=expected_build/);
  assert.match(rust,/path.components\(\).count\(\)!=1/);
  assert.match(rust,/!basename.ends_with\("-setup.exe"\)/);
  assert.match(rust,/DOWNLOAD_LIMIT/);
});

test("native build IDs and app versions advance with GitHub installer runs",()=>{
  assert.match(workflow,/MC_DESKTOP_BUILD_RUN_ID:\s*\$\{\{ github\.run_id \}\}/);
  assert.match(workflow,/config\.version = "0\.1\.\$\{\{ github\.run_number \}\}"/);
  assert.match(build,/cargo:rerun-if-env-changed=MC_DESKTOP_BUILD_RUN_ID/);
  assert.equal(config.identifier,"com.minecraftcloud.desktop");
  assert.equal(config.bundle.targets[0],"nsis");
});

test("opt-in NetBird lifecycle never disconnects an existing user VPN session",()=>{
  assert.match(rust,/const AUTO_NETBIRD:/);
  assert.match(rust,/if netbird_is_connected\(&report\) \{return Ok\(false\);\}/);
  assert.match(rust,/if !was_owned \{return;\}/);
  assert.match(rust,/netbird_cli\(&exe,"down"\)/);
  assert.match(rust,/tauri::RunEvent::Exit/);
  assert.match(rust,/netbird_auto_status,netbird_set_auto/);
  assert.match(ui,/id="netbirdAuto"/);
});

test("NetBird background CLI never flashes Windows terminal windows",()=>{
  assert.match(rust,/fn hide_netbird_console/);
  assert.match(rust,/creation_flags\(0x0800_0000\)/);
  assert.match(rust,/hide_netbird_console\(std::process::Command::new\(&path\)\.arg\("version"\)\)/);
  assert.match(rust,/hide_netbird_console\(std::process::Command::new\(exe\)\.args\(args\)\)/);
  assert.match(rust,/fn find_netbird_peer\(\)[\s\S]*?netbird_cli_args\(&binary,\&\["status","--table"\]\)/);
  assert.match(rust,/starts_with\("connected"\)/);
});
test("background polling preserves unsaved user input and secret fields",()=>{
  assert.match(ui,/draftFields=new Set/);
  assert.match(ui,/restoreDrafts\(\)/);
  assert.match(ui,/document\.addEventListener\("input"/);
  assert.match(ui,/if\(!editing\(\)\)render\(\)/);
  assert.match(ui,/includes\(state\.page\)\&\&!editing\(\)/);
  for(const id of ["directToken","directPeer","cloudPass","filecontent","commandText"]){
    assert.ok(ui.includes('"'+id+'"'),"Draft field not protected: "+id);
  }
});

test("Direct Paper accepts 8-character secrets in both Rust and Windows UI",()=>{
  assert.match(rust,/if token\.len\(\)<8/);
  assert.match(rust,/if trimmed\.len\(\)<8 \|\| trimmed\.len\(\)>512/);
  assert.match(ui,/if\(token\.length<8\)/);
  assert.doesNotMatch(rust,/Direct control token must be at least 24 characters/);
  assert.doesNotMatch(ui,/token\.length<24/);
});

test("NetBird lazy peers are dialed even before a handshake exists",()=>{
  assert.match(rust,/matches!\(status\.as_str\(\),"connected"\|"connecting"\|"idle"\)/);
  assert.match(rust,/async fn active_paper_run\(\)/);
  assert.match(rust,/fn find_active_netbird_peer\(run_id:u64\)/);
  assert.match(rust,/fn discovers_runner_from_netbird_table_and_details/);
  assert.match(rust,/Status: Idle/);
  assert.match(rust,/from_secs\(12\)/);
});
test("NetBird auto-connection is refreshed and does not pile up status probes",()=>{
  assert.match(ui,/loadDirect\(true\),loadNetbirdAuto\(\)/);
  assert.match(ui,/pendingDirectStatus/);
  assert.match(ui,/if\(pendingDirectStatus\)return pendingDirectStatus/);
});

test("Direct Paper freshness uses local request time, not unsynchronized server clocks",()=>{
  assert.match(ui,/directFetchedAt:0/);
  assert.match(ui,/state\.directFetchedAt=Date\.now\(\)/);
  assert.match(ui,/Date\.now\(\)-state\.directFetchedAt<15000/);
  assert.doesNotMatch(ui,/Date\.now\(\)-\(d\.updatedAt\|\|0\)<15000/);
});


test("NetBird discovers peers from the documented structured JSON status",()=>{
  assert.match(rust,/fn parse_peer_json\(report: &str\)/);
  assert.match(rust,/get\("peers"\)\?\.get\("details"\)/);
  assert.match(rust,/get\("fqdn"\)/);
  assert.match(rust,/get\("netbirdIp"\)/);
  assert.match(rust,/get\("status"\)/);
  assert.match(rust,/netbird_cli_args\(&binary,&\["status","--json"\]\)/);
});
test("NetBird connection ownership persists while the daemon completes startup",()=>{
  assert.match(rust,/state\.connected_by_app=true;\s*for _ in 0\.\.12/);
  assert.match(rust,/let mut state=ownership\.lock\(\)/);
  assert.match(rust,/fn disconnect_owned_netbird/);
});

test("Modrinth discovery loads popular projects and offers real browsing controls",()=>{
  assert.doesNotThrow(()=>new Function(market));
  assert.match(html,/marketplace\.js/);
  assert.match(html,/marketplace\.css/);
  assert.match(ui,/McMarketplace\.ensureLoaded\(\)/);
  assert.match(market,/sort:\s*"downloads"/);
  assert.match(market,/version:\s*"26\.3"/);
  assert.match(market,/data-market-action="category"/);
  assert.match(market,/data-market-action="loader"/);
  assert.match(market,/data-market-action="previous"/);
  assert.match(market,/data-market-action="next"/);
  assert.match(market,/icon_url/);
  assert.match(market,/date_modified/);
  assert.match(market,/state\.hits\.map\(card\)/);
  assert.match(rust,/const CATEGORIES:/);
  assert.match(rust,/const SORTS:/);
  assert.match(rust,/offset: u32/);
  assert.match(marketStyle,/\.mc-discover-layout/);
  assert.match(config.app.security.csp,/https:\/\/cdn\.modrinth\.com/);
});

test("Marketplace still installs verified files onto the live Paper server",()=>{
  assert.match(market,/invoke\("modrinth_versions"/);
  assert.match(market,/invoke\("direct_command"/);
  assert.match(market,/kind: "marketplace-install"/);
  assert.match(ui,/case "market-restart"/);
  assert.match(market,/state\.version !== "26\.3"/);
});

test("a stored NetBird manual override is visible and can be cleared without re-entering secrets",()=>{
  assert.match(rust,/fn direct_peer_config\(\)/);
  assert.match(rust,/fn direct_clear_peer\(\)/);
  assert.match(rust,/remove_secret\(DIRECT_PEER\)\?/);
  assert.match(rust,/direct_configure,direct_peer_config,direct_clear_peer/);
  assert.match(ui,/case "clear-direct-peer":/);
  assert.match(ui,/data-action="clear-direct-peer"/);
  assert.match(ui,/state\.directPeerConfig\.peerIp/);
  assert.match(ui,/await loadDirectPeerConfig\(\)/);
});

test("Uptime stays monotonic and does not reset when NetBird SSE reconnects",()=>{
  assert.match(ui,/const liveClock=\{/);
  assert.match(ui,/function observeLiveClock\(/);
  assert.match(ui,/liveClock\.uptimeBase=Math\.max\(/);
  assert.match(ui,/observeLiveClock\(next,state\.directFetchedAt\)/);
  assert.match(ui,/if\(!directOnline\(\)\)/);
  assert.match(ui,/observeLiveClock\(state\.cloud\?\.bridge\?\.status,state\.cloudFetchedAt\)/);
  assert.match(ui,/recordMetric\(next\)/);
  assert.match(ui,/Keep the existing/);
});
test("Resource history rejects missing metrics instead of inventing CPU or disk pressure",()=>{
  assert.match(ui,/snapshot\.cpuPercent==null\|\|snapshot\.memoryMiB==null/);
  assert.match(ui,/snapshot\.diskFreeMiB==null\?NaN/);
  assert.match(ui,/state\.metricHistory\.length>120/);
  assert.match(ui,/state\.metricSession!==snapshot\.session/);
});
test("Automations page exposes safe opt-in weekly maintenance settings",()=>{
  const automation=readFileSync(new URL("../desktop/ui/automation.js",import.meta.url),"utf8");
  assert.doesNotThrow(()=>new Function(automation));
  assert.match(html,/data-page="automation"/);
  assert.match(html,/automation\.js/);
  assert.match(ui,/automation:drawAutomation/);
  assert.match(automation,/github_file/);
  assert.match(automation,/github_save_file/);
  assert.match(automation,/automation-enabled/);
  assert.match(automation,/weekly_maintenance/);
  assert.match(automation,/window\.confirm/);
  assert.match(automation,/state\.attempted/);
});
test("Automatic NetBird discovery verifies the control API rather than trusting a stale peer name",()=>{
  assert.match(rust,/async fn selected_direct_peer_ip\(\)/);
  assert.match(rust,/static VERIFIED_PEER:/);
  assert.match(rust,/netbird_cli_args\(&binary,&\["status","--json"\]\)/);
  assert.match(rust,/api\/status/);
  assert.match(rust,/\.bearer_auth\(&token\)/);
  assert.match(rust,/response\.status\(\)\.is_success\(\)/);
  assert.match(rust,/cache\.lock\(\)\.await=Some/);
});

test("desktop interface uses consistent administrative labels without promotional slogans",()=>{
  assert.doesNotMatch(html,/Thoughtfully built for your world|class="spark"|class="profile"/i);
  assert.doesNotMatch(ui,/beautifully managed|WELCOME BACK|YOUR MINECRAFT WORLD|in one calm place/i);
  assert.doesNotMatch(market,/Discover server content|Browse, explore and install|Powered by Modrinth/i);
  assert.match(ui,/header\("SERVER","Overview"/);
  assert.match(market,/Plugins & Datapacks/);
  assert.match(marketStyle,/--market-surface:#fff/);
  assert.match(marketStyle,/\.mc-discover-card/);
  assert.match(html,/marketplace\.css/);
});

test("Server Files replaces the repository filename editor and uses verified backup or live filesystem",()=>{
  assert.doesNotThrow(()=>new Function(manager));
  assert.match(html,/data-page="files"[^>]*>.*Server Files/);
  assert.match(html,/data-page="settings"[^>]*>.*Server Settings/);
  assert.match(html,/server_management\.js/);
  assert.match(html,/server_management\.css/);
  assert.match(ui,/window\.ServerManager\.renderFiles\(directOnline\(\),serverRunning\(\)\)/);
  assert.match(ui,/window\.ServerManager\.renderSettings\(\)/);
  assert.doesNotMatch(ui,/data-action="load-file"|data-action="save-file"/);
  assert.match(serverRust,/async fn verified_backup\(/);
  assert.match(serverRust,/hasher\.finalize\(\)/);
  assert.match(serverRust,/server_files_list\(path:String,live:bool\)/);
  assert.match(serverRust,/server_files_stage\(path:String,content:String\)/);
  assert.match(managerCss,/\.server-manager-layout/);
});
test("Server Settings supports typed numbers and switches with queued restart semantics",()=>{
  assert.match(manager,/type="checkbox"/);
  assert.match(manager,/typeOf\(key\)==="number"/);
  assert.match(manager,/online-mode/);
  assert.match(manager,/server_settings_save/);
  assert.match(serverRust,/async fn server_settings_save\(/);
  assert.match(serverRust,/Online mode must remain enabled/);
  assert.match(manager,/next server startup/);
});
test("power buttons reflect server state and restore button confirms world backup",()=>{
  assert.match(ui,/serverRunning\(\)/);
  assert.match(ui,/case "restore-backup":/);
  assert.match(ui,/data-action="restore-backup"/);
  assert.match(ui,/await dialog\("Restore world backup\?"/);
  assert.match(rust,/async fn server_restore_backup\(/);
  assert.match(rust,/dashboard_power_action\("stop",None\)/);
  assert.match(rust,/dashboard_power_action\("restore",Some\(run_id\)\)/);
});
test("Modrinth content queues offline and downloads only on the server",()=>{
  assert.match(market,/modrinth_queue_add/);
  assert.match(market,/modrinth_queue_remove/);
  assert.match(market,/Pending next server start/);
  assert.match(market,/Queue install/);
  assert.match(serverRust,/async fn modrinth_queue_add\(/);
  assert.match(serverRust,/async fn modrinth_queue_remove\(/);
  assert.match(serverRust,/async fn modrinth_queue_list\(/);
  assert.match(rust,/modrinth_queue_list,modrinth_queue_add,modrinth_queue_remove/);
});

test("World inventory is private, bounded and does not retry endlessly after errors",()=>{
  assert.match(ui,/async function loadWorlds\(force=false\)/);
  assert.match(ui,/kind:"worlds-list"/);
  assert.match(ui,/worldRows/);
  assert.match(ui,/worldPanel/);
  assert.match(ui,/state\.worldsSession=session;/);
  assert.match(ui,/case "refresh-worlds"/);
});
test("Offline backup viewer streams unbounded snapshot archives to disk",()=>{
  assert.doesNotMatch(serverRust,/BACKUP_LIMIT|240 MiB viewer limit/);
  assert.match(serverRust,/std::env::temp_dir\(\)/);
  assert.match(serverRust,/tokio::fs::File::create\(&artifact_path\)/);
  assert.match(serverRust,/backup\.read\(&mut buffer\)/);
  assert.match(serverRust,/hasher\.update\(&buffer\[\.\.read\]\)/);
  assert.match(serverRust,/Backup SHA-256 mismatch/);
  assert.match(serverRust,/fn cleanup_backup_cache\(\)/);
  assert.match(rust,/cleanup_backup_cache\(\)/);
});

test("Lifecycle operations show real stages and suppress stale uptime and empty time",()=>{
  assert.match(html,/id="serverOperation"/);
  assert.match(ui,/function syncServerOperation\(/);
  assert.match(ui,/lifecycleStages/);
  assert.match(ui,/function clockDisplay\(field\)/);
  assert.match(ui,/if\(lifecycleActive\(\)\|\|!connectedLive\(\)/);
  assert.match(ui,/stat\("Server uptime",clockDisplay\("uptime"\)/);
  assert.match(ui,/stat\("Empty time",clockDisplay\("emptyFor"\)/);
  assert.match(ui,/beginOperation\("restarting"\)/);
  assert.match(ui,/beginOperation\("restoring"\)/);
});
test("Marketplace supports removing queued cards and installed version comparison",()=>{
  assert.match(market,/data-market-action="unqueue"/);
  assert.match(market,/mc-queue-remove/);
  assert.match(market,/modrinth_installed_inventory/);
  assert.match(market,/record\.versionId===latest\.id/);
  assert.match(market,/Queue update/);
  assert.match(market,/Version unavailable/);
  assert.match(serverRust,/async fn modrinth_installed_inventory\(live:bool\)/);
  assert.match(rust,/modrinth_installed_inventory/);
});


test("Phase 1 reliability surfaces measured timings and safe recovery warnings",()=>{
  assert.match(ui,/function startupDiagnostics\(\)/);
  assert.match(ui,/function recoveryWarning\(\)/);
  assert.match(ui,/startupTimings/);
  assert.match(ui,/Recovery needs review/);
  assert.match(ui,/verified backup/i);
  assert.match(ui,/Last direct heartbeat/);
  assert.match(ui,/NetBird live stream/);
});
