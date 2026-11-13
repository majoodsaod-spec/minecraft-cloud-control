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
const serverRunning=()=>connectedLive()||activeRun(latestServerRun());
const state={operation:null,restoreInProgress:false,restoreMessage:"",page:"overview",github:{connected:false},overview:null,cloud:null,cloudError:null,direct:null,directError:null,directFetchedAt:0,directStreamConnected:false,cloudFetchedAt:0,netbirdAuto:null,directPeerConfig:null,workflows:null,runs:null,file:null,filePath:"server/server.properties",fileDirty:false,lastFetch:0,busy:false,toastTimer:null,githubLog:null,githubLogInfo:null,githubLogError:null,logBusy:false,logFetchedAt:0,update:null,updateChecking:false,drafts:Object.create(null),metricHistory:[],metricSession:null,metricAt:0,metricHistoryLoadedSession:null,metricHistoryBusy:false,worlds:null,worldsLoading:false,worldsError:"",worldsFetchedAt:0,worldsSession:null};
function flash(text){const box=$("#toast");box.textContent=text;box.classList.add("show");clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>box.classList.remove("show"),4300)}
function btn(label,action="refresh",cls="",disabled=false){return `<button class="btn ${cls}" data-action="${action}" ${disabled?"disabled":""}>${label}</button>`}
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
  if(uptime)uptime.textContent=clockDisplay("uptime");
  if(empty)empty.textContent=clockDisplay("emptyFor");
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
    try{state.direct=await run("direct_status",{}, {quiet});state.directFetchedAt=Date.now();state.directError=null;recordMetric(state.direct);observeLiveClock(state.direct,state.directFetchedAt);if(directOnline())loadHistoricalMetrics();}
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
  const cls=activeRun(r)?"pending":r.conclusion==="failure"?"failed":r.conclusion==="cancelled"?"cancelled":r.conclusion==="success"?"success":"neutral";
  const glyph=cls==="pending"?"↻":cls==="failed"?"!":cls==="success"?"✓":cls==="cancelled"?"–":"·";
  const buttons=`<button class="btn small flat" data-action="jobs" data-id="${Number(r.id)}">Details</button>`+
    (withCancel&&activeRun(r)&&!isServer(r)?`<button class="btn small danger" data-action="cancel" data-id="${Number(r.id)}">Cancel</button>`:"");
  return `<div class="run"><div class="run-icon ${cls}">${glyph}</div><div class="run-content"><strong>${esc(r.display_title||r.name||"GitHub workflow")}</strong><span>${esc(r.name||"")} · ${esc(ago(r.created_at))} · #${esc(r.run_number||r.id)}</span></div><span class="run-status ${cls}">${esc(label)}</span><span class="row-buttons">${buttons}</span></div>`;
}
// The server operation spans GitHub runner handoffs. Progress must NEVER
// regress to Requested after a verified backup completes.
const lifecycleStages=window.ServerLifecycle.stages;
function observedPhase(){
  if(state.direct&&directOnline()&&state.direct.phase)return state.direct.phase;
  return state.cloud?.bridge?.status?.phase||"";
}
function operationSnapshot(){
  const main=latestServerRun();
  const direct=directOnline()?state.direct:null;
  const cloud=state.cloud?.bridge?.status||{};
  const selected=direct||cloud;
  const phase=observedPhase();
  const ready=connectedLive() && selected.ready &&
    !["shutdown_requested","saving","stopping","backing_up","stopped"].includes(phase);
  const session=selected.session||null;
  // A stale Cloudflare bridge state must not create a phantom new operation.
  const fresh=Boolean(direct)||(cloud.updatedAt &&
    Date.now()-Number(cloud.updatedAt)<45000);
  if(!state.operation){
    if(fresh&&["shutdown_requested","saving","stopping","backing_up"].includes(phase)){
      const kind=state.cloud?.bridge?.desired==="on"?"restarting":"stopping";
      state.operation=window.ServerLifecycle.create(kind,session,main?.id);
    }else if(activeRun(main)&&!ready){
      state.operation=window.ServerLifecycle.create("starting",session,main?.id);
    }else return null;
  }
  const next=window.ServerLifecycle.advance(state.operation,{
    phase,session,ready,runId:main?.id,runStatus:main?.status,
    runConclusion:main?.conclusion,now:Date.now()
  });
  if(!next){
    state.operation=null;
    return null;
  }
  return next;
}
function lifecycleActive(){return Boolean(operationSnapshot())}
function syncServerOperation(){
  const box=$("#serverOperation");if(!box)return;
  const current=operationSnapshot();
  box.hidden=!current;
  if(!current)return;
  const kind=current.kind;
  const title={starting:"Starting server",stopping:"Stopping server",restarting:"Restarting server",restoring:"Restoring world"}[kind]||"Server operation";
  $("#serverOperationTitle").textContent=current.failed?"Server operation needs attention":title;
  const stages=lifecycleStages[kind]||lifecycleStages.starting;
  const index=current.stageIndex;
  $("#serverOperationStep").textContent=current.failed?"Check logs":window.ServerLifecycle.label(current);
  $("#serverOperationStages").innerHTML=stages.map((stage,i)=>
    '<span class="server-operation-stage '+(i<index?"complete":i===index?"current":"")+
    '"><i></i>'+esc(stage)+'</span>').join("");
  $("#serverOperationDetail").textContent=window.ServerLifecycle.detail(current);
  $("#serverOperationSource").textContent=connectedLive()?"Paper live status":"GitHub Actions status";
  box.classList.toggle("failed",Boolean(current.failed));
}
function beginOperation(kind){
  // Repeated status requests must not reset a restart already in progress.
  if(state.operation?.kind===kind&&!state.operation.failed)return syncServerOperation();
  const session=(directOnline()?state.direct:state.cloud?.bridge?.status)?.session||null;
  state.operation=window.ServerLifecycle.create(kind,session,latestServerRun()?.id);
  syncServerOperation();
}
function clockDisplay(field){
  // Stale telemetry from a previous Paper session must not tick while
  // a restart or graceful stop is underway.
  if(lifecycleActive()||!connectedLive()||["shutdown_requested","saving","stopping","backing_up","starting","stopped"].includes(observedPhase()))return "—";
  return liveClock.session?duration(interpolatedPaperSeconds(field)):"—";
}
const lifecycleLabels={
  restore_backup:"Restore backup",queued_file_changes:"Apply queued files",
  queued_modrinth:"Queued installs",paper_download:"Paper download",
  plugin_setup:"Plugin setup",server_properties:"Server properties",
  paper_ready:"Paper ready",backup_verify:"Save and verify backup"
};
function startupDiagnostics(){
  const timings=currentPaper().startupTimings||{};
  const rows=Object.entries(lifecycleLabels).filter(([key])=>
    Number.isFinite(Number(timings[key]))&&Number(timings[key])>=0);
  if(!rows.length){
    return panel("Startup diagnostics",
      '<p class="field-tip">Stage timings will appear after a Paper session starts using the updated reliability instrumentation. Backup and failure details are also recorded in the GitHub run summary.</p>'+
      '<button class="btn small flat" data-action="server-logs">View runner diagnostics</button>');
  }
  const max=Math.max(0.1,...rows.map(([key])=>Number(timings[key])));
  const items=rows.map(([key,name])=>{
    const value=Number(timings[key]);
    const width=Math.max(2,Math.round(value/max*100));
    return '<div class="reliability-phase"><div><span>'+esc(name)+'</span><strong>'+value.toFixed(2)+' s</strong></div>'+
      '<div class="reliability-track"><i style="width:'+width+'%"></i></div></div>';
  }).join("");
  return panel("Startup diagnostics",'<div class="reliability-timings">'+items+'</div>'+
    '<p class="field-tip">Measured on the runner. Times depend on backup size, GitHub networking, and Paper plugin initialization.</p>');
}
function recoveryWarning(){
  const run=latestServerRun();
  if(!run||!["failure","cancelled","timed_out","action_required"].includes(run.conclusion))return "";
  const backups=(state.overview?.artifacts||[]).filter(a=>
    a.name==="minecraft-world"&&!a.expired);
  if(backups.some(a=>Number(a.workflow_run?.id)===Number(run.id)))return "";
  return notice('<strong>Recovery needs review.</strong> The latest Paper workflow ended without a verified backup. Automatic recovery will not restore an older world without confirmation. Review the runner logs or select a backup from World Backups.')+
    '<div class="header-actions" style="margin:0 0 14px"><button class="btn small" data-action="server-logs">Review runner logs</button><button class="btn small" data-page="backups">World Backups</button></div>';
}
function recordMetric(snapshot){
  if(!snapshot||!snapshot.ready||!snapshot.session)return;
  if(snapshot.cpuPercent==null||snapshot.memoryMiB==null||snapshot.memoryLimitMiB==null)return;
  const cpu=Number(snapshot.cpuPercent),memory=Number(snapshot.memoryMiB);
  const limit=Number(snapshot.memoryLimitMiB),
        free=snapshot.diskFreeMiB==null?NaN:Number(snapshot.diskFreeMiB);
  if(!Number.isFinite(cpu)||!Number.isFinite(memory)||!Number.isFinite(limit)||limit<=0)return;
  const now=Date.now();
  if(state.metricSession!==snapshot.session){
    state.metricSession=snapshot.session;state.metricAt=0;
  }
  if(now-state.metricAt<5000)return;
  state.metricAt=now;
  state.metricHistory.push({at:now,cpu:Math.max(0,cpu),memory:Math.max(0,100*memory/limit),
    diskFree:Number.isFinite(free)?free:null,
    tps:snapshot.tps==null?null:Number(snapshot.tps),
    mspt:snapshot.mspt==null?null:Number(snapshot.mspt)});
  if(state.metricHistory.length>120)state.metricHistory.shift();
}
async function loadHistoricalMetrics(){
  if(!directOnline()||state.metricHistoryBusy)return;
  const session=state.direct?.session;
  if(!session||session===state.metricHistoryLoadedSession)return;
  state.metricHistoryBusy=true;
  try{
    const response=await invoke("direct_command",{kind:"performance-history",args:{}});
    if(!response?.ok||!Array.isArray(response.result))return;
    const saved=response.result.slice(-240).map(row=>{
      const at=Number(row?.at)*1000;
      if(!Number.isFinite(at)||at<=0)return null;
      const value=key=>row[key]==null?null:Number(row[key]);
      const cpu=value("cpu"),memoryMiB=value("memory"),diskFree=value("diskFree"),
            tps=value("tps"),mspt=value("mspt");
      if(cpu==null||memoryMiB==null||!Number.isFinite(cpu)||!Number.isFinite(memoryMiB))return null;
      return {at,cpu:Math.max(0,cpu),memory:Math.min(100,100*memoryMiB/8192),
        diskFree,tps,mspt};
    }).filter(Boolean);
    const current=state.metricHistory;
    state.metricHistory=[...saved,...current].sort((a,b)=>a.at-b.at).slice(-120);
    state.metricHistoryLoadedSession=session;
    if(state.page==="overview"&&!editing())render();
  }catch{
    // History is optional. Never block a healthy direct console connection.
  }finally{state.metricHistoryBusy=false;}
}
function resourceHistory(){
  const points=state.metricHistory;
  if(points.length<2)return panel("Resource history",'<p class="field-tip">Collecting genuine performance readings. The chart appears after at least two samples.</p>'+btn("Run 60-second Spark profile","spark-profile","small flat",!connectedLive()));
  const line=(field,max)=>points.map((item,i)=>{
    const x=Number((12+i*576/(points.length-1)).toFixed(2));
    const y=Number((106-Math.min(max,item[field])*90/max).toFixed(2));
    return (i?"L":"M")+x+" "+y;
  }).join(" ");
  const latest=points.slice(-3);
  const sustained=condition=>latest.length===3&&latest.every(condition);
  const pressure=sustained(x=>x.mspt!==null&&x.mspt>=50)||sustained(x=>x.tps!==null&&x.tps<18.5)?
    "Sustained tick lag detected · review Spark profiler":
    sustained(x=>x.memory>=90)?"Sustained high Java memory usage":
    sustained(x=>x.diskFree!==null&&x.diskFree<1024)?"Sustained low runner disk space":
    "No sustained resource warning";
  return panel("Resource history",`<div class="metric-legend"><span>● CPU (0–400% scale)</span><span>● Java memory (% of configured heap)</span></div>
    <svg class="resource-chart" viewBox="0 0 600 120" role="img" aria-label="Recent Paper CPU and memory usage trends">
      <path d="M12 16H588 M12 61H588 M12 106H588" fill="none" stroke="#e6eceb" stroke-width="1"/>
      <path d="${line("cpu",400)}" fill="none" stroke="#16886b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="${line("memory",100)}" fill="none" stroke="#6e85c6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg><div class="list-stat"><span>Resource check</span><strong>${esc(pressure)}</strong></div>
    <p class="field-tip">Recent live samples and up to two hours of saved history; CPU may exceed 100% on multicore runners. Disk readings describe temporary runner space, not stored world backups.</p>
    ${btn("Run 60-second Spark profile","spark-profile","small flat",!connectedLive())}
    <p class="field-tip">On-demand profiling may briefly add overhead. After 60 seconds, open Live Console for the Spark report URL.</p>`);
}
function bedrockHealthPanel(){
  const online=connectedLive();
  const b=online?currentPaper().bedrock:null;
  const ok=b?.status==="signaling_registered";
  const labels={
    signaling_registered:"Signaling registered",
    starting:"Geyser starting",
    awaiting_signaling:"Awaiting Playit registration",
    needs_setup:"Playit configuration missing",
    misconfigured:"Geyser configuration invalid",
    invalid_setup:"Invalid Playit Geyser YAML",
    agent_missing:"Playit agent failed to start",
    unavailable:"Geyser / Floodgate unavailable",
    listener_missing:"Bedrock listener missing",
    error:"Playit signaling error"
  };
  const indicator=online&&b?(labels[b.status]||"Checking Bedrock"):online?"No health report from this runner":"Paper live connection required";
  const row=(name,value)=>`<div class="list-stat"><span>${name}</span><strong>${esc(value)}</strong></div>`;
  const bool=v=>v===true?"● Yes":v===false?"○ No":"—";
  const source=b?.host?`${b.host}:${b.port||19132}`:"No Bedrock address saved";
  const detail=b?`<p class="field-tip" style="margin:10px 0 15px">${esc(b.message||"Bedrock health is not available.")}</p>`
    :'<p class="field-tip" style="margin:10px 0 15px">Connect to the live Paper server, then run a Bedrock check. A saved address alone does not prove that Geyser is online.</p>';
  const checks=b?row("Geyser / Floodgate JARs",bool(b.geyserInstalled&&b.floodgateInstalled))
    +row("NetherNet / Floodgate config",bool(b.configValid))
    +row("Playit Geyser YAML configured",bool(b.playitSettingsConfigured))
    +row("Playit agent running at startup",bool(b.playitAgentConfigured))
    +row("External signaling registered",bool(b.signalingRegistered))
    +row("Local UDP listener :19132",bool(b.localUdpListening))
    +row("Local TCP listener :19132",bool(b.localTcpListening))
    +row("Paper whitelist enabled",bool(b.whitelistEnabled)):"";
  return panel("Bedrock · Geyser connection",
    `${pill(esc(indicator),ok?"":"warn")}${detail}${checks}
    ${row("Saved Bedrock address",source)}
    ${row("Friend can reach server", "Not verified remotely")}
    ${b?.whitelistEnabled?notice("<strong>Whitelist is enabled:</strong> Add your friend with <code>fwhitelist add BedrockGamertag</code> in Live Console. Ordinary Java whitelisting may not authorize Floodgate players."):''}
    <p class="field-tip" style="margin:12px 0 16px">Green signaling confirms Geyser registered with Playit, not that Bedrock players can join. Your friend must use the Bedrock (NetherNet) tunnel address and port 19132. If whitelist is enabled, use <code>fwhitelist add Gamertag</code> in Live Console. Secrets are not displayed.</p>
    <div class="header-actions" style="justify-content:flex-start">
    ${btn("↻ Check Geyser connection","check-geyser","primary",!online)}
    </div>`,
    ok?pill("● SIGNALING CONNECTED",""):pill("◷ NOT VERIFIED","warn"));
}

