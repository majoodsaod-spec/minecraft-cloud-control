"use strict";
/* Live Minecraft-centric experience: server facts from the bridge, not guesses. */
const serverPhase = () => {
  if (!cloudState) return "disconnected";
  const bridge=cloudState.bridge||{},state=bridge.status||{},fresh=Boolean(state.session && Date.now()-(state.updatedAt||0)<45000);
  if (["saving","stopping","backing_up","stopped","failed"].includes(state.phase)) {
    if(state.phase==="stopped" || state.phase==="failed")return cloudState.active.length?"finishing":state.phase;
    return state.phase;
  }
  if (fresh&&state.ready)return "online";
  if (fresh)return "starting";
  if (cloudState.active.length)return "starting";
  return bridge.desired==="off"?"stopped":"offline";
};
const isBridgeLive=()=>Boolean(cloudState?.bridge?.status?.session && Date.now()-(cloudState.bridge.status.updatedAt||0)<45000 && cloudState.bridge.status.ready);
const displayDuration=seconds=>{
  if(!Number.isFinite(seconds))return "—";
  seconds=Math.max(0,Math.floor(seconds));
  return [Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(x=>String(x).padStart(2,"0")).join(":");
};
const phaseInfo={
  online:["Online","Your Minecraft server is ready for players.","good",100],
  starting:["Starting","Preparing your world and launching the server.","waiting",12],
  saving:["Saving","Kicking players and flushing world and player data.","waiting",32],
  stopping:["Stopping","Waiting for the server to shut down cleanly.","waiting",55],
  backing_up:["Backing up","Creating and uploading your verified world backup.","waiting",78],
  finishing:["Finishing","Completing the backup and shutdown.","waiting",92],
  stopped:["Stopped","Your data has been saved and the server is off.","",100],
  offline:["Offline","The server is not running.","",0],
  failed:["Attention needed","A shutdown or server operation needs attention.","waiting",0],
  disconnected:["Disconnected","Sign in to manage your server.","",0]
};
function proNode(parent,tag,cls,text){
  const el=element(tag,cls,text);
  parent.append(el);return el;
}
function proAction(label,callback,cls="outline",disabled=false){
  const b=button(label,callback,cls);b.disabled=disabled;return b;
}
function proLink(parent,label,url){
  const a=proNode(parent,"a","btn outline",label);a.href=url;a.target="_blank";a.rel="noopener noreferrer";return a;
}
function proToast(message){toast(message)}
async function proCommand(type,args={},ask=null){
  if(!isBridgeLive()){proToast("Live server connection is not ready");return}
  await cloudAction("live-command",{type,args},ask);
}
function proNotice(parent,message){proNode(parent,"div","notice",message)}
function proPanel(p,title){
  const panel=proNode(p,"div","panel section");proNode(panel,"h2","",title);return panel;
}
function proField(parent,placeholder,type="text"){
  const el=proNode(parent,"input");el.type=type;el.placeholder=placeholder;return el;
}
function proPhaseProgress(parent,phase){
  const track=proNode(parent,"div","server-progress");
  const fill=proNode(track,"div","server-progress-fill");
  fill.style.width=phaseInfo[phase][3]+"%";
  if(["saving","stopping","backing_up","finishing","starting"].includes(phase)) fill.classList.add("progress-flow");
  if(["saving","stopping","backing_up","finishing"].includes(phase)){
    const steps=proNode(parent,"div","stage-line");
    const order=["saving","stopping","backing_up","stopped"];
    const reached=order.indexOf(phase);
    order.forEach((x,i)=>{
      const item=proNode(steps,"span","stage-step"+(i<=reached?" reached":""),{
        saving:"Saving",stopping:"Stopping",backing_up:"Backing up",stopped:"Stopped"
      }[x]);
      if(i<3)proNode(steps,"span","stage-separator","›");
    });
  }
}
const previousOverview=overview;
overview=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const bridge=cloudState.bridge||{}, live=bridge.status||{}, phase=serverPhase(),info=phaseInfo[phase];
  const hero=proNode(p,"section","server-overview");
  const heading=proNode(hero,"div","server-header");
  const left=proNode(heading,"div");
  proNode(left,"div","dashboard-kicker","MINECRAFT SERVER · PAPER 26.3");
  proNode(left,"h2","server-title",info[0]);
  proNode(left,"p","muted small",info[1]);
  proNode(heading,"div","server-state "+info[2],info[0]);
  proPhaseProgress(hero,phase);
  const dashboard=proNode(p,"div","server-metrics");
  const metrics=[
    ["Online players",isBridgeLive()?String((live.players||[]).length):"—",isBridgeLive()?"Connected right now":"Waiting for live data"],
    ["Server uptime",isBridgeLive()?displayDuration((live.uptime||0)+(Date.now()-(live.updatedAt||Date.now()))/1000):"—","Current running session"],
    ["Next restart",isBridgeLive()?displayDuration(Math.max(0,live.restartIn-(Date.now()-live.updatedAt)/1000)):"—","Scheduled maximum uptime"],
    ["Idle restart",isBridgeLive()?displayDuration(Math.max(0,live.idleRestartIn-(Date.now()-live.updatedAt)/1000)):"—","Time since last player joined"],
    ["Latest backup",cloudState.backups?.length?new Date(cloudState.backups[0].created_at).toLocaleDateString():"None yet","Verified saved snapshot"],
    ["Software","Paper 26.3","Java 25"]
  ];
  for(const [title,value,desc] of metrics){
    const card=proNode(dashboard,"div","panel server-stat");
    proNode(card,"div","server-stat-label",title);
    proNode(card,"strong","server-stat-value",value);
    proNode(card,"div","muted small",desc);
  }
  const controls=proPanel(p,"Server controls");
  const actions=proNode(controls,"div","dashboard-actions");
  const canStart=!cloudState.active.length && !["saving","stopping","backing_up","finishing"].includes(phase);
  actions.append(proAction("▶ Start server",()=>cloudAction("start",{},"Start your Minecraft server and restore the latest world?"),"primary",!canStart));
  const safeStop=isBridgeLive() && phase==="online";
  actions.append(proAction("■ Save & stop",()=>cloudAction("stop",{},"Kick connected players, save all world data, upload a verified backup, and turn the server off?"),"danger",!safeStop));
  actions.append(proAction("↻ Save & restart",()=>proCommand("restart",{},"Save the world, disconnect players, and restart the server?"),"outline",!safeStop));
  actions.append(proAction("⟳ Refresh",()=>cloudRefresh(true)));
  if(["saving","stopping","backing_up","finishing"].includes(phase))proNotice(controls,"Safe shutdown is in progress. Please keep the server running until backup verification completes.");
  if(!isBridgeLive()&&cloudState.active.length)proNode(controls,"p","muted small","Waiting for the server's secure live connection before enabling safe controls.");
  const extras=proPanel(p,"Quick access");
  const links=proNode(extras,"div","dashboard-actions");
  for(const [label,id] of [["Server settings","settings"],["Online players","players"],["Live console","console"],["World backups","worlds"],["Files","files"],["Plugins","plugins"]]){
    links.append(proAction(label,()=>{tab=id;render()}));
  }
  if(cloudState.warnings?.length)cloudState.warnings.forEach(w=>proNotice(p,w));
  if(cloudError)proNotice(p,"Status refresh failed; showing last known data: "+cloudError);
  proNode(p,"div","dashboard-meta","Live status refreshes automatically every 5 seconds while this page is open.");
};
playersPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Online players");
  const names=isBridgeLive()?cloudState.bridge.status.players||[]:[];
  proNode(panel,"p","muted small",isBridgeLive()?names.length+" player(s) online right now.":"Waiting for the running server to connect.");
  if(!names.length)proNode(panel,"div","empty","Nobody is online.");
  for(const name of names){
    const row=proNode(panel,"div","rowsetting");
    const left=proNode(row,"div");
    proNode(left,"strong","",name);
    const actions=proNode(row,"div","flex");
    actions.append(proAction("Kick",()=>proCommand("kick",{player:name},"Kick "+name+" from the server?"),"outline"));
    actions.append(proAction("Ban",()=>proCommand("ban",{player:name},"Ban "+name+" from the server?"),"danger"));
    actions.append(proAction("Whitelist +",()=>proCommand("whitelist-add",{player:name}),"outline"));
  }
  const admin=proPanel(p,"Manage a player");
  const input=proField(admin,"Exact Minecraft username");
  const row=proNode(admin,"div","dashboard-actions");
  for(const [label,type] of [["Whitelist +","whitelist-add"],["Whitelist −","whitelist-remove"],["Unban","pardon"],["Make OP","op"],["Remove OP","deop"]]){
    row.append(proAction(label,()=>proCommand(type,{player:input.value.trim()},type==="op"?"Give operator powers to "+input.value+"?":null),"outline",!isBridgeLive()));
  }
  const wl=proNode(admin,"div","dashboard-actions");
  wl.append(proAction("Enable whitelist",()=>proCommand("whitelist-on"),"outline",!isBridgeLive()));
  wl.append(proAction("Disable whitelist",()=>proCommand("whitelist-off",{},"Allow all authenticated players to join?"),"outline",!isBridgeLive()));
};
consolePage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Server console");
  proNode(panel,"p","muted small",isBridgeLive()?"Live server output. Commands are queued and run by Paper.":"Console is available when your server is connected.");
  const consoleBox=proNode(panel,"pre","console pro-console",(cloudState.bridge?.status?.logs||[]).join("\n")||"No live output yet.");
  const form=proNode(panel,"form","console-command-row");
  const input=proField(form,"Type a server command, e.g. say Hello");
  input.autocomplete="off";
  const send=proNode(form,"button","btn primary","Send");
  send.type="submit";send.disabled=!isBridgeLive();
  form.onsubmit=e=>{e.preventDefault();const cmd=input.value.trim();if(cmd){proCommand("console",{command:cmd});input.value=""}};
  const history=cloudState.bridge?.history||[];
  if(history.length){
    const box=proPanel(p,"Recent command results");
    history.slice(0,8).forEach(x=>proNode(box,"div","small muted",(x.ok?"✓ ":"! ")+x.type+" · "+(typeof x.result==="string"?x.result:"Completed")));
  }
};
function latestResult(type){
  return (cloudState?.bridge?.history||[]).find(x=>x.type===type&&x.ok&&x.result)||null;
}
filesPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"File manager");
  proNode(panel,"p","muted small","Browse the server's runtime files. Editing is limited to small text configuration files; world data is protected while the server is online.");
  const nav=proNode(panel,"div","dashboard-actions");
  const folder=proField(nav,"Relative folder (empty for root)");
  folder.value=window.mcFilesPath||"";
  const browse=()=>{
    window.mcFilesPath=folder.value.trim();
    proCommand("files-list",{path:window.mcFilesPath||"."});
  };
  nav.append(proAction("Browse folder",browse,"primary",!isBridgeLive()));
  const result=latestResult("files-list");
  if(result && Array.isArray(result.result)){
    const table=proNode(panel,"div","filetable");
    for(const file of result.result){
      const row=proNode(table,"div","backup-row");
      proNode(row,"span","",file.type==="dir"?"📁 "+file.name:"📄 "+file.name);
      row.append(proAction("Open",()=>{
        if(file.type==="dir"){folder.value=file.path;browse()}
        else{window.mcEditPath=file.path;proCommand("files-read",{path:file.path})}
      },"outline"));
    }
  }
  const editor=proPanel(p,"Text editor");
  const path=proField(editor,"Path, e.g. server.properties");path.value=window.mcEditPath||"server.properties";
  const content=proNode(editor,"textarea");content.rows=10;content.placeholder="Open a text file to edit it";
  const read=latestResult("files-read");
  if(read?.result?.path===path.value)content.value=read.result.content||"";
  const actions=proNode(editor,"div","dashboard-actions");
  actions.append(proAction("Open file",()=>{window.mcEditPath=path.value;proCommand("files-read",{path:path.value})},"outline",!isBridgeLive()));
  actions.append(proAction("Save file",()=>proCommand("files-write",{path:path.value,content:content.value},"Save this server file? It will persist after the next verified backup."),"primary",!isBridgeLive()));
  actions.append(proAction("Delete file",()=>proCommand("files-delete",{path:path.value},"Permanently delete this configuration file from the running server?"),"danger",!isBridgeLive()));
  proNotice(editor,"Files are saved on the running server. Changes are preserved in the next clean backup; stop safely before the runner expires.");
};
pluginsPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Plugin manager");
  proNode(panel,"p","muted small","Upload Paper plugin JARs to persistent configuration. Installed plugins take effect when the server starts again.");
  const input=proNode(panel,"input");input.type="file";input.accept=".jar";
  const row=proNode(panel,"div","dashboard-actions");
  row.append(proAction("Upload plugin",async()=>{
    const file=input.files?.[0];
    if(!file){proToast("Select a .jar plugin first");return}
    if(!file.name.endsWith(".jar")){proToast("Only .jar plugins are accepted");return}
    if(file.size>650000){proToast("This uploader supports JARs under 650 KiB. Larger plugins require a repository upload.");return}
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    await cloudAction("plugin-upload",{name:file.name,content:btoa(binary)});
  },"primary"));
  row.append(proAction("Refresh plugin list",async()=>{
    try{
      window.mcPlugins=(await cloudApi("plugin-list")).plugins;
      render();
    }catch(e){proToast(e.message)}
  }));
  if(!window.mcPlugins)proNode(panel,"p","muted small","Press Refresh plugin list to see plugins stored for installation.");
  for(const plugin of window.mcPlugins||[]){
    const item=proNode(panel,"div","backup-row");
    const left=proNode(item,"div");
    proNode(left,"strong","",plugin.name);
    proNode(left,"div","muted small",Math.round(plugin.size/1024)+" KiB");
    item.append(proAction("Remove",async()=>{
      await cloudAction("plugin-remove",{name:plugin.name},"Remove "+plugin.name+" at the next restart?");
      window.mcPlugins=(await cloudApi("plugin-list")).plugins;render();
    },"danger"));
  }
  proNotice(panel,"Only install trusted plugins. Server plugin data is included in verified backups; plugin JARs are managed separately.");
};
const prevWorlds=worldsPage;
worldsPage=function(p){
  prevWorlds(p);
  if(!cloudState)return;
  const panel=proPanel(p,"Safe backup controls");
  proNode(panel,"p","muted small","You can request a save immediately. A full verified backup is created when Paper shuts down cleanly, including during safe restart.");
  const actions=proNode(panel,"div","dashboard-actions");
  actions.append(proAction("Save world now",()=>proCommand("save"),"outline",!isBridgeLive()));
  actions.append(proAction("Save & restart (new backup)",()=>proCommand("restart",{},"Disconnect players, save all data and create a verified backup before restarting?"),"primary",!isBridgeLive()));
};
const previousAbout=aboutPage;
aboutPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Connections");
  for(const [k,v] of [["Server link",isBridgeLive()?"Connected":"Waiting for server"],["Version","Paper 26.3"],["Auto refresh","Every 5 seconds"],["Saved snapshots",String(cloudState.backups?.length||0)],["Server power",cloudState.bridge?.desired==="off"?"Off":"On"]]){
    const row=proNode(panel,"div","rowsetting");
    proNode(row,"strong","",k);proNode(row,"span","muted small",v);
  }
  panel.append(proAction("Disconnect dashboard",()=>{
    cloudPassword="";cloudState=null;sessionStorage.removeItem("mccloud-admin");render();
  },"danger"));
};
const previousRefresh=cloudRefresh;
cloudRefresh=async function(notify=false){
  await previousRefresh(notify);
  const livePhase=serverPhase();
  const badge=document.querySelector(".top .badge");
  if(badge){
    badge.replaceChildren();
    proNode(badge,"span","dot");
    badge.append(document.createTextNode(" "+phaseInfo[livePhase][0]));
  }
};
window.setInterval(()=>{if(cloudPassword&&!document.hidden&&!cloudBusy)cloudRefresh()},5000);
render();
