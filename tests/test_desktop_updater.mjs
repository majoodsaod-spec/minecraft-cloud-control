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
