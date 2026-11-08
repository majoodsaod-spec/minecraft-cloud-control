/* Server files and properties. Intentionally separate from the GitHub repo
   editor: server paths are resolved only through the validated Paper APIs. */
(function(){
"use strict";
const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const label=k=>k.replace(/-/g," ").replace(/\b[a-z]/g,c=>c.toUpperCase());
const typeOf=k=>({
  "max-players":"number","view-distance":"number","simulation-distance":"number",
  "spawn-protection":"number","player-idle-timeout":"number","max-world-size":"number",
  "server-port":"number","query.port":"number","rcon.port":"number",
  "max-tick-time":"number","network-compression-threshold":"number",
  "entity-broadcast-range-percentage":"number","function-permission-level":"number",
  "op-permission-level":"number","rate-limit":"number","spawn-radius":"number"
})[k]||"";
const categoryOf=k=>{
 if(/player|white-list|online-mode|enforce-whitelist|prevent-proxy|hide-online/.test(k))return "Players & Access";
 if(/distance|tick|simulation|entity|network|rate-limit|compression/.test(k))return "Performance";
 if(/world|seed|spawn|difficulty|gamemode|hardcore|flight|nether|pvp/.test(k))return "Gameplay";
 if(/rcon|query|server-ip|server-port|enable-status|motd/.test(k))return "Networking";
 return "Other";
};
const state={
 dir:"",listing:null,selected:null,pending:{},loading:false,error:"",
 fileSaving:false,settingData:null,settingLoading:false,settingError:"",
 settingSaving:false,settingSearch:"",lastLive:null,lastRunning:null,
 fileLoadKey:null,settingsLoaded:false,edited:false
};
const root=()=>document.querySelector("#server-files-root");
function note(text,error=false){
 const node=document.querySelector("#server-files-message");
 if(node){node.textContent=text;node.hidden=!text;node.classList.toggle("error",error);}
}
const count=n=>Number.isFinite(Number(n))?new Intl.NumberFormat().format(Number(n))+" B":"";
function paths(){
 const parts=state.dir.split("/").filter(Boolean);
 const rows=['<button type="button" data-srv-action="folder" data-path="">Server</button>'];
 parts.forEach((part,i)=>rows.push('<span>/</span><button type="button" data-srv-action="folder" data-path="'+esc(parts.slice(0,i+1).join("/"))+'">'+esc(part)+'</button>'));
 return rows.join("");
}
function fileActions(){
 if(!state.selected)return'<div class="server-manager-placeholder">Select a text file to preview it.</div>';
 const file=state.selected;
 const protectedFile=file.path==="server.properties";
 const editable=!protectedFile&&!file.unsupported;
 const staged=Object.prototype.hasOwnProperty.call(state.pending,file.path);
 return '<div class="server-manager-editor-head"><strong>'+esc(file.path)+'</strong>'+
   '<span>'+esc(state.lastLive?"Live file":"Last verified backup")+'</span></div>'+
   (file.unsupported?'<div class="server-manager-placeholder">This file is binary, protected, or too large to preview.</div>':
   '<textarea id="server-file-text" spellcheck="false" aria-label="Server file content" '+(editable?"":"readonly")+'>'+esc(file.content??"")+'</textarea>')+
   '<div class="server-manager-editor-actions">'+
   (editable?'<button type="button" class="btn primary" data-srv-action="save-file" '+(state.fileSaving?'disabled':'')+'>Queue change</button>':'')+
   (protectedFile?'<button type="button" class="btn" data-srv-action="go-settings">Open Server Settings</button>':'')+
   (staged?'<button type="button" class="btn" data-srv-action="discard">Discard queued edit</button>':'')+
   '</div><p class="field-tip">Queued changes apply the next time Paper starts. They do not modify the running world or an existing backup.</p>';
}
function rows(){
 if(!state.listing)return'<div class="server-manager-placeholder">Loading server files…</div>';
 const entries=Array.isArray(state.listing.entries)?state.listing.entries:[];
 if(!entries.length)return'<div class="server-manager-placeholder">This folder is empty.</div>';
 return entries.map(entry=>{
   const path=String(entry.path||"");
   const queued=Object.prototype.hasOwnProperty.call(state.pending,path);
   return '<button type="button" class="server-file-row'+(state.selected?.path===path?" selected":"")+'" data-srv-action="'+(entry.type==="dir"?"folder":"file")+'" data-path="'+esc(path)+'">'+
      '<span class="server-file-icon" aria-hidden="true">'+(entry.type==="dir"?"▣":"▤")+'</span>'+
      '<span class="server-file-name">'+esc(entry.name||path)+(queued?'<em>Queued</em>':'')+'</span>'+
      '<small>'+(entry.type==="dir"?"Folder":count(entry.size))+'</small></button>';
 }).join("");
}
function renderFiles(live,running){
 state.lastLive=Boolean(live);
 state.lastRunning=Boolean(running);
 const container=document.querySelector("#content");
 if(!container)return;
 container.innerHTML='<div id="server-files-root" class="server-manager">'+
  '<div class="page-header"><div><div class="eyebrow">SERVER</div><h1>Server Files</h1>'+
  '<p>Browse the server filesystem and queue text-file changes.</p></div>'+
  '<button class="btn" data-srv-action="reload">Refresh files</button></div>'+
  '<div class="notice'+(running?"":" good")+'">'+
  (running?live?
    '<strong>Server running:</strong> files are read directly from Paper. Edits are queued and take effect only after the next safe restart.':
    '<strong>Server running:</strong> connect NetBird to browse live files. Offline snapshots are only available after the server stops.':
    '<strong>Server offline:</strong> viewing the latest verified backup. The backup cannot be edited directly; queued changes apply on the next startup.')+
  '</div><div class="server-manager-message" id="server-files-message" role="status" hidden></div>'+
  '<div class="server-manager-layout"><section class="panel server-manager-browser">'+
  '<div class="server-manager-breadcrumb">'+paths()+'</div><div id="server-files-list">'+
  (running&&!live?'<div class="server-manager-placeholder">Live file access unavailable. Connect Direct Paper via NetBird.</div>':rows())+
  '</div></section><section class="panel server-manager-preview" id="server-file-preview">'+fileActions()+
  '</section></div></div>';
 if(running&&!live)return;
 if(!state.listing||state.fileLoadKey!==String(live)+":"+state.dir)loadFiles();
}
async function loadPending(){
 try{const result=await invoke("server_files_pending");state.pending=result&&typeof result==="object"?result:{};}
 catch{state.pending={};}
}
async function loadFiles(){
 if(state.loading||!root())return;
 state.loading=true;
 const area=document.querySelector("#server-files-list");
 if(area)area.innerHTML='<div class="server-manager-placeholder">Loading…</div>';
 try{
  const [listing]=await Promise.all([invoke("server_files_list",{path:state.dir,live:state.lastLive}),loadPending()]);
  state.listing=listing;state.fileLoadKey=String(state.lastLive)+":"+state.dir;
  state.error="";
 }catch(e){state.listing=null;state.error=String(e);}
 finally{
  state.loading=false;
  if(root()){const area=document.querySelector("#server-files-list");if(area)area.innerHTML=state.error?
     '<div class="server-manager-placeholder">'+esc(state.error)+'</div>':rows();}
 }
}
async function openFile(path){
 const selected={path,content:"",unsupported:false};
 state.selected=selected;
 const area=document.querySelector("#server-file-preview");
 if(area)area.innerHTML='<div class="server-manager-placeholder">Opening file…</div>';
 try{
  const result=await invoke("server_files_read",{path,live:state.lastLive});
  selected.content=result.content;
 }catch(e){selected.unsupported=true;note(String(e),true);}
 if(area)area.innerHTML=fileActions();
}
async function saveFile(){
 if(!state.selected||state.fileSaving)return;
 const content=document.querySelector("#server-file-text")?.value;
 if(content===undefined)return;
 if(!window.confirm("Queue this file for the next server startup? The current server and existing backup will not be changed."))return;
 state.fileSaving=true;
 try{
  await invoke("server_files_stage",{path:state.selected.path,content});
  state.selected.content=content;state.pending[state.selected.path]=content;
  note("Queued successfully. Changes will apply at the next Paper startup.");
 }catch(e){note(String(e),true)}
 finally{state.fileSaving=false;const area=document.querySelector("#server-file-preview");if(area)area.innerHTML=fileActions();
   const list=document.querySelector("#server-files-list");if(list)list.innerHTML=rows();}
}
async function discard(){
 if(!state.selected)return;
 try{await invoke("server_files_unstage",{path:state.selected.path});
   delete state.pending[state.selected.path];note("Queued change discarded.");
   const area=document.querySelector("#server-file-preview");if(area)area.innerHTML=fileActions();
   const list=document.querySelector("#server-files-list");if(list)list.innerHTML=rows();
 }catch(e){note(String(e),true)}
}
const groups=["Players & Access","Gameplay","Performance","Networking","Other"];
function settingsControl(key,value){
 const group=categoryOf(key);
 const id="prop-"+key;
 if(value==="true"||value==="false"){
   const fixed=key==="online-mode";
   return '<label class="server-setting-item"><span><strong>'+esc(label(key))+'</strong><small>'+esc(key)+(fixed?" · enforced for account safety":"")+'</small></span>'+
     '<input class="server-toggle" data-setting-key="'+esc(key)+'" type="checkbox" '+(value==="true"?"checked":"")+' '+(fixed?"disabled":"")+'></label>';
 }
 const number=typeOf(key)==="number"||(/^(max-|min-|spawn-|view-|simulation-|op-|player-idle)/.test(key)&&/^-?\d+$/.test(value));
 return '<label class="server-setting-item"><span><strong>'+esc(label(key))+'</strong><small>'+esc(key)+'</small></span>'+
   '<input data-setting-key="'+esc(key)+'" id="'+esc(id)+'" type="'+(number?"number":"text")+'" '+(number?'step="1"':'')+
   ' value="'+esc(value)+'" '+(key==="server-ip"||key==="server-port"?'disabled title="Managed by the runner"':'')+'></label>';
}
function renderSettings(){
 const container=document.querySelector("#content");if(!container)return;
 const properties={...(state.settingData?.defaults||{}),...(state.settingData?.properties||{})};
 const search=state.settingSearch.toLowerCase();
 const filtered=Object.entries(properties).filter(([k])=>k.toLowerCase().includes(search)||categoryOf(k).toLowerCase().includes(search));
 container.innerHTML='<div class="server-manager settings-page">'+
  '<div class="page-header"><div><div class="eyebrow">SERVER</div><h1>Server Settings</h1>'+
  '<p>Configure Minecraft server properties. Unset values show standard defaults.</p></div>'+
  '<div class="header-actions"><button class="btn" data-srv-action="reload-settings">Reload</button>'+
  '<button class="btn primary" data-srv-action="save-settings" '+(!state.settingData||state.settingSaving?'disabled':'')+'>Save settings</button></div></div>'+
  '<div class="notice"><strong>Restart required:</strong> changes are saved to GitHub and apply at the next Paper startup. They do not alter the running server or modify old world backups. Online mode remains enabled to protect player identities and inventories.</div>'+
  '<div class="server-manager-settings-tools"><input id="server-setting-search" placeholder="Search settings…" value="'+esc(state.settingSearch)+'" aria-label="Filter server settings">'+
  '<span>'+filtered.length+' settings</span></div>'+
  '<div id="settings-feedback" class="server-manager-message" role="status">'+esc(state.settingError)+'</div>'+
  (!state.settingData?'<div class="panel server-manager-placeholder">Loading server settings…</div>':
  groups.map(group=>{const rows=filtered.filter(([k])=>categoryOf(k)===group);
    return rows.length?'<section class="panel server-settings-group"><h2 class="panel-title">'+esc(group)+'</h2><div class="server-setting-grid">'+
      rows.map(([k,v])=>settingsControl(k,String(v))).join("")+'</div></section>':"";}).join(""))+
  '</div>';
 if(!state.settingsLoaded&&!state.settingLoading)loadSettings();
}
async function loadSettings(){
 state.settingLoading=true;
 try{state.settingData=await invoke("server_settings_get");state.settingError="";state.settingsLoaded=true;}
 catch(e){state.settingError=String(e);}
 finally{state.settingLoading=false;state.settingsLoaded=true;if(document.querySelector(".settings-page"))renderSettings();}
}
async function saveSettings(){
 if(!state.settingData||state.settingSaving)return;
 const edits={};
 for(const el of document.querySelectorAll("[data-setting-key]")){
   if(el.disabled)continue;
   const key=el.dataset.settingKey;
   const value=el.type==="checkbox"?String(el.checked):el.value;
   if(el.type==="number"&&(!/^-?\d+$/.test(value)||!Number.isSafeInteger(Number(value)))){
     const status=document.querySelector("#settings-feedback");if(status)status.textContent="Invalid number for "+key;
     return;
   }
   const baseline=state.settingData.properties[key]??state.settingData.defaults?.[key];
   if(value!==String(baseline??""))edits[key]=value;
 }
 if(!Object.keys(edits).length){
  const status=document.querySelector("#settings-feedback");if(status)status.textContent="No changes to save.";
  return;
 }
 if(!window.confirm("Save "+Object.keys(edits).length+" setting(s)? They apply at the next server startup, not immediately."))return;
 state.settingSaving=true;
 try{await invoke("server_settings_save",{properties:edits,sha:state.settingData.sha});
   state.settingsLoaded=false;
   await loadSettings();
   const status=document.querySelector("#settings-feedback");if(status)status.textContent="Settings saved. Restart Paper safely to apply them.";
 }catch(e){const status=document.querySelector("#settings-feedback");if(status)status.textContent=String(e);}
 finally{state.settingSaving=false;}
}
document.addEventListener("click",async event=>{
 const control=event.target.closest("[data-srv-action]");
 if(!control)return;
 event.preventDefault();
 const action=control.dataset.srvAction;
 if(action==="go-settings"){document.querySelector('[data-page="settings"]')?.click();return}
 if(action==="folder"){
   state.dir=control.dataset.path||"";state.selected=null;state.listing=null;state.fileLoadKey=null;
   if(root())renderFiles(state.lastLive,state.lastRunning);return;
 }
 if(action==="file"){await openFile(control.dataset.path);return}
 if(action==="reload"){state.listing=null;state.fileLoadKey=null;await loadFiles();return}
 if(action==="save-file"){await saveFile();return}
 if(action==="discard"){await discard();return}
 if(action==="reload-settings"){state.settingsLoaded=false;await loadSettings();return}
 if(action==="save-settings"){await saveSettings();return}
});
document.addEventListener("input",event=>{
 if(event.target.id==="server-setting-search"){
   state.settingSearch=event.target.value;
   // Redraw only after debounce; settings inputs are kept intact if filtering.
   clearTimeout(state.searchTimer);
   state.searchTimer=setTimeout(()=>{if(document.querySelector(".settings-page"))renderSettings()},250);
 }
});
window.ServerManager={renderFiles,renderSettings,loadFiles,loadSettings};
})();
