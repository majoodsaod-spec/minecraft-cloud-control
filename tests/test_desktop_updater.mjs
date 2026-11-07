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