function drawOverview(){
  const main=latestServerRun(),live=currentPaper(),online=connectedLive();
  const github=state.github.connected;
  const runnerStarted=main&&(main.run_started_at||main.created_at);
  const runnerElapsed=activeRun(main)&&runnerStarted
    ?Math.max(0,Math.floor((Date.now()-new Date(runnerStarted).getTime())/1000)):null;
  const pendingOperation=operationSnapshot();
  const operationTitle=pendingOperation?{starting:"Starting server",stopping:"Stopping server",restarting:"Restarting server",restoring:"Restoring world"}[pendingOperation.kind]:null;
  const status=operationTitle|| (online?"Paper online":activeRun(main)?"Runner active · Paper unverified":main?.conclusion==="failure"?"Latest server run failed":main?.conclusion==="success"?"Last session finished":github?"No active Minecraft runner":"GitHub not connected");
  const statePill=pendingOperation?pill("◉ "+pendingOperation.kind.toUpperCase(),"warn"):online?pill("● LIVE SERVER",""):activeRun(main)?pill("◉ GITHUB RUN ACTIVE","warn"):main?.conclusion==="failure"?pill("● WORKFLOW FAILED","warn"):pill("○ NO LIVE PAPER DATA");
  const desc=pendingOperation?"Server lifecycle in progress. Follow the stage indicator above for the latest confirmed step.":online?(directOnline()?"Paper connected directly over NetBird, independently of Cloudflare.":"Paper is responding through Cloudflare."):activeRun(main)?"GitHub confirms a workflow is active, but it does not verify that Paper is ready. Use GitHub logs to check startup.":main?.conclusion==="failure"?"GitHub reports the last Minecraft workflow failed. Open its job logs below to identify the problem.":github?"GitHub is connected; there is no confirmed live Paper heartbeat. Start a new run only if no Minecraft workflow is active.":"Connect GitHub to manage workflows. GitHub access does not provide a live Paper connection.";
  const hero=`<div class="hero"><div class="hero-top"><div><div class="hero-label">SERVER STATUS</div><div class="hero-title">${esc(status)}</div></div>${statePill}</div><div class="hero-desc">${desc}</div><div class="hero-actions">${btn("▶ Start server","start-server","primary",serverRunning())} ${btn("↻ Safe restart","restart-server","",!connectedLive())} ${btn("■ Save & stop","stop-server","danger",!serverRunning()||!connectedLive())} ${main?btn("◷ View Minecraft logs","server-logs","flat"):""}</div></div>`;
  const stats=`<div class="stats">
   ${stat("Online players",online&&!pendingOperation?(live.players||[]).length:"—",online?"Connected to Paper":"Live connection required","♙")}
   ${stat("Server uptime",clockDisplay("uptime"),"Current runner session","◷","uptime")}
   ${stat("Empty time",clockDisplay("emptyFor"),"Restart after 1 hour empty","⌛","empty")}
   ${stat("Memory used",online&&!pendingOperation&&live.memoryMiB!=null?Number(live.memoryMiB).toFixed(0)+" MB":"—","Paper Java process","▦")}
   ${stat("CPU used",online&&!pendingOperation&&Number.isFinite(live.cpuPercent)?Number(live.cpuPercent).toFixed(1)+"%":"—","Paper process · 100% = one CPU core","◈")}
   ${stat("Runner disk free",online&&!pendingOperation&&Number.isFinite(live.diskFreeMiB)?(Number(live.diskFreeMiB)/1024).toFixed(1)+" GiB":"—","Temporary runner storage · not backup capacity","▤")}
   ${stat("Paper TPS",online&&!pendingOperation&&live.tps!=null&&Number.isFinite(Number(live.tps))?Number(live.tps).toFixed(2):"—","Actual Paper tick rate · target 20","◉")}
   ${stat("Paper MSPT",online&&!pendingOperation&&live.mspt!=null&&Number.isFinite(Number(live.mspt))?Number(live.mspt).toFixed(1)+" ms":"—","Actual average tick duration · target below 50 ms","◷")}
  </div>`;
  const runnerCard=main?panel("GitHub runner · independent status",`<div class="list-stat"><span>Latest Minecraft run</span><strong>#${esc(main.run_number)}</strong></div><div class="list-stat"><span>Workflow status</span><strong>${esc(main.conclusion||main.status||"unknown")}</strong></div><div class="list-stat"><span>Workflow elapsed (approx.)</span><strong data-live="runner">${runnerElapsed!==null?duration(runnerElapsed):"—"}</strong></div><p class="field-tip" style="margin-top:14px">Workflow elapsed is estimated from GitHub timestamps and may include queue time; it is not Paper uptime. Minecraft player and memory metrics require a functioning live bridge.</p><button class="btn small flat" data-action="server-logs">View GitHub job logs</button>`):"";
  const runs=state.overview?.runs||[];
  const recent=runs.slice(0,5);
  const actions=`<div class="columns">
   ${panel("Recent activity",recent.length?`<div class="run-list">${recent.map(r=>runRow(r)).join("")}</div>`:boxEmpty("No runs loaded","Connect your GitHub account to see recent activity.","⎇"),`<button class="btn small flat" data-page="workflows">View all →</button>`)}
   ${panel("Connection health",`<div class="list-stat"><span>GitHub</span><strong>${github?"● Connected":"○ Not connected"}</strong></div><div class="list-stat"><span>Direct Paper · NetBird</span><strong>${directOnline()?"● Connected":"○ Not connected"}</strong></div>${!directOnline()&&state.directError?`<p class="field-tip" style="margin:10px 0 12px;color:#ae624f">Direct connection: ${esc(state.directError)}</p>`:""}<div class="list-stat"><span>Cloudflare bridge</span><strong>${state.cloud?.bridge?.status?.ready?"● Connected":"○ Offline / unavailable"}</strong></div><div class="list-stat"><span>NetBird live stream</span><strong>${state.directStreamConnected?"● Streaming":directOnline()?"◷ Polling":"○ Not connected"}</strong></div><div class="list-stat"><span>Last direct heartbeat</span><strong>${state.directFetchedAt?Math.floor((Date.now()-state.directFetchedAt)/1000)+" s ago":"—"}</strong></div><div class="list-stat"><span>Minecraft workflow</span><strong>${main?esc(main.conclusion||main.status||"unknown"):"—"}</strong></div><div class="list-stat"><span>Latest run</span><strong>${main?esc("#"+main.run_number):"—"}</strong></div><div class="list-stat"><span>World backups</span><strong>${(state.overview?.artifacts||[]).filter(a=>!a.expired).length}</strong></div><p class="field-tip" style="margin-top:18px">GitHub workflow management works without Cloudflare. Safe live commands need a working server bridge.</p>`)}
   </div>`;
  $("#content").innerHTML=header("SERVER","Overview","Manage your server, plugins, files and backups.",btn("↻ Refresh","refresh","flat"))+hero+recoveryWarning()+stats+(online&&!pendingOperation?resourceHistory():"")+runnerCard+bedrockHealthPanel()+startupDiagnostics()+actions;
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
  window.McMarketplace.render(directOnline(),currentPaper()?.session||null);
  window.McMarketplace.ensureLoaded();
}
function drawFiles(){
  window.ServerManager.renderFiles(directOnline(),serverRunning());
}
function drawPlayers(){
  window.PlayerManager.show(directOnline(),serverRunning(),currentPaper());
}
function drawSettings(){
  window.ServerManager.renderSettings();
}
async function loadWorlds(force=false){
  if(state.worldsLoading||!directOnline())return;
  const session=state.direct?.session||null;
  if(!force&&state.worldsSession===session&&Date.now()-state.worldsFetchedAt<60000)return;
  state.worldsLoading=true;
  state.worldsError="";
  try{
    const response=await invoke("direct_command",{kind:"worlds-list",args:{}});
    if(!response?.ok||!Array.isArray(response.result))throw Error("Invalid world inventory reply");
    state.worlds=response.result.slice(0,3);
    state.worldsSession=session;
  }catch(error){
    state.worldsError=errorText(error);
    state.worlds=null;
  }finally{
    // Cache failures briefly too, so a failed connection cannot cause an
    // endless fetch-render-fetch loop on the Backups page.
    state.worldsSession=session;
    state.worldsFetchedAt=Date.now();
    state.worldsLoading=false;
    if(state.page==="backups"&&!editing())render();
  }
}
function drawAutomation(){window.ServerAutomations.render();}
function drawBackups(){
  const artifacts=(state.overview?.artifacts||[]).filter(a=>!a.expired&&a.name==="minecraft-world").sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const connected=directOnline(),session=state.direct?.session||null;
  if(connected&&!state.worldsLoading&&(state.worldsSession!==session||Date.now()-state.worldsFetchedAt>=60000)){
    loadWorlds();
  }
  const worldRows=connected&&state.worldsSession===session&&Array.isArray(state.worlds)?
    state.worlds.map(w=>`<div class="list-stat"><span>${esc(w.name||"World")}
       ${w.hasLevelDat?"· level.dat present":""}${w.truncated?" · partial scan":""}</span>
       <strong>${esc(w.sizeMiB??"—")} MiB · ${esc(w.files??"—")} files</strong></div>`).join(""):"";
  const worldPanel=panel("World storage",worldRows||`<p class="field-tip">${esc(
    !connected?"Connect directly to Paper to inspect world storage.":
    state.worldsLoading?"Reading world storage…":state.worldsError||"No world directories found."
  )}</p>`,connected?btn("↻ Refresh worlds","refresh-worlds","small flat"):"");
  $("#content").innerHTML=header("BACKUPS","World Backups","Download saved world snapshots.",btn("↻ Refresh","refresh","flat"))
   +notice("<strong>Important:</strong> Always wait for the server to finish saving and uploading a verified backup before shutting it down. Download critical backups to your own PC.")
   +(state.restoreMessage?notice(esc(state.restoreMessage),!state.restoreInProgress):"")
   +worldPanel
   +panel("Available snapshots",artifacts.length?`<div class="run-list">${artifacts.map(a=>`<div class="run"><div class="run-icon">▤</div><div class="run-content"><strong>${esc(when(a.created_at))}</strong><span>Run #${esc(a.workflow_run?.id||"—")} · ${esc(bytes(a.size_in_bytes))}</span></div><div class="row-buttons"><button class="btn small primary" data-action="restore-backup" data-id="${Number(a.workflow_run?.id||0)}" ${state.restoreInProgress||!a.workflow_run?.id?"disabled":""}>Restore</button><button class="btn small flat" data-action="download" data-id="${Number(a.id)}">↓ Download ZIP</button></div></div>`).join("")}</div>`:boxEmpty("No snapshots found","Snapshots appear after a successful safe save and backup.","◷"));
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
   `<div style="margin-top:16px">${bedrockHealthPanel()}</div>`+
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
  const titles={overview:"Overview",console:"Live Console",workflows:"GitHub Actions",files:"Server Files",players:"Players",settings:"Server Settings",marketplace:"Plugins & Datapacks",backups:"World Backups",automation:"Automations",connections:"Connections"};
  $("#breadcrumb").textContent=titles[state.page]||"Overview";
  document.querySelectorAll(".nav").forEach(el=>el.classList.toggle("active",el.dataset.page===state.page));
  $("#githubDot").classList.toggle("ok",state.github.connected);$("#githubShort").textContent=state.github.connected?"GitHub connected":"GitHub not connected";
  $("#cloudDot").classList.toggle("ok",connectedLive());$("#cloudDot").classList.toggle("warn",!connectedLive()&&!!state.cloud);
  $("#cloudShort").textContent=connectedLive()?"Live bridge online":"Live bridge unavailable";
  const pages={overview:drawOverview,console:drawConsole,workflows:drawWorkflows,files:drawFiles,players:drawPlayers,settings:drawSettings,marketplace:drawMarketplace,backups:drawBackups,automation:drawAutomation,connections:drawConnections};
  (pages[state.page]||drawOverview)();
  restoreDrafts();
  syncUpdateButton();
  syncServerOperation();
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
  try{state.cloud=await run("cloudflare_status",{}, {quiet});state.cloudFetchedAt=Date.now();state.cloudError=null;if(!directOnline()){recordMetric(state.cloud?.bridge?.status);observeLiveClock(state.cloud?.bridge?.status,state.cloudFetchedAt);}}
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
    syncServerOperation();
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
      recordMetric(next);
      loadHistoricalMetrics();
      observeLiveClock(next,state.directFetchedAt);
      syncServerOperation();
      const changes=JSON.stringify({
        ready:previous?.ready,session:previous?.session,players:previous?.players,
        phase:previous?.phase,memoryMiB:previous?.memoryMiB
      })!==JSON.stringify({
        ready:next.ready,session:next.session,players:next.players,
        phase:next.phase,memoryMiB:next.memoryMiB
      });
      if(state.page==="console")updateConsoleOutput();
      if(changes&&["overview","connections","players"].includes(state.page)&&!editing())render();
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
  try{await window.__TAURI__.event.listen("server-restore-progress",event=>{
    state.restoreMessage=String(event.payload?.message||"Restoring backup…");
    syncServerOperation();
    if(state.page==="backups")render();
  });}catch{}
  await Promise.all([loadNetbirdAuto(),loadDirectPeerConfig()]);
  render();await refresh(true);
  if(state.github.connected)checkDesktopUpdate(true);
  if(!state.github.connected){state.page="connections";render();}
}
async function action(type,id){
  switch(type){
  case "refresh":return refresh();
  case "check-update":return quickUpdate();
  case "check-geyser":{
    if(!connectedLive())return flash("Connect to the live Paper server before testing Geyser.");
    try{
      if(directOnline()){
        const check=await run("direct_command",{kind:"bedrock-diagnostics",args:{}});
        if(check?.result)state.direct={...state.direct,bedrock:check.result};
      }else{
        await loadCloud(false);
      }
      render();
      const health=currentPaper()?.bedrock;
      flash(health?.message||"Geyser health is not available from this runner. Start a new server session with the latest code.");
    }catch(error){flash("Geyser check failed: "+errorText(error));}
    return;
  }
  case "spark-profile":{
    if(!connectedLive())return flash("Connect to Paper before running diagnostics.");
    if(!await dialog("Profile Paper for 60 seconds?","This runs the Spark profiler on the live server for one minute. It may add slight load; the report appears in Live Console."))return;
    try{
      const result=await sendPaper("console",{command:"spark profiler start --timeout 60"});
      if(result?.ok===false)throw Error(result?.error||"Paper rejected the command");
      flash("Spark profiling requested. Check Live Console after one minute for the report.");
    }catch(error){flash("Could not start Spark: "+errorText(error));}
    return;
  }
  case "market-restart":{
    if(!connectedLive())return flash("Server must be connected to restart safely.");
    if(!await dialog("Safely restart Paper?","Players will be kicked, the world saved and backed up, and the server restarted to load your newly installed plugins."))return;
    try{await sendPaper("restart");beginOperation("restarting");flash("Safe plugin activation restart requested.");}catch{}
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
    if(serverRunning())return flash("Server is already running or starting.");
    if(!state.github.connected)return flash("Connect GitHub first.");
    if(!await dialog("Start Minecraft server?","Start Paper from the latest verified world backup, including queued settings, files and Modrinth installs?"))return;
    try{await run("github_dispatch",{workflowId:"paper-state-test.yml"});beginOperation("starting");flash("Minecraft workflow requested.");setTimeout(()=>refresh(true),1500);}catch{}return;
  }
  case "restart-server":case "stop-server":{
    if(!serverRunning())return flash("The Minecraft server is already stopped.");
    if(!connectedLive())return flash("Safe control requires a working live bridge. Do not force-cancel the workflow or risk world data.");
    const kind=type==="restart-server"?"restart":"shutdown";
    if(!await dialog(kind==="restart"?"Safely restart Minecraft?":"Safely save and stop?","This asks the live server agent to disconnect players, save all world data and upload a verified backup before the session ends."))return;
    try{await sendPaper(kind);beginOperation(kind==="restart"?"restarting":"stopping");flash("Safe operation requested; progress is shown above.");}catch{}return;
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
  case "restore-backup":{
    const backups=(state.overview?.artifacts||[]).filter(a=>a.name==="minecraft-world"&&!a.expired);
    const backup=backups.find(a=>String(a.workflow_run?.id)===String(id));
    if(!backup)return flash("Selected backup is unavailable or expired.");
    const live=serverRunning();
    const explanation="Restore snapshot from "+when(backup.created_at)+" (run #"+id+")? "+
      (live?"The current server will save, stop safely, upload its latest world backup, then start from the selected older snapshot.":"The server will start from the selected snapshot.")+
      " Newer world progress will not appear in the restored world. You can still download existing backups.";
    if(!await dialog("Restore world backup?",explanation))return;
    state.restoreInProgress=true;state.restoreMessage="Preparing verified restore…";
    beginOperation("restoring");
    render();
    try{
      await run("server_restore_backup",{runId:Number(id)});
      state.restoreMessage="Restore dispatched. Paper will start from the selected backup.";
      flash(state.restoreMessage);
      await refresh(true);
    }catch(error){
      state.restoreMessage="Restore failed: "+errorText(error);
      flash(state.restoreMessage);
    }finally{state.restoreInProgress=false;if(state.page==="backups")render();}
    return;
  }
  case "refresh-worlds":{await loadWorlds(true);return;}
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
setInterval(()=>{tickLiveUI();syncServerOperation()},1000);
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
