"use strict";
const invoke=(command,args={})=>window.__TAURI__.core.invoke(command,args);
const $=sel=>document.querySelector(sel);
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const when=value=>value?new Date(value).toLocaleString():"—";
const ago=value=>{const n=Date.now()-new Date(value).getTime();if(!Number.isFinite(n))return "Unknown";const m=Math.max(0,Math.floor(n/60000));return m<1?"Just now":m<60?m+" min ago":m<1440?Math.floor(m/60)+" hr ago":Math.floor(m/1440)+" days ago";};
const bytes=n=>!Number.isFinite(+n)?"—":(+n/1048576).toFixed(1)+" MB";
const duration=s=>{s=Math.max(0,Math.floor(Number(s)||0));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(x=>String(x).padStart(2,"0")).join(":");};
const activeRun=r=>["in_progress","queued","waiting","requested","pending"].includes(r?.status);
const isServer=r=>(r?.name||"").includes("Continuous Paper Minecraft Server")||(r?.path||"").includes("paper-state-test.yml");
const state={page:"overview",github:{connected:false},overview:null,cloud:null,cloudError:null,direct:null,directError:null,directFetchedAt:0,directStreamConnected:false,cloudFetchedAt:0,netbirdAuto:null,directPeerConfig:null,workflows:null,runs:null,file:null,filePath:"server/server.properties",fileDirty:false,lastFetch:0,busy:false,toastTimer:null,githubLog:null,githubLogInfo:null,githubLogError:null,logBusy:false,logFetchedAt:0,update:null,updateChecking:false,drafts:Object.create(null)};
function flash(text){const box=$("#toast");box.textContent=text;box.classList.add("show");clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>box.classList.remove("show"),4300)}
function btn(label,action="refresh",cls=""){return `<button class="btn ${cls}" data-action="${action}">${label}</button>`}
function boxEmpty(title,body,icon="◇"){return `<div class="empty"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${body}</p></div>`}
function header(kicker,title,desc,actions=""){return `<div class="page-header"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="header-actions">${actions}</div></div>`}
function panel(title,body,right=""){return `<section class="panel"><div class="panel-head"><h2 class="panel-title">${title}</h2>${right}</div>${body}</section>`}
function notice(text,good=false){return `<div class="notice ${good?"good":""}">${text}</div>`}
function pill(text,kind="muted"){return `<span class="pill ${kind}">${text}</span>`}
function stat(label,value,detail,icon,id=""){return `<div class="card"><div class="stat-mark"><span class="stat-label">${label}</span><em>${icon}</em></div><div class="stat-value" ${id?`data-live="${id}"`:""}>${esc(value)}</div><div class="stat-sub">${detail}</div></div>`}
function errorText(error){return String(error||"Unknown error").replace(/^Error:\s*/,"").slice(0,280)}
async function run(command,args,{quiet=false}={}){try{return await invoke(command,args)}catch(e){if(!quiet)flash(errorText(e));throw e}}
function dialog(title,text,actions){
  $("#dialog").innerHTML=`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="dialog-footer"><button class="btn" id="dialogCancel">Cancel</button><button class="btn primary" id="dialogConfirm">Continue</button></div>`;
  $("#dialogBackdrop").classList.remove("hidden");$("#dialogBackdrop").setAttribute("aria-hidden","false");
  return new Promise(resolve=>{
    const done=bool=>{$("#dialogBackdrop").classList.add("hidden");$("#dialogBackdrop").setAttribute("aria-hidden","true");resolve(bool);};
    $("#dialogCancel").onclick=()=>done(false);$("#dialogConfirm").onclick=()=>done(true);
  });
}
function updateMessage(message,kind="info"){
  state.updateMessage=message;
  state.updateMessageKind=kind;
  syncUpdateButton();
  const label=$("#updateStatus");
  if(label)label.textContent=message;
  const details=$("#updateStatusConnections");
  if(details)details.textContent=message;
}
function updateBuildMessage(update){
  if(update.available)return "Build #"+update.runNumber+" is ready to install.";
  if(Number(update.latestAttemptNumber||0)>Number(update.runNumber||0)){
    const status=String(update.latestAttemptStatus||"unknown").replaceAll("_"," ");
    return "Newest build #"+update.latestAttemptNumber+" "+status+" · latest installable build #"+update.runNumber;
  }
  return "Already up to date · build #"+update.runNumber;
}
function syncUpdateButton(){
  const button=$("#quickUpdate");
  if(!button)return;
  const available=Boolean(state.update?.available);
  button.disabled=false;
  $("#updateIndicator").hidden=!available;
  $("#quickUpdateLabel").textContent=state.updateChecking?"Updating…":available?"Install update":"Quick Update";
  button.title=state.updateMessage||"Check for the latest Windows build and install it";
  button.setAttribute("aria-busy",state.updateChecking?"true":"false");
  const label=$("#updateStatus");
  if(label)label.textContent=state.updateMessage||"";
  const details=$("#updateStatusConnections");
  if(details)details.textContent=state.updateMessage||"";
}
async function checkDesktopUpdate(silent=false){
  if(!state.github.connected){
    if(!silent)updateMessage("Connect GitHub under Connections to enable updates.","error");
    return null;
  }
  if(state.updateChecking){
    if(!silent)updateMessage("An update check is already running.","info");
    return null;
  }
  state.updateChecking=true;
  if(!silent)updateMessage("Checking GitHub for the newest Windows installer…");
  else syncUpdateButton();
  try{
    const update=await run("desktop_check_update",{}, {quiet:true});
    state.update=update;
    if(!silent || !update.available && Number(update.latestAttemptNumber||0)>Number(update.runNumber||0)){
      updateMessage(updateBuildMessage(update),update.available?"success":"info");
    }
    return update;
  }catch(e){
    if(!silent)updateMessage("Update check failed: "+errorText(e),"error");
    return null;
  }finally{
    state.updateChecking=false;
    syncUpdateButton();
    if(state.page==="connections"&&!editing())render();
  }
}
async function quickUpdate(){
  if(state.updateChecking){
    updateMessage("An update operation is already running.");
    return;
  }
  if(!state.github.connected){
    updateMessage("Connect GitHub under Connections before updating.","error");
    state.page="connections";render();
    return;
  }
  const update=await checkDesktopUpdate(false);
  if(!update||!update.available)return;
  if(!await dialog("Install Minecraft Cloud update?",
    "Build #"+update.runNumber+" ("+update.commit+"). Download the latest successful installer from GitHub and upgrade the app? Your saved connections and Minecraft world will not be changed.")){
    updateMessage("Installation cancelled.");
    return;
  }
  state.updateChecking=true;
  updateMessage("Preparing the Windows installer…");
  try{
    await run("desktop_install_update",{expectedBuild:update.latestBuild},{quiet:true});
    updateMessage("Installer launched. Follow the Windows prompts.","success");
  }catch(e){
    updateMessage("Update failed: "+errorText(e),"error");
  }finally{
    state.updateChecking=false;
    syncUpdateButton();
  }
}
// One monotonic, local clock per Paper session. Reconnects must not rewind.
const liveClock={session:null,uptimeBase:0,emptyBase:0,at:0,players:0,lastUptime:0,lastEmpty:0};
function observeLiveClock(sample,receivedAt=Date.now()){
  if(!sample?.session||!sample.ready)return;
  const fresh=liveClock.session!==sample.session;
  const uptime=Math.max(0,Math.floor(Number(sample.uptime)||0));
  const empty=Math.max(0,Math.floor(Number(sample.emptyFor)||0));
  const players=Array.isArray(sample.players)?sample.players.length:0;
  if(fresh){
    Object.assign(liveClock,{session:sample.session,uptimeBase:uptime,emptyBase:players?0:empty,at:receivedAt,players,lastUptime:uptime,lastEmpty:players?0:empty});
    return;
  }
  const elapsed=Math.max(0,Math.floor((receivedAt-liveClock.at)/1000));
  liveClock.uptimeBase=Math.max(uptime,liveClock.uptimeBase+elapsed,liveClock.lastUptime);
  liveClock.lastUptime=liveClock.uptimeBase;
  if(players!==liveClock.players){
    liveClock.emptyBase=players?0:empty;
    liveClock.lastEmpty=liveClock.emptyBase;
  }else if(!players){
    liveClock.emptyBase=Math.max(empty,liveClock.emptyBase+elapsed,liveClock.lastEmpty);
    liveClock.lastEmpty=liveClock.emptyBase;
  }else{
    liveClock.emptyBase=0;liveClock.lastEmpty=0;
  }
  liveClock.players=players;liveClock.at=receivedAt;
}
function directOnline(){
  const d=state.direct;
  return Boolean(d?.session&&d.ready&&Date.now()-state.directFetchedAt<15000);
}
function currentPaper(){
  return directOnline()?state.direct:state.cloud?.bridge?.status||{};
}
function liveSampleAge(){
  const received=directOnline()?state.directFetchedAt:state.cloudFetchedAt;
  return received?Math.max(0,(Date.now()-received)/1000):0;
}
function interpolatedPaperSeconds(field){
  if(!liveClock.session)return connectedLive()?0:null;
  const elapsed=Math.max(0,Math.floor((Date.now()-liveClock.at)/1000));
  return field==="emptyFor"?(liveClock.players?0:liveClock.emptyBase+elapsed):liveClock.uptimeBase+elapsed;
}
function tickLiveUI(){
  if(document.visibilityState!=="visible")return;
  const uptime=document.querySelector('[data-live="uptime"]');
  const empty=document.querySelector('[data-live="empty"]');
  const runner=document.querySelector('[data-live="runner"]');
  if(uptime)uptime.textContent=liveClock.session?duration(interpolatedPaperSeconds("uptime")):"—";
  if(empty)empty.textContent=liveClock.session?duration(interpolatedPaperSeconds("emptyFor")):"—";
  if(runner){
    const main=latestServerRun();
    const started=main&&(main.run_started_at||main.created_at);
    runner.textContent=activeRun(main)&&started?duration((Date.now()-new Date(started).getTime())/1000):"—";
  }
}
function updateConsoleOutput(){
  if(state.page!=="console")return;
  const terminal=$("#terminal");
  if(!terminal)return;
  const transport=$("#consoleTransport");
  if(transport){
    const mode=consoleTransport();
    if(transport.textContent!==mode)transport.textContent=mode;
  }
  const online=connectedLive(),logs=currentPaper().logs||[];
  const githubFallback=!online&&state.github.connected;
  const content=online&&logs.length?logs.map(line=>{
    const cls=/\b(ERROR|Exception|failed)\b/i.test(line)?"error":/\b(INFO|Done|joined)\b/i.test(line)?"info":"";
    return `<div class="${cls}">${esc(line)}</div>`;
  }).join(""):githubFallback&&state.githubLog?`<span class="dim">GitHub Actions logs (may be delayed; read-only)</span>\n${esc(state.githubLog)}`:`<span class="dim">${esc(state.githubLogError||"No Paper live console. GitHub job logs are available below when GitHub publishes them.")}</span>`;
  if(terminal.innerHTML===content)return;
  const bottom=terminal.scrollHeight-terminal.scrollTop-terminal.clientHeight<70;
  terminal.innerHTML=content;
  if(bottom)terminal.scrollTop=terminal.scrollHeight;
  // Never replace a focused command input or a partially typed command.
  const input=$("#commandText");
  if(input)input.disabled=!online;
  const send=document.querySelector("#consoleForm button");
  if(send)send.disabled=!online;
}
function connectedLive(){
  // Direct HTTP success is authenticated and timed at receipt by this PC;
  // comparing against the Linux runner's wall clock can incorrectly mark a
  // healthy session offline when the machines' clocks differ.
  if(directOnline())return true;
  const live=state.cloud?.bridge?.status||{};
  return Boolean(live.session&&live.ready&&Date.now()-(live.updatedAt||0)<45000);
}
async function loadNetbirdAuto(){
  try{state.netbirdAuto=await invoke("netbird_auto_status");}catch{}
}
async function loadDirectPeerConfig(){
  try{state.directPeerConfig=await invoke("direct_peer_config");}
  catch{state.directPeerConfig=null;}
}
let pendingDirectStatus=null;
async function loadDirect(quiet=true){
  // Fast UI refresh and the slower GitHub refresh used to launch overlapping
  // private requests every 4/12 seconds, especially while NetBird wakes an
  // idle peer. Share one in-flight probe instead.
  if(state.directStreamConnected)return;
  if(pendingDirectStatus)return pendingDirectStatus;
  pendingDirectStatus=(async()=>{
    try{state.direct=await run("direct_status",{}, {quiet});state.directFetchedAt=Date.now();state.directError=null;observeLiveClock(state.direct,state.directFetchedAt);}
    catch(err){state.directError=errorText(err);state.directStreamConnected=false;}
  })();
  try{return await pendingDirectStatus;}
  finally{pendingDirectStatus=null;}
}
async function sendPaper(kind,args={}){
  if(directOnline())return run("direct_command",{kind,args});
  if(!connectedLive())throw Error("Neither NetBird direct control nor Cloudflare bridge is online.");
  if(kind==="console")return run("cloudflare_console",{command:args.command});
  return run("cloudflare_command",{kind});
}
function latestServerRun(){return (state.overview?.runs||[]).find(r=>isServer(r))||null}
function runRow(r,withCancel=false){
  const label=activeRun(r)?"Running":r.conclusion==="success"?"Successful":r.conclusion==="failure"?"Failed":r.conclusion||r.status||"Unknown";
  const cls=activeRun(r)?"pending":r.conclusion==="failure"?"failed":"";
  const buttons=`<button class="btn small flat" data-action="jobs" data-id="${Number(r.id)}">Details</button>`+
    (withCancel&&activeRun(r)&&!isServer(r)?`<button class="btn small danger" data-action="cancel" data-id="${Number(r.id)}">Cancel</button>`:"");
  return `<div class="run"><div class="run-icon ${cls}">${cls==="failed"?"!":activeRun(r)?"↻":"✓"}</div><div class="run-content"><strong>${esc(r.display_title||r.name||"GitHub workflow")}</strong><span>${esc(r.name||"")} · ${esc(ago(r.created_at))} · #${esc(r.run_number||r.id)}</span></div><span class="run-status ${cls}">${esc(label)}</span><span class="row-buttons">${buttons}</span></div>`;
}
function drawOverview(){
  const main=latestServerRun(),live=currentPaper(),online=connectedLive();
  const github=state.github.connected;
  const runnerStarted=main&&(main.run_started_at||main.created_at);
  const runnerElapsed=activeRun(main)&&runnerStarted
    ?Math.max(0,Math.floor((Date.now()-new Date(runnerStarted).getTime())/1000)):null;
  const status=online?"Paper online":activeRun(main)?"Runner active · Paper unverified":main?.conclusion==="failure"?"Latest server run failed":main?.conclusion==="success"?"Last session finished":github?"No active Minecraft runner":"GitHub not connected";
  const statePill=online?pill("● LIVE SERVER",""):activeRun(main)?pill("◉ GITHUB RUN ACTIVE","warn"):main?.conclusion==="failure"?pill("● WORKFLOW FAILED","warn"):pill("○ NO LIVE PAPER DATA");
  const desc=online?(directOnline()?"Paper connected directly over NetBird, independently of Cloudflare.":"Paper is responding through Cloudflare."):activeRun(main)?"GitHub confirms a workflow is active, but it does not verify that Paper is ready. Use GitHub logs to check startup.":main?.conclusion==="failure"?"GitHub reports the last Minecraft workflow failed. Open its job logs below to identify the problem.":github?"GitHub is connected; there is no confirmed live Paper heartbeat. Start a new run only if no Minecraft workflow is active.":"Connect GitHub to manage workflows. GitHub access does not provide a live Paper connection.";
  const hero=`<div class="hero"><div class="hero-top"><div><div class="hero-label">SERVER STATUS</div><div class="hero-title">${esc(status)}</div></div>${statePill}</div><div class="hero-desc">${desc}</div><div class="hero-actions">${btn("▶ Start server","start-server","primary")} ${btn("↻ Safe restart","restart-server")} ${btn("■ Save & stop","stop-server","danger")} ${main?btn("◷ View Minecraft logs","server-logs","flat"):""}</div></div>`;
  const stats=`<div class="stats">
   ${stat("Online players",online?(live.players||[]).length:"—",online?"Connected to Paper":"Live connection required","♙")}
   ${stat("Server uptime",liveClock.session?duration(interpolatedPaperSeconds("uptime")):"—","Current runner session","◷","uptime")}
   ${stat("Empty time",liveClock.session?duration(interpolatedPaperSeconds("emptyFor")):"—","Restart after 1 hour empty","⌛","empty")}
   ${stat("Memory used",online&&live.memoryMiB!=null?Number(live.memoryMiB).toFixed(0)+" MB":"—","Paper Java process","▦")}
  </div>`;
  const runnerCard=main?panel("GitHub runner · independent status",`<div class="list-stat"><span>Latest Minecraft run</span><strong>#${esc(main.run_number)}</strong></div><div class="list-stat"><span>Workflow status</span><strong>${esc(main.conclusion||main.status||"unknown")}</strong></div><div class="list-stat"><span>Workflow elapsed (approx.)</span><strong data-live="runner">${runnerElapsed!==null?duration(runnerElapsed):"—"}</strong></div><p class="field-tip" style="margin-top:14px">Workflow elapsed is estimated from GitHub timestamps and may include queue time; it is not Paper uptime. Minecraft player and memory metrics require a functioning live bridge.</p><button class="btn small flat" data-action="server-logs">View GitHub job logs</button>`):"";
  const runs=state.overview?.runs||[];
  const recent=runs.slice(0,5);
  const actions=`<div class="columns">
   ${panel("Recent activity",recent.length?`<div class="run-list">${recent.map(r=>runRow(r)).join("")}</div>`:boxEmpty("No runs loaded","Connect your GitHub account to see recent activity.","⎇"),`<button class="btn small flat" data-page="workflows">View all →</button>`)}
   ${panel("Connection health",`<div class="list-stat"><span>GitHub</span><strong>${github?"● Connected":"○ Not connected"}</strong></div><div class="list-stat"><span>Direct Paper · NetBird</span><strong>${directOnline()?"● Connected":"○ Not connected"}</strong></div>${!directOnline()&&state.directError?`<p class="field-tip" style="margin:10px 0 12px;color:#ae624f">Direct connection: ${esc(state.directError)}</p>`:""}<div class="list-stat"><span>Cloudflare bridge</span><strong>${state.cloud?.bridge?.status?.ready?"● Connected":"○ Offline / unavailable"}</strong></div><div class="list-stat"><span>Minecraft workflow</span><strong>${main?esc(main.conclusion||main.status||"unknown"):"—"}</strong></div><div class="list-stat"><span>Latest run</span><strong>${main?esc("#"+main.run_number):"—"}</strong></div><div class="list-stat"><span>World backups</span><strong>${(state.overview?.artifacts||[]).filter(a=>!a.expired).length}</strong></div><p class="field-tip" style="margin-top:18px">GitHub workflow management works without Cloudflare. Safe live commands need a working server bridge.</p>`)}
   </div>`;
  $("#content").innerHTML=header("SERVER","Overview","Manage your server, plugins, files and backups.",btn("↻ Refresh","refresh","flat"))+hero+stats+runnerCard+actions;
}
function drawWorkflows(){
  const workflows=(state.workflows||[]).filter(w=>w.state!=="deleted"),runs=state.overview?.runs||[];
  const items=workflows.length?workflows.map(w=>{
    const file=w.path?.split("/").at(-1)||"";
    const permitted=["paper-state-test.yml","dashboard-checks.yml","maintenance-log.yml"].includes(file);
    return `<div class="workflow-item"><div><div class="workflow-name">${esc(w.name)}</div><div class="workflow-meta">${esc(file)} · ${esc(w.state||"active")}</div></div><div class="row-buttons">${permitted?`<button class="btn small flat" data-action="dispatch" data-id="${esc(file)}">Run workflow</button>`:""}<button class="btn small" data-action="filter-runs" data-id="${esc(file)}">Runs</button></div></div>`;
  }).join(""):boxEmpty("Workflows unavailable","Connect GitHub and refresh to load workflows.","⎇");
  $("#content").innerHTML=header("WORKFLOWS","GitHub Actions","Start workflows and inspect recent runs.",btn("↻ Refresh","refresh","flat"))
  +notice("<strong>World protection:</strong> Running Minecraft sessions can't be force-cancelled here. Use Safe Save & Stop in Overview to preserve your world.")
  +panel("Available workflows",items)
  +panel("Recent runs",runs.length?`<div class="run-list">${runs.slice(0,20).map(r=>runRow(r,true)).join("")}</div>`:boxEmpty("No workflow runs","Workflow activity will appear here once connected.","◷"),pill(runs.length+" loaded runs"));
}
function consoleTransport(){
  if(state.directStreamConnected&&directOnline())return "● LIVE STREAM · NetBird · Low latency";
  if(directOnline())return "● Direct NetBird polling · Stream unavailable";
  if(connectedLive())return "● Cloudflare polling · Typically 2–4 second delay";
  return "○ Live connection unavailable";
}
function drawConsole(){
  const online=connectedLive(),logs=currentPaper().logs||[];
  const githubLogs=state.githubLog||"";
  const githubFallback=!online&&state.github.connected;
  const lines=online&&logs.length?logs.map(line=>{
    const cls=/\b(ERROR|Exception|failed)\b/i.test(line)?"error":/\b(INFO|Done|joined)\b/i.test(line)?"info":"";
    return `<div class="${cls}">${esc(line)}</div>`;
  }).join(""):githubFallback&&githubLogs?`<span class="dim">GitHub Actions logs (may be delayed; read-only)</span>\n${esc(githubLogs)}`:`<span class="dim">${esc(state.githubLogError||"No Paper live console. GitHub job logs are available below when GitHub publishes them.")}</span>`;
  $("#content").innerHTML=header("SERVER","Live Console","Paper output and server commands.",btn("↻ Refresh","refresh","flat"))
   +(online?notice(directOnline()?"● Direct NetBird connection online. Console works without Cloudflare.":"● Cloudflare bridge online — console commands are sent to Paper.",true):notice(githubFallback?"GitHub read-only log fallback is active. These logs may be delayed or unavailable during an active job. GitHub does not support sending Paper console commands.":"The live bridge is offline. Connect GitHub to inspect workflow logs. Do not force-cancel a running Minecraft job."))
   +panel(online?"Paper live console":"GitHub Actions · read-only job logs",`<p class="field-tip" id="consoleTransport" role="status" style="margin:0 0 12px">${esc(consoleTransport())}</p><div class="header-actions" style="justify-content:flex-start;margin-bottom:12px"><button class="btn small flat" data-action="server-logs" ${githubFallback?"":"disabled"}>↻ Load GitHub logs</button><span class="field-tip">${esc(state.githubLogInfo||"GitHub job output is not a direct Paper connection")}</span></div><div class="console" id="terminal">${lines}</div><form id="consoleForm" class="console-form"><input id="commandText" placeholder="Enter a Paper console command…" autocomplete="off" aria-label="Paper console command" ${online?"":"disabled"}><button class="btn primary" ${online?"":"disabled"}>Send ↗</button></form>`);
  const term=$("#terminal");term.scrollTop=term.scrollHeight;
}
function drawMarketplace(){
  window.McMarketplace.render(directOnline());
  window.McMarketplace.ensureLoaded();
}
function drawFiles(){
  const f=state.file,isLoaded=f&&f.path===state.filePath,editable=!!f?.content;
  let text="";
  if(isLoaded&&f.type==="file"&&typeof f.content==="string"){
    try{text=decodeURIComponent(escape(atob(f.content.replace(/\s/g,""))))}catch{
      try{text=atob(f.content.replace(/\s/g,""))}catch{text=""}
    }
  }
  $("#content").innerHTML=header("FILES","Repository Files","View and edit server configuration in GitHub.",btn("↻ Reload file","load-file","flat"))
   +notice("Repository edits are committed to GitHub and don't immediately alter the running Paper process. For world data or live configuration, use the server's safe controls.")
   +panel("File editor",`<div class="field"><label for="filepath">Repository path</label><div class="form-row"><div class="field"><input id="filepath" value="${esc(state.filePath)}" spellcheck="false" placeholder="server/server.properties"></div><button class="btn primary" data-action="load-file">Open file</button></div><div class="field-tip">Examples: server/server.properties, server/java.json, server/bedrock.json, README.md</div></div>
    <div class="field"><label for="filecontent">File contents ${isLoaded?"· "+esc(f.sha?.slice(0,8)):""}</label><textarea id="filecontent" spellcheck="false" placeholder="Select a repository file above…" ${isLoaded&&editable?"":"disabled"}>${esc(text)}</textarea></div>
    <div class="header-actions" style="justify-content:flex-start"><button class="btn primary" data-action="save-file" ${isLoaded&&editable?"":"disabled"}>Commit changes</button><span class="field-tip" id="fileState">${isLoaded?"Ready to edit":"File not loaded"}</span></div>`);
}
function drawBackups(){
  const artifacts=(state.overview?.artifacts||[]).filter(a=>!a.expired&&a.name==="minecraft-world").sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  $("#content").innerHTML=header("BACKUPS","World Backups","Download saved world snapshots.",btn("↻ Refresh","refresh","flat"))
   +notice("<strong>Important:</strong> Always wait for the server to finish saving and uploading a verified backup before shutting it down. Download critical backups to your own PC.")
   +panel("Available snapshots",artifacts.length?`<div class="run-list">${artifacts.map(a=>`<div class="run"><div class="run-icon">▤</div><div class="run-content"><strong>${esc(when(a.created_at))}</strong><span>Run #${esc(a.workflow_run?.id||"—")} · ${esc(bytes(a.size_in_bytes))}</span></div><div class="row-buttons"><button class="btn small flat" data-action="download" data-id="${Number(a.id)}">↓ Download ZIP</button></div></div>`).join("")}</div>`:boxEmpty("No snapshots found","Snapshots appear after a successful safe save and backup.","◷"));
}
function drawConnections(){
  const gh=state.github.connected;
  $("#content").innerHTML=header("SETTINGS","Connections","Manage GitHub, Cloudflare and NetBird connections.")
   +`<div class="columns">${panel("GitHub · Primary connection",`
     ${pill(gh?"● Connected":"○ Not connected",gh?"":"muted")}
     <p class="field-tip" style="margin:15px 0 20px">Direct GitHub access for workflows, repository files, job history and world backup downloads. Token is held in Windows Credential Manager.</p>
     ${gh?`<div class="list-stat"><span>Repository</span><strong>${esc(state.github.repository)}</strong></div><div class="header-actions" style="justify-content:flex-start;margin-top:20px"><button class="btn danger" data-action="disconnect-github">Disconnect GitHub</button></div>`
     :`<div class="field"><label for="token">GitHub personal access token</label><input type="password" id="token" placeholder="github_pat_..." autocomplete="off"></div><button class="btn primary" data-action="connect-github">Connect GitHub ↗</button><p class="field-tip">Grant access to this repository with Actions read/write and Contents read/write permissions. Do not share the token in chat or screenshots.</p>`}
   `)}${panel("Cloudflare · Optional live bridge",`
     ${pill(state.cloud?.bridge?.status?.ready?"● Cloudflare connected":"○ Cloudflare unavailable",state.cloud?.bridge?.status?.ready?"":"warn")}
     <p class="field-tip" style="margin:15px 0 20px">Optional backup channel for the web dashboard. Your Windows app can get live Paper data directly through NetBird even if Cloudflare is offline.</p>
     <div class="field"><label for="cloudUrl">Cloudflare Worker URL</label><input id="cloudUrl" placeholder="https://minecraft-cloud-control.majood-saod.workers.dev" value="https://minecraft-cloud-control.majood-saod.workers.dev" autocomplete="off"></div>
     <div class="field"><label for="cloudPass">Dashboard admin password</label><input id="cloudPass" type="password" placeholder="Enter dashboard password" autocomplete="off"></div>
     <button class="btn primary" data-action="connect-cloud">Save and test live connection</button>
     ${state.cloudError?`<p class="field-tip" style="color:#c46b53">Last error: ${esc(state.cloudError)}</p>`:""}
   `)}</div>`+
   `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2 class="panel-title">Direct Paper · NetBird</h2>${directOnline()?pill("● Private connection online",""):pill("○ Not connected","warn")}</div><p class="field-tip">Connect directly to your temporary GitHub Actions Paper runner. NetBird must be connected on your Windows PC. The app automatically discovers connected minecraft-paper-* peers after each restart. Live console and server metrics work without Cloudflare.</p><div class="notice good" style="margin-top:17px"><label for="netbirdAuto" style="display:flex;align-items:center;gap:12px;cursor:pointer"><input id="netbirdAuto" type="checkbox" ${state.netbirdAuto?.enabled?"checked":""} style="width:17px;height:17px;accent-color:#158b69"><span><strong>Automatically connect NetBird</strong><span style="display:block;font-size:11px;margin-top:5px">Connect on app launch and disconnect when it closes, only if Minecraft Cloud started the VPN itself.</span></span></label><div style="margin-top:9px;font-size:11px">NetBird: ${state.netbirdAuto?.connected?"Connected":"Not connected"} ${state.netbirdAuto?.ownedByApp?"· Managed by Minecraft Cloud":""}</div></div><div class="field" style="margin-top:16px"><label for="directToken">Direct-control secret</label><input id="directToken" type="password" autocomplete="off" placeholder="Value saved as MINECRAFT_DIRECT_TOKEN in GitHub Secrets"></div><div class="field"><label for="directPeer">Manual NetBird peer IP (optional)</label><input id="directPeer" placeholder="Leave blank for automatic discovery"></div>${state.directPeerConfig?.manual?`<div class="notice" style="margin-bottom:12px"><strong>Manual peer override is active:</strong> ${esc(state.directPeerConfig.peerIp)}. This may point to an old GitHub runner.<div style="margin-top:10px"><button class="btn primary" data-action="clear-direct-peer">Use active server automatically</button></div></div>`:`<p class="field-tip" style="margin:0 0 12px">Automatic discovery: uses the active Minecraft GitHub workflow when GitHub is connected.</p>`}<div class="header-actions" style="justify-content:flex-start"><button class="btn primary" data-action="connect-direct">Connect Direct Paper</button><button class="btn flat" data-action="test-direct">Test connection</button></div>${state.directError?`<p class="field-tip" style="color:#b96154;margin-top:12px">${esc(state.directError)}</p>`:""}</section>`+
   `<section class="panel" style="margin-top:16px"><div class="panel-head"><h2 class="panel-title">Windows app updates</h2>${state.update?.available?pill("● New build available",""):pill("Installed app","muted")}</div><p class="field-tip">Check GitHub for the latest successful Windows installer. Quick Update upgrades your existing installation without manually downloading or extracting ZIP files. Your login remains saved on this PC.</p><div class="header-actions" style="justify-content:flex-start;margin-top:16px"><button class="btn primary" data-action="check-update">${state.update?.available?"Install update #"+state.update.runNumber:"↻ Quick Update"}</button><span class="field-tip" id="updateStatusConnections">${esc(state.updateMessage|| (state.update?"Installed build "+(state.update.currentBuild||"legacy")+" · Latest build "+state.update.runNumber:"No update check performed yet"))}</span></div></section>`;
}
// Edits survive background telemetry updates, navigation, and incidental
// rerenders. Never store typed secrets outside this running app process.
const draftFields=new Set(["token","cloudUrl","cloudPass","directToken","directPeer",
  "filepath","filecontent","commandText"]);
function restoreDrafts(){
  for(const [id,value] of Object.entries(state.drafts)){
    const el=document.getElementById(id);
    if(el&&("value" in el))el.value=value;
  }
}
function clearDrafts(...ids){
  for(const id of ids)delete state.drafts[id];
}
function editing(){
  const el=document.activeElement;
  return el&&["INPUT","TEXTAREA","SELECT"].includes(el.tagName);
}
function render(){
  const titles={overview:"Overview",console:"Live Console",workflows:"GitHub Actions",files:"Repository Files",marketplace:"Plugins & Datapacks",backups:"World Backups",connections:"Connections"};
  $("#breadcrumb").textContent=titles[state.page]||"Overview";
  document.querySelectorAll(".nav").forEach(el=>el.classList.toggle("active",el.dataset.page===state.page));
  $("#githubDot").classList.toggle("ok",state.github.connected);$("#githubShort").textContent=state.github.connected?"GitHub connected":"GitHub not connected";
  $("#cloudDot").classList.toggle("ok",connectedLive());$("#cloudDot").classList.toggle("warn",!connectedLive()&&!!state.cloud);
  $("#cloudShort").textContent=connectedLive()?"Live bridge online":"Live bridge unavailable";
  const pages={overview:drawOverview,console:drawConsole,workflows:drawWorkflows,files:drawFiles,marketplace:drawMarketplace,backups:drawBackups,connections:drawConnections};
  (pages[state.page]||drawOverview)();
  restoreDrafts();
  syncUpdateButton();
  const pageNode=$("#content");
  // Animate navigation only; keep telemetry updates unobtrusive.
  if(state._lastAnimatedPage!==state.page){
    pageNode.classList.remove("mc-page-enter");
    void pageNode.offsetWidth;
    pageNode.classList.add("mc-page-enter");
    state._lastAnimatedPage=state.page;
  }else{
    pageNode.classList.remove("mc-page-enter");
  }
}
async function loadOverview(quiet=false){
  if(!state.github.connected)return;
  try{state.overview=await run("github_overview",{}, {quiet});}
  catch(e){if(!quiet)flash(errorText(e));}
}
async function loadCloud(quiet=true){
  try{state.cloud=await run("cloudflare_status",{}, {quiet});state.cloudFetchedAt=Date.now();state.cloudError=null;if(!directOnline())observeLiveClock(state.cloud?.bridge?.status,state.cloudFetchedAt);}
  catch(e){state.cloudError=errorText(e);state.cloud=null;state.cloudFetchedAt=0;}
}
async function loadGithubServerLog(quiet=true){
  if(!state.github.connected||state.logBusy)return;
  const target=latestServerRun();
  if(!target){state.githubLogError="No Minecraft GitHub Actions run found.";return;}
  state.logBusy=true;
  try{
    const jobs=await run("github_jobs",{runId:Number(target.id)},{quiet});
    const list=Array.isArray(jobs)?jobs:[];
    const job=list.find(j=>j.status==="in_progress")||list.find(j=>j.conclusion==="failure")||list.find(j=>j.conclusion==="success")||list[0];
    if(!job){state.githubLogError="GitHub has not created a job for this run yet.";state.logFetchedAt=Date.now();return;}
    state.githubLogInfo="Run #"+target.run_number+" · "+(job.name||"job")+" · "+(job.conclusion||job.status);
    const content=await run("github_job_log",{jobId:Number(job.id)},{quiet});
    state.githubLog=typeof content==="string"?content:"";
    state.githubLogError=null;
    state.logFetchedAt=Date.now();
  }catch(error){
    state.githubLogError="GitHub job logs not available yet: "+errorText(error);
    state.logFetchedAt=Date.now();
  }finally{state.logBusy=false;}
}
async function refresh(quiet=false){
  if(state.busy)return;state.busy=true;$("#refresh").disabled=true;
  try{
    await Promise.all([loadOverview(quiet),loadCloud(true),loadDirect(true),loadNetbirdAuto()]);
    if(state.page==="workflows"&&state.github.connected){
      try{state.workflows=await run("github_workflows",{}, {quiet:true});}catch{}
    }
    if(state.page==="console"&&!connectedLive()&&state.github.connected&&Date.now()-state.logFetchedAt>30000)await loadGithubServerLog(true);
    state.lastFetch=Date.now();
    // A background refresh must not replace a focused text field. The next
    // refresh after typing will reconcile the visible data.
    if(!editing())render();
  }finally{state.busy=false;$("#refresh").disabled=false}
}
async function startApp(){
  try{state.github=await invoke("github_status")}catch{state.github={connected:false}}
  // Register before starting Rust's SSE listener so the first event is kept.
  try{
    const listen=window.__TAURI__.event.listen;
    await listen("paper-live-status",event=>{
      const next=event.payload;
      if(!next||typeof next!=="object"||!next.session)return;
      const previous=state.direct;
      state.direct=next;
      state.directStreamConnected=true;
      state.directFetchedAt=Date.now();
      state.directError=null;
      observeLiveClock(next,state.directFetchedAt);
      const changes=JSON.stringify({
        ready:previous?.ready,session:previous?.session,players:previous?.players,
        phase:previous?.phase,memoryMiB:previous?.memoryMiB
      })!==JSON.stringify({
        ready:next.ready,session:next.session,players:next.players,
        phase:next.phase,memoryMiB:next.memoryMiB
      });
      if(state.page==="console")updateConsoleOutput();
      if(changes&&["overview","connections"].includes(state.page)&&!editing())render();
      tickLiveUI();
    });
    await listen("paper-live-disconnected",()=>{
      state.directStreamConnected=false;
      // Preserve last known telemetry and the running clock through reconnects.
      if(state.page==="console")updateConsoleOutput();
      // A transient transport loss is not a Paper restart. Keep the existing
      // view and timer stable; background fallback checks connection health.
      tickLiveUI();
    });
    await invoke("direct_start_stream");
  }catch(error){state.directError=errorText(error);}
  await Promise.all([loadNetbirdAuto(),loadDirectPeerConfig()]);
  render();await refresh(true);
  if(state.github.connected)checkDesktopUpdate(true);
  if(!state.github.connected){state.page="connections";render();}
}
async function action(type,id){
  switch(type){
  case "refresh":return refresh();
  case "check-update":return quickUpdate();
  case "market-restart":{
    if(!connectedLive())return flash("Server must be connected to restart safely.");
    if(!await dialog("Safely restart Paper?","Players will be kicked, the world saved and backed up, and the server restarted to load your newly installed plugins."))return;
    try{await sendPaper("restart");flash("Safe plugin activation restart requested.");}catch{}
    return;
  }
  case "server-logs":{
    if(!state.github.connected)return flash("Connect GitHub first.");
    state.page="console";state.githubLog=null;state.githubLogError=null;
    await loadGithubServerLog(false);render();return;
  }
  case "connect-github":{
    const token=$("#token")?.value||"";if(!token)return flash("Enter a GitHub token first.");
    try{state.github=await run("connect_github",{token});clearDrafts("token");$("#token").value="";flash("GitHub connected securely.");await refresh();state.page="overview";render();checkDesktopUpdate(true);}catch{}return;
  }
  case "disconnect-github":{
    if(!await dialog("Disconnect GitHub?","Removes the saved GitHub token from Windows Credential Manager."))return;
    await run("disconnect_github");state.github={connected:false};state.overview=null;state.workflows=null;state.update=null;flash("GitHub disconnected.");return render();
  }
  case "netbird-auto":{
    const enabled=$("#netbirdAuto")?.checked||false;
    try{
      state.netbirdAuto=await run("netbird_set_auto",{enabled});
      flash(enabled?"NetBird automatic connection enabled.":"Automatic NetBird connection disabled.");
      await loadDirect(true);
    }catch{
      try{state.netbirdAuto=await invoke("netbird_auto_status");}catch{}
    }
    render();return;
  }
  case "connect-direct":{
    const token=$("#directToken")?.value.trim()||"",peerIp=$("#directPeer")?.value.trim()||"";
    if(token.length<8)return flash("Enter a token of at least 8 characters matching MINECRAFT_DIRECT_TOKEN in GitHub Actions.");
    try{
      await run("direct_configure",{token,peerIp});
      await loadDirectPeerConfig();
      clearDrafts("directToken","directPeer");
      await loadDirect(false);
      flash(directOnline()?"Direct Paper connected! No Cloudflare required.":"Credentials saved. Start a new runner with NetBird enabled, then test again.");
      render();
    }catch{}return;
  }
  case "clear-direct-peer":{
    try{
      state.directPeerConfig=await run("direct_clear_peer");
      clearDrafts("directPeer");
      state.directError=null;
      flash("Manual NetBird address cleared. Looking for the active Paper runner.");
      await loadDirect(false);
    }catch(error){
      state.directError=errorText(error);
    }
    render();return;
  }
  case "test-direct":{
    await loadDirect(false);flash(directOnline()?"NetBird connection healthy.":"Direct Paper unavailable: "+(state.directError||"Check NetBird status."));render();return;
  }
  case "connect-cloud":{
    const url=$("#cloudUrl")?.value||"",password=$("#cloudPass")?.value||"";
    if(!url||!password)return flash("Enter a Worker URL and password.");
    try{await run("configure_cloudflare",{url,password});clearDrafts("cloudPass");await loadCloud(false);flash(connectedLive()?"Live bridge connected.":"Connection saved; live server still unavailable.");render();}catch{}return;
  }
  case "start-server":{
    if(!state.github.connected)return flash("Connect GitHub first.");
    if(!await dialog("Start Minecraft server?","Dispatches a new Minecraft GitHub Actions session. If one is already running, GitHub may start another queued run."))return;
    try{await run("github_dispatch",{workflowId:"paper-state-test.yml"});flash("Minecraft workflow requested.");setTimeout(()=>refresh(true),1500);}catch{}return;
  }
  case "restart-server":case "stop-server":{
    if(!connectedLive())return flash("Safe restart requires a working live bridge. Do not cancel the workflow or risk losing world progress.");
    const kind=type==="restart-server"?"restart":"shutdown";
    if(!await dialog(kind==="restart"?"Safely restart Minecraft?":"Safely save and stop?","This asks the live server agent to disconnect players, save all world data and upload a verified backup before the session ends."))return;
    try{await sendPaper(kind);flash("Safe operation requested. Check workflow for backup completion.");}catch{}return;
  }
  case "dispatch":{
    if(!state.github.connected)return flash("Connect GitHub first.");
    if(!await dialog("Run "+id+"?","Start this GitHub Actions workflow on the main branch?"))return;
    try{await run("github_dispatch",{workflowId:id});flash("Workflow dispatched.");setTimeout(()=>refresh(true),1800);}catch{}return;
  }
  case "cancel":{
    const num=Number(id);
    if(!await dialog("Cancel workflow run?","This cancels a non-Minecraft workflow. Minecraft server sessions are protected from force cancellation."))return;
    try{await run("github_cancel",{runId:num});flash("Cancellation requested.");await refresh(true);}catch{}return;
  }
  case "jobs":{
    try{
      const jobs=await run("github_jobs",{runId:Number(id)});
      const list=Array.isArray(jobs)?jobs:[];
      const summary=list.map(job=>`${job.name} — ${job.conclusion||job.status}\n${(job.steps||[]).map(s=>`  ${s.conclusion==="success"?"✓":s.conclusion==="failure"?"✕":"·"} ${s.name}`).join("\n")}`).join("\n\n");
      const view=await dialog("Workflow run #"+id,(summary||"No job details yet.")+"\\n\\nSelect Continue to open the first job's latest 160 log lines.");
      if(view&&list.length){
        const logs=await run("github_job_log",{jobId:Number(list[0].id)});
        await dialog("Job logs · "+(list[0].name||"GitHub Actions"),logs||"No logs available yet.");
      }
    }catch{}return;
  }
  case "filter-runs":{
    try{
      const runs=await run("github_runs",{workflowId:id});
      state.runs=runs;
      const items=(Array.isArray(runs)?runs:[]).slice(0,12).map(r=>`#${r.run_number}  ${r.conclusion||r.status}  ${when(r.created_at)}`).join("\n");
      await dialog(id+" · recent runs",items||"No recent runs.");
    }catch{}return;
  }
  case "load-file":{
    const path=$("#filepath")?.value.trim()||state.filePath;state.filePath=path;
    try{state.file=await run("github_file",{path});clearDrafts("filecontent");state.file.path=path;render();}catch{}return;
  }
  case "save-file":{
    if(!state.file?.sha)return flash("Load a file first.");
    const value=$("#filecontent").value;
    if(!await dialog("Commit file changes?","This writes the edited file directly to the GitHub main branch. A running server won't load the changes until its next session."))return;
    const raw=new TextEncoder().encode(value);let binary="";for(const b of raw)binary+=String.fromCharCode(b);
    try{
      await run("github_save_file",{args:{path:state.filePath,sha:state.file.sha,content_base64:btoa(binary),message:"Desktop: update "+state.filePath}});
      flash("File committed to GitHub.");clearDrafts("filecontent");state.file=await run("github_file",{path:state.filePath});state.file.path=state.filePath;render();
    }catch{}return;
  }
  case "download":{
    try{const file=await run("github_download_backup",{artifactId:Number(id)});flash("World backup saved to "+file);}catch{}return;
  }
  default:flash("Action unavailable.");
  }
}
// Native updater sends download progress over the Tauri event bus.
window.__TAURI__.event.listen("desktop-update-progress",ev=>{
  const progress=ev.payload||{};
  if(progress.stage==="downloading"){
    const percent=Number.isFinite(progress.percent)?progress.percent:null;
    updateMessage(percent===null?"Downloading Windows installer…":"Downloading Windows installer… "+percent+"%");
  }else if(progress.stage==="extracting"){
    updateMessage("Download complete · extracting Windows installer…");
  }else if(progress.stage==="launching"){
    updateMessage("Launching Windows installer…");
  }
}).catch(()=>{});
document.addEventListener("click",ev=>{
  const nav=ev.target.closest("[data-page]");
  if(nav){state.page=nav.dataset.page;render();if(state.page==="workflows"&&!state.workflows&&state.github.connected)refresh(true);if(state.page==="console"&&!connectedLive()&&state.github.connected)loadGithubServerLog(true).then(render);return;}
  const button=ev.target.closest("[data-action]");
  if(button){ev.preventDefault();action(button.dataset.action,button.dataset.id);}
});
document.addEventListener("input",ev=>{
  if(draftFields.has(ev.target?.id)){
    state.drafts[ev.target.id]=ev.target.value;
  }
});
document.addEventListener("change",ev=>{
  if(ev.target?.id==="netbirdAuto")action("netbird-auto");
});
document.addEventListener("submit",async ev=>{
  if(ev.target.id!=="consoleForm")return;
  ev.preventDefault();const cmd=$("#commandText").value.trim();if(!cmd)return;
  try{await sendPaper("console",{command:cmd});clearDrafts("commandText");$("#commandText").value="";flash("Command sent to Paper.");setTimeout(()=>refresh(true),1000);}catch{}
});
$("#refresh").addEventListener("click",()=>refresh());
setInterval(()=>{$("#time").textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});},1000);
// Smooth client-side counters update once per second without network traffic.
setInterval(tickLiveUI,1000);
// Poll live telemetry independently of the expensive GitHub workflow API.
// Cloudflare acts as fallback when NetBird is not connected.
let livePollPending=false;
async function pollLiveTelemetry(){
  if(document.visibilityState!=="visible"||livePollPending||state.busy)return;
  livePollPending=true;
  try{
    if(state.directStreamConnected)return;
    await loadCloud(true);
    if(state.page==="console")updateConsoleOutput();
    if(["overview","connections"].includes(state.page)&&!editing())render();
    tickLiveUI();
  }finally{livePollPending=false;}
}
setInterval(pollLiveTelemetry,2000);
// Direct NetBird probes have a longer timeout, so keep them independent of
// Cloudflare polling. The single-flight guard in loadDirect prevents overlap.
setInterval(async()=>{
  if(document.visibilityState!=="visible")return;
  // Periodic direct probes are a compatibility fallback for older runner
  // versions that have not yet received /api/events.
  if(state.directStreamConnected)return;
  await loadDirect(true);
  if(state.page==="console")updateConsoleOutput();
  if(["overview","connections"].includes(state.page)&&!editing())render();
  tickLiveUI();
},4000);
// GitHub metadata and backups need much less frequent refreshes.
setInterval(()=>{if(document.visibilityState==="visible")refresh(true)},30000);
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible"){pollLiveTelemetry();tickLiveUI();}
});
startApp();
