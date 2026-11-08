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
  assert.match(rust,/matches!\(status\.as_str\(\),"connected"\|"connecting"\|"idle"\|"disconnected"\)/);
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
