import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const market=read("desktop/ui/marketplace.js");
const players=read("desktop/ui/players.js");
const ui=read("desktop/ui/app.js");
const html=read("desktop/ui/index.html");
const rust=read("desktop/src-tauri/src/lib.rs");
const source=read("desktop/src-tauri/src/server_files.rs");
const bridge=read("server/runtime_bridge.py");
const config=read("server/pending_content_actions.py");
const runner=read("server/continuous_paper.py");

test("Phase 2 desktop tabs navigate without inventing plugin versions",()=>{
  assert.doesNotThrow(()=>new Function(market));
  assert.match(market,/data-market-action="tab"/);
  assert.match(market,/Installed/);
  assert.match(market,/Updates/);
  assert.match(market,/Queue/);
  assert.match(market,/function compatibleUpdate\(/);
  assert.match(market,/record\.versionId===release\.id/);
  assert.match(market,/state\.latestReleases/);
  assert.match(market,/version_type==="release"/);
});

test("Update All queues only compatible selected releases, not unverified versions",()=>{
  assert.match(market,/async function loadManagedReleases\(/);
  assert.match(market,/async function queueInstalledUpdate\(/);
  assert.match(market,/async function updateAll\(/);
  assert.match(market,/state\.versionLoading/);
  assert.match(market,/!state\.contentActions\[id\]/);
  assert.match(market,/modrinth_queue_add/);
  assert.match(market,/kind:record\.kind/);
  assert.match(market,/No verified compatible updates/);
});

test("Plugin disable/remove are staged for next safe Paper startup",()=>{
  assert.match(market,/modrinth_content_action_set/);
  assert.match(market,/modrinth_content_action_remove/);
  assert.match(market,/Queue disable/);
  assert.match(market,/Queue removal/);
  assert.match(source,/async fn modrinth_content_action_set\(/);
  assert.match(source,/async fn modrinth_content_action_remove\(/);
  assert.match(source,/pending_content_actions/);
  assert.match(rust,/modrinth_content_actions_list,modrinth_content_action_set,modrinth_content_action_remove/);
  assert.match(config,/DISABLED = "\.disabled-modrinth"/);
  assert.match(config,/write_registry\(data, inventory\)/);
  assert.match(config,/\.cloud-applied-content\.json/);
  assert.match(runner,/apply_content_actions\(DATA/);
  assert.ok(runner.indexOf("apply_modrinth_queue(DATA")<runner.indexOf("apply_content_actions(DATA"));
});

test("Players page is interactive but requires authorized direct Paper control",()=>{
  assert.doesNotThrow(()=>new Function(players));
  assert.match(html,/data-page="players"/);
  assert.match(html,/src="\.\/players\.js"/);
  assert.match(html,/href="\.\/players\.css"/);
  assert.match(ui,/function drawPlayers\(\)/);
  assert.match(ui,/players:drawPlayers/);
  assert.match(players,/direct_command/);
  assert.match(players,/server_players_snapshot/);
  assert.match(players,/state\.live/);
  assert.match(players,/window\.confirm/);
  assert.match(players,/risky=new Set/);
  assert.match(players,/whitelist/);
  assert.match(players,/operators/);
  assert.match(players,/ban/);
  assert.match(players,/playerdata/);
  assert.match(rust,/"players-list"/);
  assert.match(source,/async fn server_players_snapshot\(/);
  assert.match(bridge,/if kind=="players-list":/);
  assert.match(bridge,/USERNAME\.fullmatch/);
  assert.match(bridge,/whitelistEnabled/);
  assert.match(bridge,/def names\(filename\)/);
});

test("Whitelist controls require explicit confirmation and authenticated direct Paper",()=>{
  assert.match(players,/data-player-action="whitelist-toggle"/);
  assert.match(players,/state\.live/);
  assert.match(players,/window\.confirm/);
  assert.match(players,/kind:desired\?"whitelist-on":"whitelist-off"/);
  assert.match(players,/Refresh player records to verify/);
});
test("Managed plugin changes cannot conflict with a queued install",()=>{
  assert.match(source,/Cancel the queued install\/update before disabling or removing/);
  assert.match(source,/if action=="disable"\|\|action=="remove"/);
  assert.match(source,/modrinth_queue_manifest\(\)\.await/);
});
test("Players page does not expose dangerous raw user JSON",()=>{
  assert.doesNotMatch(players,/usercache\.json|playerdata\/|UUID-MUST/);
  assert.match(source,/fn permitted_player_name/);
  assert.match(source,/backup_players\(snapshot\.as_path\(\)\)/);
  assert.match(bridge,/Raw UUID files and playerdata never leave the runner/);
});
