/* Phase 2: one place to review queued edits, safe file operations, and
   Modrinth installs. GitHub manifests contain only instructions; a verified
   runner snapshot or authenticated live Paper tells us what was applied. */
(function(){
"use strict";
const invoke=(command,args={})=>window.__TAURI__.core.invoke(command,args);
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const state={items:[],receipts:null,loading:false,loaded:false,error:"",
              lastLive:null,lastRunning:null,activeRequest:0};
function statusFor(item){
  const proof=state.receipts;
  if(!proof)return {label:"Status unverified",kind:"unknown"};
  if(item.kind==="edit"&&proof.edits?.[item.path]===item.hash)
    return {label:"Applied to saved world",kind:"applied"};
  if(["mkdir","delete","rename"].includes(item.kind)&&
     typeof proof.operations?.[item.id]==="string")
    return {label:"Applied to saved world",kind:"applied"};
  if(["plugin","datapack"].includes(item.kind)&&
     proof.installed?.[item.id]?.versionId===item.versionId)
    return {label:"Installed",kind:"applied"};
  return {label:"Pending next startup",kind:"pending"};
}
function title(item){
  if(item.kind==="edit")return "Edit · "+item.path;
  if(item.kind==="mkdir")return "New folder · "+item.path;
  if(item.kind==="rename")return "Rename · "+item.path+" → "+item.target;
  if(item.kind==="delete")return "Delete file · "+item.path;
  if(item.kind==="plugin")return "Plugin · "+(item.title||item.id);
  if(item.kind==="datapack")return "Datapack · "+(item.title||item.id);
  return "Pending change";
}
function render(){
  const area=document.querySelector("#server-change-queue");
  if(!area)return;
  const items=state.items;
  const failed=state.error?'<div class="server-manager-message error">'+esc(state.error)+'</div>':"";
  area.innerHTML='<div class="server-queue-header"><div><h2>Queued changes</h2>'+
    '<p>Changes apply on a future Paper startup. The current world backup is never edited in place.</p></div>'+
    '<button type="button" class="btn small" data-queue-action="refresh" '+
    (state.loading?"disabled":"")+' aria-label="Refresh change queue">Refresh queue</button></div>'+
    failed+(state.loading&&!state.loaded?
      '<div class="server-manager-placeholder">Loading the change queue…</div>':
      !items.length?
      '<div class="server-manager-placeholder">No queued file, plugin, or datapack changes.</div>':
      '<div class="server-queue-items">'+items.map((item,i)=>{
        const status=statusFor(item);
        const canRemove=["edit","mkdir","delete","rename","plugin","datapack"].includes(item.kind);
        return '<div class="server-queue-item">'+
          '<span class="server-queue-number">'+String(i+1)+'</span>'+
          '<div class="server-queue-description"><strong>'+esc(title(item))+'</strong>'+
          '<small class="server-queue-status '+status.kind+'">'+esc(status.label)+'</small></div>'+
          (canRemove?'<button type="button" class="server-queue-remove" data-queue-action="remove" data-kind="'+esc(item.kind)+
          '" data-id="'+esc(item.id)+'" title="Remove this queued change" aria-label="Remove '+esc(title(item))+'">×</button>':"")+
          '</div>';
      }).join("")+'</div>')+
      '<p class="field-tip">Applied status is verified using receipts stored with the live server or latest backup. Removing a queue item does not reverse a change already applied.</p>';
}
async function reload(){
  const ticket=++state.activeRequest;
  if(state.loading)return;
  state.loading=true;state.error="";
  render();
  try{
    const queue=await invoke("server_change_queue");
    if(ticket!==state.activeRequest)return;
    state.items=Array.isArray(queue.items)?queue.items:[];
    state.loaded=true;
    state.receipts=null;
    render();
    try{
      const proof=await invoke("server_change_receipts",{
        live:Boolean(state.lastLive),running:Boolean(state.lastRunning)
      });
      if(ticket===state.activeRequest)state.receipts=proof;
    }catch(error){
      if(ticket===state.activeRequest)state.error="Applied status unavailable: "+String(error).slice(0,160);
    }
  }catch(error){
    if(ticket===state.activeRequest)state.error="Cannot retrieve the change queue: "+String(error).slice(0,160);
  }finally{
    if(ticket===state.activeRequest){state.loading=false;render();}
  }
}
function show(live,running){
  const changed=state.lastLive!==Boolean(live)||state.lastRunning!==Boolean(running);
  state.lastLive=Boolean(live);state.lastRunning=Boolean(running);
  render();
  if((!state.loaded||changed)&&!state.loading)reload();
}
async function remove(kind,id){
  const item=state.items.find(i=>i.kind===kind&&String(i.id)===String(id));
  if(!item)return;
  if(!window.confirm("Remove this queued change?\n\n"+title(item)+"\n\nChanges already applied to the server will not be reversed."))return;
  try{
    if(kind==="edit")await invoke("server_files_unstage",{path:item.path});
    else if(kind==="plugin"||kind==="datapack")
      await invoke("modrinth_queue_remove",{projectId:id});
    else await invoke("server_operations_remove",{id});
    state.loaded=false;
    await reload();
    window.ServerManager?.refreshPending?.();
  }catch(error){
    state.error="Could not remove queued change: "+String(error).slice(0,200);render();
  }
}
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-queue-action]");
  if(!button)return;
  event.preventDefault();
  if(button.dataset.queueAction==="refresh")reload();
  if(button.dataset.queueAction==="remove")remove(button.dataset.kind,button.dataset.id);
});
window.ChangeQueue={show,reload,render};
})();
