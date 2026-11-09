import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const manager=read("desktop/ui/server_management.js");
const queue=read("desktop/ui/change_queue.js");
const rust=read("desktop/src-tauri/src/server_files.rs");
const lib=read("desktop/src-tauri/src/lib.rs");
const html=read("desktop/ui/index.html");
const paper=read("server/continuous_paper.py");
const operations=read("server/pending_operations.py");
const edits=read("server/pending_files.py");

test("Phase 2 explorer creates, renames and deletes through queued native commands",()=>{
  assert.doesNotThrow(()=>new Function(manager));
  assert.match(manager,/async function stageFolder\(\)/);
  assert.match(manager,/async function stageNewFile\(\)/);
  assert.match(manager,/async function stageRename\(\)/);
  assert.match(manager,/async function stageDelete\(\)/);
  assert.match(manager,/async function uploadTextFiles\(files\)/);
  assert.match(manager,/server_operations_add/);
  assert.match(manager,/server_files_stage/);
  assert.match(manager,/file\.size>131072/);
  assert.match(manager,/data-srv-action="rename-file"/);
  assert.match(manager,/data-srv-action="delete-file"/);
  assert.match(manager,/id="server-file-search"/);
  assert.match(manager,/window\.ChangeQueue\?\.show/);
});

test("Unified queue displays text, file operations, plugin installs and applied receipts",()=>{
  assert.doesNotThrow(()=>new Function(queue));
  assert.match(html,/src="\.\/change_queue\.js"/);
  assert.match(manager,/id="server-change-queue"/);
  assert.match(queue,/server_change_queue/);
  assert.match(queue,/server_change_receipts/);
  assert.match(queue,/modrinth_queue_remove/);
  assert.match(queue,/server_operations_remove/);
  assert.match(queue,/server_files_unstage/);
  assert.match(queue,/proof\.operations/);
  assert.match(queue,/proof\.edits/);
  assert.match(queue,/proof\.installed/);
  assert.match(queue,/Status unverified/);
  assert.match(queue,/Applied to saved world/);
});

test("Rust validates operation paths and never mutates a verified backup directly",()=>{
  assert.match(rust,/fn validate_queued_operation\(/);
  assert.match(rust,/fn safe_operation_directory\(/);
  assert.match(rust,/async fn server_operations_add\(/);
  assert.match(rust,/async fn server_operations_remove\(/);
  assert.match(rust,/async fn server_change_queue\(/);
  assert.match(rust,/async fn server_change_receipts\(/);
  assert.match(rust,/server_files_stage\([\s\S]*?Discard the queued rename\/delete/);
  assert.match(rust,/fn backup_queue_receipts\(/);
  assert.match(rust,/verified_backup\(\)/);
  assert.match(lib,/server_change_queue,server_change_receipts/);
});

test("GitHub Paper runner applies idempotent safe operations after verified restore",()=>{
  assert.match(paper,/apply_pending_operations\(DATA/);
  assert.match(paper,/apply_pending\(DATA/);
  assert.ok(paper.indexOf("apply_pending_operations(DATA")<paper.indexOf("apply_pending(DATA"));
  assert.ok(paper.indexOf("restore_snapshot()")<paper.indexOf("apply_pending_operations(DATA"));
  assert.match(operations,/RECEIPT = "\.cloud-applied-ops\.json"/);
  assert.match(operations,/def validate_operation/);
  assert.match(operations,/def _verified_destination/);
  assert.match(operations,/if current\.is_symlink\(\)/);
  assert.match(operations,/if receipts\.get\(item\["id"\]\) == receipt_key/);
  assert.match(operations,/target\.exists\(\)/);
  assert.match(edits,/\.cloud-applied-edits\.json/);
});
