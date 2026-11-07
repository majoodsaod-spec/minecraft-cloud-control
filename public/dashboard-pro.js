"use strict";
/* Live Minecraft-centric experience: server facts from the bridge, not guesses. */
const CONSOLE_STORE="mccloud-console-history";
const CONSOLE_DRAFT="mccloud-console-draft";
const FILE_DRAFT="mccloud-file-draft";
let consoleSession="";
let consoleHistory=[];
let lastConsoleWindow=[];
const pendingConsoleCommands=new Map();
try {
  const saved=JSON.parse(sessionStorage.getItem(CONSOLE_STORE)||"null");
  if(saved && Array.isArray(saved.lines)){
    consoleSession=String(saved.session||"");
    consoleHistory=saved.lines.slice(-400).map(String);
    lastConsoleWindow=Array.isArray(saved.window)?saved.window.map(String):[];
  }
}catch{ /* Malformed or unavailable session storage is harmless. */ }
function saveConsoleHistory(){
  try{sessionStorage.setItem(CONSOLE_STORE,JSON.stringify({session:consoleSession,lines:consoleHistory,window:lastConsoleWindow}));}
  catch{ /* Storage quota may be unavailable. */ }
}
function accumulateConsole(){
  const live=cloudState?.bridge?.status||{};
  const lines=Array.isArray(live.logs)?live.logs.map(String):[];
  if(!lines.length)return;
  if(live.session && live.session!==consoleSession){
    if(consoleHistory.length)consoleHistory.push("— New server session —");
    consoleSession=live.session;
    lastConsoleWindow=[];
  }
  // Compare successive server windows, not the displayed history, because
  // locally queued command receipts can appear between real server lines.
  const max=Math.min(lastConsoleWindow.length,lines.length);
  let overlap=0;
  for(let count=max;count>0;count--){
    if(lines.slice(0,count).every((line,i)=>lastConsoleWindow[lastConsoleWindow.length-count+i]===line)){
      overlap=count;break;
    }
  }
  consoleHistory.push(...lines.slice(overlap));
  consoleHistory=consoleHistory.slice(-400);
  lastConsoleWindow=lines;
  saveConsoleHistory();
}
const serverPhase = () => {
  if (!cloudState) return "disconnected";
  const bridge=cloudState.bridge||{},state=bridge.status||{},fresh=Boolean(state.session && Date.now()-(state.updatedAt||0)<45000);
  if (["shutdown_requested","saving","stopping","backing_up","stopped","failed"].includes(state.phase)) {
    if(state.phase==="stopped")return cloudState.active.length?"finishing":state.phase;
    if(state.phase==="failed")return state.phase;
    return state.phase;
  }
  if (fresh&&state.ready)return "online";
  if (fresh)return "starting";
  if (cloudState.active.length){
    // A GitHub Actions job can be running without any live Paper telemetry.
    // Don't claim Paper is still booting indefinitely in that situation.
    const active=cloudState.active[0]||{};
    const age=active.created_at?Date.now()-Date.parse(active.created_at):0;
    return Number.isFinite(age)&&age>120000?"bridge_missing":"starting";
  }
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
  bridge_missing:["Live status unavailable","GitHub Actions is active, but the dashboard has no recent Paper heartbeat. The server may still be online.","waiting",0],
  shutdown_requested:["Preparing to stop","Shutdown requested. Waiting for the server to begin saving.","waiting",14],
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
  if(["shutdown_requested","saving","stopping","backing_up","finishing","starting"].includes(phase)) fill.classList.add("progress-flow");
  if(["shutdown_requested","saving","stopping","backing_up","finishing"].includes(phase)){
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
let lastRenderedServerPhase="";
let lastRenderedFileResult="";
let lastRenderedPlayers="";
function updateLiveMetrics(){
  if(!cloudState || tab!=="overview")return;
  const state=cloudState.bridge?.status||{};
  const elapsed=cloudLastUpdate?Math.max(0,(Date.now()-cloudLastUpdate)/1000):0;
  const values={
    onlineplayers:isBridgeLive()?String((state.players||[]).length):"—",
    serveruptime:isBridgeLive()?displayDuration((state.uptime||0)+elapsed):"—",
    nextrestart:isBridgeLive()?displayDuration(Math.max(0,(state.restartIn||0)-elapsed)):"—",
    emptytime:isBridgeLive()?displayDuration((state.players||[]).length?0:Math.max(0,(state.emptyFor||0)+elapsed)):"—",
    memoryusage:isBridgeLive()&&Number.isFinite(state.memoryMiB)?state.memoryMiB.toFixed(0)+" MiB":"—",
    latestbackup:cloudState.backups?.length?new Date(cloudState.backups[0].created_at).toLocaleDateString():"None yet"
  };
  for(const [name,value] of Object.entries(values)){
    const node=document.querySelector('[data-metric="'+name+'"]');
    if(node&&node.textContent!==value)node.textContent=value;
  }
}
function javaJoinPanel(p){
  const java=cloudState?.java||{host:""};
  const panel=proPanel(p,"Java Edition · Connect");
  proNode(panel,"p","muted small","Share this Playit address with Minecraft Java Edition players.");
  const grid=proNode(panel,"div","server-metrics");
  const host=proNode(grid,"div","panel server-stat");
  proNode(host,"div","server-stat-label","Java server address");
  proNode(host,"strong","server-stat-value",java.host||"Not configured");
  const note=proNode(grid,"div","panel server-stat");
  proNode(note,"div","server-stat-label","Connection");
  proNode(note,"strong","server-stat-value",java.host?"Address saved":"Not configured");
  proNode(note,"div","muted small","Reachability is not verified");
  const actions=proNode(panel,"div","dashboard-actions");
  actions.append(proAction("Copy Java address",async()=>{
    try{await navigator.clipboard.writeText(java.host);toast("Java address copied");}
    catch{window.prompt("Copy Java server address",java.host);}
  },"outline",!java.host));
  return panel;
}
function bedrockPanel(p, editable=false){
  const bedrock=cloudState?.bedrock||{host:"",port:19132};
  const panel=proPanel(p,"Bedrock Edition · Cross-play");
  proNode(panel,"p","muted small",
    "Geyser + Floodgate let Bedrock players join your existing world. Bedrock 26.60+ uses NetherNet; a separate Playit Minecraft Bedrock (NetherNet) tunnel is needed.");
  const grid=proNode(panel,"div","server-metrics");
  const host=proNode(grid,"div","panel server-stat");
  proNode(host,"div","server-stat-label","Bedrock server address");
  proNode(host,"strong","server-stat-value",bedrock.host||"Not configured");
  const port=proNode(grid,"div","panel server-stat");
  proNode(port,"div","server-stat-label","Bedrock public port");
  proNode(port,"strong","server-stat-value",String(bedrock.port||19132));
  const edition=proNode(grid,"div","panel server-stat");
  proNode(edition,"div","server-stat-label","Connection");
  proNode(edition,"strong","server-stat-value",bedrock.host?"Address saved":"Tunnel needed");
  proNode(edition,"div","muted small","Reachability is not verified");
  const actions=proNode(panel,"div","dashboard-actions");
  const copy=proAction("Copy Bedrock address",async()=>{
    const address=bedrock.host+":"+(bedrock.port||19132);
    try{await navigator.clipboard.writeText(address);toast("Bedrock address copied");}
    catch{window.prompt("Copy Bedrock server address",address);}
  },"outline",!bedrock.host);
  actions.append(copy);
  if(!editable)actions.append(proAction("Configure Bedrock",()=>{tab="about";render()},"outline"));
  if(editable){
    const form=proNode(panel,"form","connect-form");
    const hostInput=proField(form,"Public Bedrock tunnel hostname");
    hostInput.value=bedrock.host||"";
    hostInput.autocomplete="off";
    const portInput=proField(form,"Public Bedrock port","number");
    portInput.min=1;portInput.max=65535;portInput.value=bedrock.port||19132;
    const save=proNode(form,"button","btn primary","Save Bedrock address");
    save.type="submit";
    form.onsubmit=async event=>{
      event.preventDefault();
      save.disabled=true;
      try{
        const result=await cloudApi("bedrock-address",{host:hostInput.value.trim(),port:Number(portInput.value)});
        toast(result.message||"Address saved");
        await cloudRefresh();
        render();
      }catch(error){toast(error.message)}
      finally{save.disabled=false}
    };
    proNode(panel,"p","muted small","Enter the public hostname and port shown inside your Playit Bedrock (NetherNet) tunnel. This only changes the dashboard's displayed address; it does not create a tunnel.");
  }
  return panel;
}
const previousOverview=overview;
overview=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const bridge=cloudState.bridge||{}, live=bridge.status||{}, phase=serverPhase(),info=phaseInfo[phase];
  lastRenderedServerPhase=phase;
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
    ["Empty time",isBridgeLive()?displayDuration((live.players||[]).length?0:Math.max(0,(live.emptyFor||0)+(Date.now()-(live.updatedAt||Date.now()))/1000)):"—",
      isBridgeLive()&&((live.players||[]).length>0)?"Players online · timer reset":"Safe restart after 01:00:00 continuously empty"],
    ["Latest backup",cloudState.backups?.length?new Date(cloudState.backups[0].created_at).toLocaleDateString():"None yet","Verified saved snapshot"],
    ["Memory usage",isBridgeLive()&&Number.isFinite(live.memoryMiB)?live.memoryMiB.toFixed(0)+" MiB":"—","Java heap up to 8192 MiB"],
    ["Software","Paper 26.3","Java 25"]
  ];
  for(const [title,value,desc] of metrics){
    const card=proNode(dashboard,"div","panel server-stat");
    proNode(card,"div","server-stat-label",title);
    const valueNode=proNode(card,"strong","server-stat-value",value);
    valueNode.dataset.metric=title.toLowerCase().replace(/[^a-z]/g,"");
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
  if(!isBridgeLive()&&cloudState.active.length)proNode(controls,"p","muted small",phase==="bridge_missing"
    ?"No live heartbeat: check the GitHub Actions server log for 'Cloudflare live bridge enabled' or 'Cloudflare bridge connection failed'. Also check Worker BRIDGE_TOKEN, MC_BRIDGE Durable Object binding, and GitHub CLOUDFLARE_CONTROL_URL / CLOUDFLARE_BRIDGE_TOKEN."
    :"Waiting for the server's secure live connection before enabling safe controls.");
  const extras=proPanel(p,"Quick access");
  const links=proNode(extras,"div","dashboard-actions");
  for(const [label,id] of [["Server settings","settings"],["Online players","players"],["Live console","console"],["World backups","worlds"],["Files","files"],["Plugins","plugins"]]){
    links.append(proAction(label,()=>{tab=id;render()}));
  }
  javaJoinPanel(p);
  bedrockPanel(p);
  if(cloudState.warnings?.length)cloudState.warnings.forEach(w=>proNotice(p,w));
  if(cloudError)proNotice(p,"Status refresh failed; showing last known data: "+cloudError);
  proNode(p,"div","dashboard-meta","Live status refreshes automatically every 5 seconds while this page is open.");
};
playersPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Online players");
  const names=isBridgeLive()?cloudState.bridge.status.players||[]:[];
  const count=proNode(panel,"p","muted small",isBridgeLive()?names.length+" player(s) online right now.":"Waiting for the running server to connect.");
  count.id="online-player-count";
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
  accumulateConsole();
  const consoleBox=proNode(panel,"pre","console pro-console",consoleHistory.join("\n")||"No live output yet.");
  const form=proNode(panel,"form","console-command-row");
  const input=proField(form,"Type a server command, e.g. say Hello");
  input.autocomplete="off";
  input.value=sessionStorage.getItem(CONSOLE_DRAFT)||"";
  input.addEventListener("input",()=>{try{sessionStorage.setItem(CONSOLE_DRAFT,input.value)}catch{}});
  const send=proNode(form,"button","btn primary","Send");
  send.type="submit";send.disabled=!isBridgeLive();
  form.onsubmit=async e=>{
    e.preventDefault();
    const cmd=input.value.trim();
    if(!cmd || !isBridgeLive())return;
    if(cmd.length>240 || /[\r\n]/.test(cmd)){toast("Command is too long or contains a line break");return}
    input.value="";
    sessionStorage.removeItem(CONSOLE_DRAFT);
    send.disabled=true;
    const receipt="[You] /"+cmd+"  · sending…";
    consoleHistory.push(receipt);
    consoleHistory=consoleHistory.slice(-400);
    consoleBox.textContent=consoleHistory.join("\n");
    consoleBox.scrollTop=consoleBox.scrollHeight;
    try{
      const response=await cloudApi("live-command",{type:"console",args:{command:cmd}});
      const index=consoleHistory.lastIndexOf(receipt);
      const queued="[You] /"+cmd+"  · queued for server";
      if(index>=0)consoleHistory[index]=queued;
      if(response.id)pendingConsoleCommands.set(response.id,queued);
      toast("Command queued");
    }catch(error){
      const index=consoleHistory.lastIndexOf(receipt);
      if(index>=0)consoleHistory[index]="[You] /"+cmd+"  · not sent: "+error.message;
      input.value=cmd;
      sessionStorage.setItem(CONSOLE_DRAFT,cmd);
      toast(error.message);
    }finally{
      send.disabled=!isBridgeLive();
      consoleBox.textContent=consoleHistory.join("\n");
      consoleBox.scrollTop=consoleBox.scrollHeight;
      saveConsoleHistory()
    }
  };
  const performance=proPanel(p,"Performance diagnostics");
  proNode(performance,"p","muted small","Read-only commands that measure performance without deleting items, removing entities or throttling farms.");
  const diagnostics=proNode(performance,"div","dashboard-actions");
  for(const [label,command] of [
    ["TPS and tick times","spark tps"],
    ["Health report","spark health"],
    ["Recent lag incidents","perfincidents 5"],
    ["Performance status","perfstatus"]
  ]){
    diagnostics.append(proAction(label,()=>proCommand("console",{command}),"outline",!isBridgeLive()));
  }
  const history=cloudState.bridge?.history||[];
  const box=proPanel(p,"Recent command results");
  const recent=proNode(box,"div");recent.id="recent-command-results";
  history.slice(0,8).forEach(x=>proNode(recent,"div","small muted",(x.ok?"✓ ":"! ")+x.type+" · "+(typeof x.result==="string"?x.result:"Completed")));
};
function latestResult(type){
  return (cloudState?.bridge?.history||[]).find(x=>x.type===type&&x.ok&&x.result)||null;
}
// Keep the live file browser state across dashboard re-renders.
const fileManager={folder:"",entries:null,selected:"",editor:"",query:"",sort:"name",tree:null,treeLoading:false,expanded:{},
  busy:false,message:"",error:"",draftDirty:false,loading:false,selectedSize:0};
