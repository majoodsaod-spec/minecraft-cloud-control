/* Phase 2: private Paper player management. No player UUIDs or raw
   playerdata are exposed to the desktop. Admin actions require confirmation. */
(function(){
"use strict";
const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const USER=/^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{1,16})$/;
const actions={
  "kick":"Kick","ban":"Ban","pardon":"Unban",
  "whitelist-add":"Add to whitelist","whitelist-remove":"Remove from whitelist",
  "op":"Grant operator","deop":"Revoke operator"
};
const risky=new Set(["ban","op","deop","whitelist-remove"]);
const state={live:false,running:false,loading:false,acting:false,
  fetchedAt:0,source:null,session:null,
  data:null,error:"",notice:"",search:""};
const root=()=>document.querySelector("#player-management");
function badge(text,cls=""){return '<span class="player-badge '+cls+'">'+esc(text)+'</span>'}
function players(){
  const data=state.data||{};
  const set=new Set([...(data.online||[]),...(data.whitelisted||[]),...(data.operators||[]),...(data.banned||[])]);
  return [...set].filter(x=>USER.test(x)&&x.toLowerCase().includes(state.search.toLowerCase()))
    .sort((a,b)=>a.localeCompare(b));
}
function info(name){
  const data=state.data||{};
  const online=data.online?.includes(name)||false;
  const whitelist=data.whitelisted?.includes(name)||false;
  const operator=data.operators?.includes(name)||false;
  const banned=data.banned?.includes(name)||false;
  return {online,whitelist,operator,banned};
}
function rowFor(name){
  const flags=info(name);
  return '<div class="player-row"><div class="player-avatar">'+esc(name.slice(0,1).toUpperCase())+'</div>'+
    '<div class="player-identity"><strong>'+esc(name)+'</strong><div class="player-tags">'+
    badge(flags.online?"Online":"Offline",flags.online?"active":"")+
    (flags.operator?badge("Operator","trusted"):"")+
    (flags.whitelist?badge("Whitelisted",""):"")+
    (flags.banned?badge("Banned","danger"):"")+'</div></div>'+
    '<div class="player-row-actions"><select data-player-select="'+esc(name)+'" aria-label="Action for '+esc(name)+'" '+
    (state.acting||!state.live?"disabled":"")+'>'+
    '<option value="">Choose action</option>'+Object.entries(actions)
      .filter(([action])=>action!=="kick"||flags.online)
      .map(([action,label])=>'<option value="'+esc(action)+'">'+esc(label)+'</option>').join("")+
    '</select><button type="button" class="btn small" data-player-action="apply" data-player="'+esc(name)+'" '+
    (state.acting||!state.live?"disabled":"")+'>Apply</button></div></div>';
}
function render(){
  const target=document.querySelector("#content");if(!target)return;
  const canManage=state.live;
  const data=state.data;
  const online=data?.online||[];
  const rows=players();
  const n=Date.now()-state.fetchedAt;
  target.innerHTML='<section id="player-management" class="player-management">'+
    '<div class="page-header"><div><div class="eyebrow">SERVER</div><h1>Players</h1>'+
    '<p>Manage connected players, whitelist, bans and operator permissions.</p></div>'+
    '<div class="header-actions"><button class="btn" data-player-action="refresh" '+(state.loading?"disabled":"")+
    '>Refresh players</button></div></div>'+
    '<div class="notice">'+(canManage?
      '<strong>Direct Paper connected:</strong> Admin commands are sent through authenticated NetBird.' :
      state.running?'<strong>Read-only:</strong> Direct Paper is unavailable. Player actions are disabled to avoid unconfirmed changes.' :
      '<strong>Offline:</strong> Player names are read from the last verified backup; actions require an active direct Paper connection.')+
    '</div>'+
    (state.error?'<div class="server-manager-message error">'+esc(state.error)+'</div>':"")+
    (state.notice?'<div class="server-manager-message">'+esc(state.notice)+'</div>':"")+
    '<div class="player-stats">'+
    '<div><strong>'+esc(data?online.length:"—")+'</strong><span>Online</span></div>'+
    '<div><strong>'+esc(data?(data.whitelisted||[]).length:"—")+'</strong><span>Whitelisted</span></div>'+
    '<div><strong>'+esc(data?(data.operators||[]).length:"—")+'</strong><span>Operators</span></div>'+
    '<div><strong>'+esc(data?(data.banned||[]).length:"—")+'</strong><span>Banned</span></div></div>'+
    '<section class="panel player-list-panel">'+
    '<div class="player-list-heading"><div><h2>Player directory</h2><p>Only usernames are displayed; private player records are not exposed.</p></div>'+
    '<input id="player-search" type="search" placeholder="Search players…" value="'+esc(state.search)+'" aria-label="Search players"></div>'+
    (state.loading&&!data?'<div class="server-manager-placeholder">Loading player records…</div>':
      rows.length?'<div class="player-rows">'+rows.map(rowFor).join("")+'</div>':
      '<div class="server-manager-placeholder">'+(state.search?"No matching players.":"No saved player names found.")+'</div>')+
    '</section>'+
    '<section class="panel player-admin-panel"><h2>Manage player</h2>'+
    '<p>For someone not in the list, enter their exact Java username or Floodgate-prefixed Bedrock username.</p>'+
    '<div class="player-manual-actions"><input id="player-name" maxlength="17" placeholder="Username" aria-label="Player username" '+
    (!canManage?"disabled":"")+'>'+
    '<select id="player-command" '+(!canManage?"disabled":"")+' aria-label="Player command">'+
    Object.entries(actions).filter(([action])=>action!=="kick")
      .map(([action,label])=>'<option value="'+esc(action)+'">'+esc(label)+'</option>').join("")+
    '</select><button class="btn primary" data-player-action="manual" '+
    (state.acting||!canManage?"disabled":"")+'>Apply</button></div>'+
    '<div class="player-whitelist"><span><strong>Whitelist enforcement</strong><small>'+
    (data?.whitelistEnabled===null||data?.whitelistEnabled===undefined?"Status unavailable":
      data.whitelistEnabled?"Enabled":"Disabled")+'</small></span>'+
    '<div class="player-whitelist-buttons">'+
      (canManage&&data&&typeof data.whitelistEnabled==="boolean"?
        '<button type="button" class="btn small" data-player-action="whitelist-toggle" '+
        (state.acting?"disabled":"")+'>'+(data.whitelistEnabled?"Disable whitelist":"Enable whitelist")+'</button>':'')+
      '<button class="btn small" data-player-action="settings">Open Server Settings</button></div></div>'+
    '<p class="field-tip">'+(state.live?"Live Paper records":"Backup records")+
    (state.fetchedAt?" · refreshed "+Math.max(0,Math.round(n/1000))+" seconds ago":" · not yet loaded")+
    '. Commands are acknowledged by the server agent; refresh to verify Paper applied them.</p></section></section>';
}
async function load(force=false){
  if(state.loading||(!force&&state.data&&Date.now()-state.fetchedAt<15000))return;
  state.loading=true;state.error="";render();
  try{
    const response=state.live?
      await invoke("direct_command",{kind:"players-list",args:{}}):
      state.running?null:await invoke("server_players_snapshot");
    if(response===null)throw Error("Connect Direct Paper to inspect the current player directory");
    const data=state.live?(response?.ok?response.result:null):response;
    if(!data||!Array.isArray(data.whitelisted)||!Array.isArray(data.operators)||
       !Array.isArray(data.banned)||!Array.isArray(data.online))throw Error("Invalid player inventory response");
    state.data=data;state.fetchedAt=Date.now();state.source=state.live?"live":"backup";
    state.session=data.session||null;
  }catch(error){state.error=String(error).slice(0,200);state.data=null;}
  finally{state.loading=false;if(root())render();}
}
function show(live,running,telemetry){
  const session=telemetry?.session||null;
  if(state.live!==Boolean(live)||state.running!==Boolean(running)||
     (state.live&&session&&session!==state.session)){
    state.data=null;state.fetchedAt=0;
  }
  state.live=Boolean(live);state.running=Boolean(running);
  render();
  if(!state.loading)load();
}
async function perform(command,player){
  if(state.acting||!state.live)return;
  if(!Object.hasOwn(actions,command)||!USER.test(player)){
    state.error="Enter a valid Java username or a dot-prefixed Floodgate username.";render();return;
  }
  const description=actions[command]+" "+player;
  if(!window.confirm(description+"?\n\nThis command will be sent to the running Paper server."))return;
  if(risky.has(command)&&!window.confirm("Confirm privileged action: "+description+
      "\n\nThis can affect access or permissions."))return;
  state.acting=true;state.notice="Sending "+description+"…";state.error="";render();
  try{
    const response=await invoke("direct_command",{kind:command,args:{player}});
    if(!response?.ok)throw Error(response?.error||"Paper did not acknowledge the command");
    state.notice=description+" was sent to Paper. Refresh to verify the result.";
    state.fetchedAt=0;
  }catch(error){state.error="Command failed: "+String(error).slice(0,200);}
  finally{state.acting=false;if(root())render();}
}
document.addEventListener("click",async e=>{
  const button=e.target.closest("[data-player-action]");
  if(!button||!root())return;
  e.preventDefault();
  switch(button.dataset.playerAction){
    case "refresh":state.fetchedAt=0;load(true);break;
    case "settings":document.querySelector('[data-page="settings"]')?.click();break;
    case "apply":{
      const name=button.dataset.player;
      const control=[...root().querySelectorAll("[data-player-select]")].find(x=>x.dataset.playerSelect===name);
      if(control?.value)perform(control.value,name);
      break;
    }
    case "manual":{
      const player=root().querySelector("#player-name")?.value.trim();
      const command=root().querySelector("#player-command")?.value;
      perform(command,player);
      break;
    }
    case "whitelist-toggle":{
      const previous=state.data?.whitelistEnabled;
      if(!state.live||typeof previous!=="boolean"||state.acting)break;
      const desired=!previous;
      if(!window.confirm((desired?"Enable":"Disable")+
          " whitelist enforcement?\n\nThis changes who may join Paper. Confirm before applying."))break;
      state.acting=true;state.error="";state.notice="Sending whitelist setting to Paper…";render();
      try{
        const response=await invoke("direct_command",{kind:desired?"whitelist-on":"whitelist-off",args:{}});
        if(!response?.ok)throw Error(response?.error||"Paper did not acknowledge whitelist change");
        state.notice="Whitelist change requested. Refresh player records to verify Paper saved it.";
        state.fetchedAt=0;
      }catch(error){state.error="Whitelist update failed: "+String(error).slice(0,180);}
      finally{state.acting=false;if(root())render();}
      break;
    }
  }
});
document.addEventListener("input",e=>{
  if(e.target.id!=="player-search"||!root())return;
  state.search=e.target.value;
  const focus=state.search.length;
  render();
  const input=root()?.querySelector("#player-search");
  if(input){input.focus();input.setSelectionRange(focus,focus);}
});
window.PlayerManager={show,load};
})();