const fileJoin=(folder,name)=>folder?folder+"/"+name:name;
function fileBytes(n){
  if(!Number.isFinite(n))return "—";
  if(n<1024)return n+" B";
  if(n<1048576)return (n/1024).toFixed(1)+" KB";
  return (n/1048576).toFixed(2)+" MB";
}
async function fileTask(type,args={},quiet=false){
  if(!isBridgeLive())throw Error("Start the Minecraft server to access live files.");
  const request=await cloudApi("live-command",{type,args});
  if(!request?.id)throw Error("Server did not acknowledge the file operation");
  // Files execute on the GitHub runner, not in the Worker; wait for that
  // exact command acknowledgement to avoid displaying stale file results.
  for(let attempt=0;attempt<32;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1000));
    const live=await cloudApi("live");
    const result=(live.bridge?.history||[]).find(r=>r.id===request.id);
    if(result){
      if(!result.ok)throw Error(String(result.result||"File operation failed"));
      return result.result;
    }
  }
  throw Error("No server response yet. Refresh the folder before retrying.");
}
async function fileWork(operation,success){
  if(fileManager.busy)return;
  fileManager.busy=true;fileManager.error="";fileManager.message="Working on the server…";
  if(tab==="files")render();
  try{
    const result=await operation();
    fileManager.message=success||"Completed successfully";
    return result;
  }catch(e){
    fileManager.error=e.message||String(e);
    fileManager.message="";
    toast(fileManager.error);
    return undefined;
  }finally{
    fileManager.busy=false;
    if(tab==="files")render();
  }
}
async function fileOpenFolder(folder){
  if(fileManager.draftDirty && !confirm("Discard unsaved editor changes and open another folder?"))return;
  const result=await fileWork(()=>fileTask("files-list",{path:folder||"."}),"Folder loaded");
  if(!result)return;
  fileManager.folder=result.path==="."?"":result.path||"";
  fileManager.entries=result.entries||[];
  fileManager.truncated=!!result.truncated;
  fileManager.selected="";
  fileManager.editor="";
  fileManager.draftDirty=false;
  fileManager.message="";
  if(tab==="files")render();
}
async function fileOpenText(path){
  if(fileManager.draftDirty && fileManager.selected!==path &&
     !confirm("Discard unsaved changes to the current file?"))return;
  const result=await fileWork(()=>fileTask("files-read",{path}),"File opened");
  if(!result)return;
  fileManager.selected=path;
  fileManager.editor=String(result.content||"");
  fileManager.draftDirty=false;
  if(tab==="files")render();
}
async function fileSaveText(){
  const path=fileManager.selected;
  if(!path)return;
  const result=await fileWork(()=>fileTask("files-write",{path,content:fileManager.editor}),"Saved "+path);
  if(result===undefined)return;
  fileManager.draftDirty=false;
  // Preserve the last edited file while refreshing the containing folder.
  await fileRefresh(false);
}
async function fileLoadTree(){
  if(fileManager.treeLoading || !isBridgeLive())return;
  fileManager.treeLoading=true;
  try{
    const data=await fileTask("files-tree",{});
    fileManager.tree=Array.isArray(data.roots)?data.roots:[];
    // Open the top-level branches by default; the user can collapse them.
    for(const branch of fileManager.tree){
      if(fileManager.expanded[branch.path]===undefined)
        fileManager.expanded[branch.path]=true;
    }
    if(tab==="files")render();
  }catch(error){
    fileManager.error="Could not load server folder tree: "+error.message;
    fileManager.tree=[]; // Avoid automatic retry loops; Refresh retries explicitly.
  }finally{
    fileManager.treeLoading=false;
    if(tab==="files")render();
  }
}
function fileTreeNodes(parent,nodes,level=0){
  for(const node of nodes){
    const children=Array.isArray(node.children)?node.children:[];
    const row=proNode(parent,"div","file-tree-entry");
    row.style.paddingLeft=(level*13+3)+"px";
    if(children.length){
      const toggle=proNode(row,"button","file-tree-toggle",
        fileManager.expanded[node.path]?"▾":"▸");
      toggle.type="button";toggle.title="Expand or collapse";
      toggle.onclick=()=>{
        fileManager.expanded[node.path]=!fileManager.expanded[node.path];
        render();
      };
    }else proNode(row,"span","file-tree-no-toggle","·");
    const button=proNode(row,"button","file-tree-link"+(fileManager.folder===node.path?" current":""),
      "📁 "+node.name);
    button.type="button";button.disabled=!isBridgeLive()||fileManager.busy;
    button.onclick=()=>fileOpenFolder(node.path);
    if(children.length && fileManager.expanded[node.path])
      fileTreeNodes(parent,children,level+1);
  }
}
async function fileRefresh(keepSelection=true){
  const folder=fileManager.folder;
  const selected=fileManager.selected;
  const editor=fileManager.editor;
  const dirty=fileManager.draftDirty;
  const result=await fileWork(()=>fileTask("files-list",{path:folder||"."}),"Folder refreshed");
  if(!result)return;
  fileManager.entries=result.entries||[];
  fileManager.truncated=!!result.truncated;
  if(keepSelection){fileManager.selected=selected;fileManager.editor=editor;fileManager.draftDirty=dirty;}
  if(tab==="files")render();
}
function fileDownload(name,content){
  const binary=atob(content);
  const data=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)data[i]=binary.charCodeAt(i);
  const blob=new Blob([data],{type:"application/octet-stream"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
filesPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const live=isBridgeLive(), fm=fileManager;
  const panel=proPanel(p,"Server files");
  proNode(panel,"p","muted small","Browse the actual running Paper server. Changes persist through verified backups after a safe shutdown.");
  if(!live)proNotice(panel,"The server must be online for live file access. The last folder list may be out of date.");
  const toolbar=proNode(panel,"div","dashboard-actions file-toolbar");
  toolbar.append(proAction("⌂ Root",()=>fileOpenFolder(""),"outline",!live||fm.busy));
  toolbar.append(proAction("↑ Up",()=>fileOpenFolder(fm.folder.split("/").slice(0,-1).join("/")),"outline",!live||fm.busy||!fm.folder));
  toolbar.append(proAction("⟳ Refresh",async()=>{
    fm.tree=null;
    await fileLoadTree();
    await fileRefresh();
  },"outline",!live||fm.busy));
  toolbar.append(proAction("+ New folder",async()=>{
    const name=prompt("New folder name (inside "+(fm.folder||"server root")+"):");
    if(!name)return;
    if(!/^[A-Za-z0-9_ ()+@,.-]{1,80}$/.test(name)||name==="."||name===".."||name.includes("/")){
      toast("Use a simple folder name without slashes");return;
    }
    const result=await fileWork(()=>fileTask("files-mkdir",{path:fileJoin(fm.folder,name)}),"Folder created");
    if(result!==undefined)await fileRefresh();
  },"outline",!live||fm.busy));
  const upload=proNode(toolbar,"input","file-native-input");upload.type="file";
  upload.id="server-file-upload";
  const choose=proNode(toolbar,"label","btn primary file-pick-button","⬆ Upload files");
  choose.setAttribute("for",upload.id);
  choose.title="Choose text or configuration files to upload";
  upload.accept=".txt,.json,.yml,.yaml,.properties,.cfg,.conf,.toml,.md,.log";
  upload.multiple=true;upload.disabled=!live||fm.busy;upload.title="Upload UTF-8 text/config files (256 KiB maximum each)";
  upload.onchange=async()=>{
    const selected=[...(upload.files||[])];
    if(!selected.length)return;
    for(const file of selected){
      if(file.size>262144){toast(file.name+": maximum 256 KiB");continue}
      if(!/\.(txt|json|yml|yaml|properties|cfg|conf|toml|md|log)$/i.test(file.name)){
        toast(file.name+": only text/config files are supported");continue;
      }
      const bytes=new Uint8Array(await file.arrayBuffer());
      try{new TextDecoder("utf-8",{fatal:true}).decode(bytes)}
      catch{toast(file.name+": not UTF-8 text");continue}
      let binary="";
      for(let i=0;i<bytes.length;i+=8192)
        binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const target=fileJoin(fm.folder,file.name);
      const result=await fileWork(()=>fileTask("files-upload",{path:target,content:btoa(binary)}),"Uploaded "+file.name);
      if(result===undefined)break;
    }
    upload.value="";
    await fileRefresh();
  };
  const crumb=proNode(panel,"nav","file-breadcrumb");
  const segments=fm.folder?fm.folder.split("/"):[];
  const root=proNode(crumb,"button","file-crumb","Server");
  root.type="button";root.disabled=!live||fm.busy;root.onclick=()=>fileOpenFolder("");
  segments.forEach((segment,i)=>{
    proNode(crumb,"span","muted","/");
    const node=proNode(crumb,"button","file-crumb",segment);
    node.type="button";node.disabled=!live||fm.busy;
    node.onclick=()=>fileOpenFolder(segments.slice(0,i+1).join("/"));
  });
  const layout=proNode(panel,"div","file-explorer-layout");
  const tree=proNode(layout,"aside","file-tree");
  proNode(tree,"div","file-tree-heading","SERVER DIRECTORY");
  const treeRoot=proNode(tree,"button","file-tree-root"+(!fm.folder?" current":""),"🖥️  Server root");
  treeRoot.type="button";treeRoot.disabled=!live||fm.busy;
  treeRoot.onclick=()=>fileOpenFolder("");
  if(fm.tree)fileTreeNodes(tree,fm.tree);
  else proNode(tree,"p","muted small","Loading folder structure…");
  const explorer=proNode(layout,"div","file-explorer-main");
  const tools=proNode(explorer,"div","file-list-tools");
  const filter=proField(tools,"Search files in this folder");
  filter.value=fm.query;
  filter.oninput=()=>{
    fm.query=filter.value;
    explorer.querySelectorAll(".file-entry").forEach(row=>{
      row.hidden=!row.dataset.name.includes(fm.query.toLowerCase());
    });
  };
  const sort=proNode(tools,"select");sort.title="Sort files";
  for(const [value,label] of [["name","Name"],["size","Size"],["date","Modified"]]){
    const option=proNode(sort,"option","",label);option.value=value;
  }
  sort.value=fm.sort;sort.onchange=()=>{fm.sort=sort.value;render()};
  if(fm.busy)proNode(panel,"p","muted small","⏳ "+fm.message);
  if(fm.error)proNotice(panel,fm.error);
  if(!fm.entries && !fm.loading && live){
    fm.loading=true;
    fileOpenFolder(fm.folder).finally(()=>{fm.loading=false});
  }
  if(!fm.tree && !fm.treeLoading && live)fileLoadTree();
  if(!fm.entries)proNode(explorer,"div","file-empty",live?"Loading live server files…":"Start the server to browse its files.");
  else{
    let entries=fm.entries.filter(item=>item.name.toLowerCase().includes(fm.query.toLowerCase()));
    entries.sort((a,b)=>{
      if(a.type!==b.type)return a.type==="dir"?-1:1;
      if(fm.sort==="size")return (b.size||0)-(a.size||0)||a.name.localeCompare(b.name);
      if(fm.sort==="date")return (b.modified||0)-(a.modified||0)||a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name,undefined,{sensitivity:"base",numeric:true});
    });
    const head=proNode(explorer,"div","file-list-header");
    proNode(head,"span","","Name");
    proNode(head,"span","","Size");
    proNode(head,"span","","Modified");
    proNode(head,"span","","Actions");
    const table=proNode(explorer,"div","file-list");
    for(const item of entries){
      const row=proNode(table,"div","file-entry");
      row.dataset.name=item.name.toLowerCase();
      const name=proNode(row,"button","file-entry-name",item.type==="dir"?"📁  "+item.name:"📄  "+item.name);
      name.type="button";name.disabled=!live||fm.busy;
      name.onclick=()=>item.type==="dir"?fileOpenFolder(item.path):fileOpenText(item.path);
      proNode(row,"span","file-entry-meta",item.type==="dir"?"Folder":fileBytes(item.size));
      proNode(row,"span","file-entry-meta",item.modified?new Date(item.modified).toLocaleDateString():"—");
      const actions=proNode(row,"div","file-entry-actions");
      if(item.type==="file"){
        actions.append(proAction("Download",async()=>{
          const file=await fileWork(()=>fileTask("files-download",{path:item.path}),"Downloaded "+item.name);
          if(file?.encoding==="base64")fileDownload(item.name,file.content);
        },"outline",!live||fm.busy||(item.size||0)>262144));
      }
      actions.append(proAction("Rename",async()=>{
        const name=prompt("Rename "+item.name+" to:",item.name);
        if(!name||name===item.name)return;
        if(!/^[A-Za-z0-9_ ()+@,.-]{1,80}$/.test(name)||name==="."||name===".."){
          toast("Invalid name");return;
        }
        const result=await fileWork(()=>fileTask("files-rename",{path:item.path,target:fileJoin(fm.folder,name)}),"Renamed "+item.name);
        if(result!==undefined)await fileRefresh(false);
      },"outline",!live||fm.busy));
      if(item.type==="file")actions.append(proAction("Delete",async()=>{
        if(!confirm("Delete "+item.path+" from the running server? It can only be recovered from an older verified backup."))return;
        const result=await fileWork(()=>fileTask("files-delete",{path:item.path}),"Deleted "+item.name);
        if(result!==undefined)await fileRefresh(false);
      },"danger",!live||fm.busy));
    }
    if(!entries.length)proNode(table,"div","file-empty",fm.query?"No matching files":"This folder is empty.");
    if(fm.truncated)proNotice(explorer,"Only the first 500 entries are shown. Narrow down the folder or use another directory.");
    proNode(explorer,"div","muted small",entries.length+" entries · "+(fm.folder||"Server root"));
  }
  if(fm.selected){
    const editor=proPanel(p,"Edit · "+fm.selected);
    const text=proNode(editor,"textarea","file-text-editor");
    text.value=fm.editor;text.spellcheck=false;
    text.readOnly=!live||fm.busy;
    text.oninput=()=>{fm.editor=text.value;fm.draftDirty=true};
    const actions=proNode(editor,"div","dashboard-actions");
    actions.append(proAction(fm.draftDirty?"Save changes *":"Save changes",fileSaveText,"primary",!live||fm.busy));
    actions.append(proAction("Download",()=>{
      const blob=new Blob([fm.editor],{type:"text/plain;charset=utf-8"});
      const url=URL.createObjectURL(blob);const link=document.createElement("a");
      link.href=url;link.download=fm.selected.split("/").pop();link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
    },"outline"));
    actions.append(proAction("Close editor",()=>{
      if(fm.draftDirty&&!confirm("Discard unsaved changes?"))return;
      fm.selected="";fm.editor="";fm.draftDirty=false;render();
    },"outline"));
    proNotice(editor,"Live file editing supports UTF-8 text up to 256 KiB. Use Server Settings to edit server.properties.");
  }
  proNotice(p,"Safety: world/player files and private credentials cannot be modified here. Binary and large files need offline backup/restore tools. A save or upload is durable only after the next successful verified server backup.");
};
pluginsPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Plugin manager");
  proNode(panel,"p","muted small","Upload, enable, disable, or remove Paper plugins. Changes take effect after a safe server restart.");
  const picker=proNode(panel,"div","file-pick-area");
  const input=proNode(picker,"input","file-native-input");input.type="file";input.accept=".jar";
  input.id="plugin-jar-upload";
  const choosePlugin=proNode(picker,"label","btn outline file-pick-button","＋ Select plugin JAR");
  choosePlugin.setAttribute("for",input.id);
  const selectedName=proNode(picker,"span","muted small","No plugin selected");
  input.onchange=()=>{selectedName.textContent=input.files?.[0]?.name||"No plugin selected"};
  const row=proNode(panel,"div","dashboard-actions");
  row.append(proAction("Upload plugin",async()=>{
    const file=input.files?.[0];
    if(!file){proToast("Select a .jar plugin first");return}
    if(!file.name.endsWith(".jar")){proToast("Only .jar plugins are accepted");return}
    if(file.size>5*1024*1024){proToast("This uploader supports plugin files up to 5 MiB.");return}
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    await cloudAction("plugin-upload",{name:file.name,content:btoa(binary)});
  },"primary"));
  row.append(proAction("Refresh plugin list",async()=>{
    try{
      window.mcPlugins=(await cloudApi("plugin-list",{})).plugins;
      render();
    }catch(e){proToast(e.message)}
  }));
  if(!window.mcPlugins && !window.mcPluginsLoading){
    window.mcPluginsLoading=true;
    cloudApi("plugin-list",{}).then(data=>{
      window.mcPlugins=data.plugins;
      if(tab==="plugins")render();
    }).catch(err=>toast(err.message)).finally(()=>window.mcPluginsLoading=false);
  }
  if(!window.mcPlugins)proNode(panel,"p","muted small","Loading installed and managed plugins…");
  for(const plugin of window.mcPlugins||[]){
    const item=proNode(panel,"div","backup-row");
    const left=proNode(item,"div");
    proNode(left,"strong","",plugin.name);
    proNode(left,"div","muted small",plugin.managed?"Included with server · "+(plugin.enabled?"Enabled":"Disabled"):(Math.round(plugin.size/1024)+" KiB"));
    item.append(proAction(plugin.enabled===false?"Enable":"Disable",async()=>{
      try{
        await cloudApi("plugin-toggle",{name:plugin.name,enabled:plugin.enabled===false});
        window.mcPlugins=(await cloudApi("plugin-list",{})).plugins;
        toast("Plugin change saved. Restart the server to apply.");
        render();
      }catch(e){toast(e.message)}
    },"outline"));
    if(!plugin.managed)item.append(proAction("Remove",async()=>{
      await cloudAction("plugin-remove",{name:plugin.name},"Remove "+plugin.name+" at the next restart?");
      window.mcPlugins=(await cloudApi("plugin-list",{})).plugins;render();
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
const backupsPage=worldsPage;
worldsPage=function(p){
  backupsPage(p);
  if(!cloudState)return;
  const box=proPanel(p,"Restore a saved world");
  proNode(box,"p","muted small","Choose a verified snapshot to restart the server with that world. Restoring an older snapshot replaces newer world progress. The server must be fully stopped first.");
  const canRestore=!cloudState.active.length;
  if(!cloudState.backups?.length)proNode(box,"p","muted","There are no verified backups to restore yet.");
  for(const backup of cloudState.backups||[]){
    const row=proNode(box,"div","backup-row");
    const info=proNode(row,"div");
    proNode(info,"strong","",new Date(backup.created_at).toLocaleString());
    proNode(info,"div","muted small",(backup.size_in_bytes/1048576).toFixed(1)+" MiB");
    row.append(proAction("Restore this backup",()=>cloudAction("restore",{run_id:backup.run_id},"Restore this saved world? Any newer world progress will be replaced. The server will start after restoration."),"outline",!canRestore));
  }
};
const previousAbout=aboutPage;
aboutPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Connections");
  for(const [k,v] of [["Server link",isBridgeLive()?"Connected":"Waiting for server"],["Version","Paper 26.3"],["Auto refresh","Every 5 seconds"],["Saved snapshots",String(cloudState.backups?.length||0)],["Server power",cloudState.bridge?.desired==="off"?"Off":"On"]]){
    const row=proNode(panel,"div","rowsetting");
    proNode(row,"strong","",k);proNode(row,"span","muted small",v);
  }
  javaJoinPanel(p);
  bedrockPanel(p,true);
  panel.append(proAction("Disconnect dashboard",()=>{
    cloudPassword="";cloudState=null;sessionStorage.removeItem("mccloud-admin");render();
  },"danger"));
};
// Server-first settings: supported values apply on the next safe start.
settingsPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Server configuration");
  proNode(panel,"p","muted small","Adjust your world, gameplay and network options below. Save them to apply automatically when the server next starts.");
  const buttons=proNode(panel,"div","dashboard-actions");
  const supported=["motd","max-players","difficulty","gamemode","pvp","allow-flight","white-list","enforce-whitelist","online-mode","enable-command-block","spawn-protection","view-distance","simulation-distance","max-world-size","allow-nether","spawn-monsters","spawn-animals","spawn-npcs","hardcore","force-gamemode","player-idle-timeout"];
  buttons.append(proAction("Save server settings",()=>cloudAction("settings",{properties:Object.fromEntries(supported.map(k=>[k,settings[k]]))},"Save the new configuration? It applies after the server starts again."),"primary"));
  buttons.append(proAction("Load saved configuration",()=>{
    if(!cloudState.properties){proToast("No saved server configuration is available");return}
    for(const line of cloudState.properties.split(/\r?\n/)){
      const index=line.indexOf("=");
      if(index<1||line.startsWith("#"))continue;
      const key=line.slice(0,index),raw=line.slice(index+1);
      const spec=schema.find(x=>x[0]===key);
      if(!spec||!supported.includes(key))continue;
      if(spec[3]==="bool")settings[key]=raw==="true";
      else if(spec[3]==="number" && Number.isFinite(Number(raw)))settings[key]=Number(raw);
      else if(spec[3]!=="number")settings[key]=raw;
    }
    persist();render();proToast("Saved configuration loaded");
  },"outline",!cloudState.properties));
  proNode(panel,"p","muted small","Online authentication stays enabled. Minecraft listens on its configured tunnel port. Some changes require a restart.");
  previewSettings(p);
  p.prepend(panel);
};
worldsPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const panel=proPanel(p,"Worlds & backups");
  proNode(panel,"p","muted small","Your world, player inventories and progress are preserved in verified snapshots after a clean shutdown.");
  const controls=proNode(panel,"div","dashboard-actions");
  controls.append(proAction("Save world",()=>proCommand("save"),"outline",!isBridgeLive()));
  controls.append(proAction("Save & restart",()=>proCommand("restart",{},"Save and restart the server, creating a verified backup?"),"primary",!isBridgeLive()));
  controls.append(proAction("Refresh backups",()=>cloudRefresh(true)));
  const backups=cloudState.backups||[];
  if(!backups.length)proNode(panel,"p","muted","No verified backup has been uploaded yet.");
  for(const item of backups){
    const row=proNode(panel,"div","backup-row");
    const info=proNode(row,"div");
    proNode(info,"strong","",new Date(item.created_at).toLocaleString());
    proNode(info,"div","muted small",(item.size_in_bytes/1048576).toFixed(1)+" MiB · Saved world");
    const actions=proNode(row,"div","flex");
    proLink(actions,"View backup","https://github.com/majoodsaod-spec/minecraft-cloud-control/actions/runs/"+item.run_id);
    actions.append(proAction("Restore",()=>cloudAction("restore",{run_id:item.run_id},"Replace the current saved world with this older backup and start the server? Newer progress will be lost."),"outline",cloudState.active.length>0));
  }
  proNotice(p,"To restore an older snapshot, safely stop the server and wait until the backup upload finishes. Never cancel a running save.");
};
function updateServerDisplay(){
  if(!cloudState)return;
  const livePhase=serverPhase();
  const badge=document.querySelector(".top .badge");
  if(badge){
    badge.replaceChildren();
    proNode(badge,"span","dot");
    badge.append(document.createTextNode(" "+phaseInfo[livePhase][0]));
  }
  if(tab==="overview"){
    lastRenderedServerPhase=livePhase;
    const title=document.querySelector(".server-title");
    const state=document.querySelector(".server-state");
    const description=document.querySelector(".server-header .muted");
    const progress=document.querySelector(".server-progress-fill");
    if(title)title.textContent=phaseInfo[livePhase][0];
    if(description)description.textContent=phaseInfo[livePhase][1];
    if(state){state.textContent=phaseInfo[livePhase][0];state.className="server-state "+phaseInfo[livePhase][2]}
    if(progress){
      progress.style.width=phaseInfo[livePhase][3]+"%";
      progress.classList.toggle("progress-flow",["shutdown_requested","saving","stopping","backing_up","finishing","starting"].includes(livePhase));
    }
    updateLiveMetrics();
  }
  accumulateConsole();
  if(tab==="console"){
    for(const ack of cloudState.bridge?.history||[]){
      const queued=pendingConsoleCommands.get(ack.id);
      if(!queued)continue;
      const index=consoleHistory.lastIndexOf(queued);
      if(index>=0){
        const result=typeof ack.result==="string"?" · "+ack.result:"";
        consoleHistory[index]=queued.replace("queued for server",ack.ok?"sent to Paper":"failed")+result;
      }
      pendingConsoleCommands.delete(ack.id);
      saveConsoleHistory();
    }
    const consoleBox=document.querySelector(".pro-console");
    if(consoleBox){
      const nearEnd=consoleBox.scrollHeight-consoleBox.scrollTop-consoleBox.clientHeight<50;
      consoleBox.textContent=consoleHistory.join("\n")||"No live output yet.";
      if(nearEnd)consoleBox.scrollTop=consoleBox.scrollHeight;
    }
    const list=document.getElementById("recent-command-results");
    if(list){
      list.replaceChildren();
      for(const record of (cloudState.bridge?.history||[]).slice(0,8)){
        const result=typeof record.result==="string"?record.result:"Completed";
        proNode(list,"div","small muted",(record.ok?"✓ ":"! ")+record.type+" · "+result);
      }
    }
  }
  if(tab==="files"){
    const command=(cloudState.bridge?.history||[]).find(x=>x.type?.startsWith("files-"));
    if(command && command.id!==lastRenderedFileResult){
      lastRenderedFileResult=command.id;
      const feedback=document.getElementById("file-operation-status");
      if(feedback)feedback.textContent=(command.ok?"Completed: ":"Failed: ")+command.type+
        (typeof command.result==="string"?" — "+command.result:"");
      // File manager changes are displayed on explicit Open/Browse actions, not by
      // destroying a possibly unsaved text editor during background polling.
    }
  }
  if(tab==="players"){
    lastRenderedPlayers=(cloudState.bridge?.status?.players||[]).join(",");
    const current=document.getElementById("online-player-count");
    if(current)current.textContent=isBridgeLive()?
      (cloudState.bridge.status.players||[]).length+" player(s) online right now.":
      "Waiting for the running server to connect.";
    // Preserve moderation input and menu state during polling.
  }
}
const previousRefresh=cloudRefresh;
cloudRefresh=async function(notify=false){
  await previousRefresh(notify);
  updateServerDisplay();
};
let liveRefreshPending=false;
async function cloudLiveRefresh(){
  if(!cloudPassword||!cloudState||cloudRefreshing||cloudBusy||liveRefreshPending)return;
  liveRefreshPending=true;
  try{
    const result=await cloudApi("live");
    cloudState.bridge=result.bridge;
    cloudLastUpdate=Date.now();
    updateServerDisplay();
  }catch(error){
    cloudError=error.message;
    if(/Unauthorized/i.test(cloudError)){
      cloudState=null;cloudPassword="";
      sessionStorage.removeItem("mccloud-admin");
      render();
    }
  }finally{liveRefreshPending=false}
}
window.setInterval(()=>{if(cloudPassword&&!document.hidden && (tab==="console" || Date.now()-(window.mcLastLivePoll||0)>=5000)){
  window.mcLastLivePoll=Date.now();
  cloudLiveRefresh();
}},1000);
window.setInterval(()=>{if(cloudPassword&&!document.hidden)updateLiveMetrics()},1000);
render();
