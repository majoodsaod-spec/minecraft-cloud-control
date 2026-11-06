"use strict";
// Browser stores the admin password only for the current tab. GitHub token stays in Cloudflare.
let cloudPassword = sessionStorage.getItem("mccloud-admin") || "";
let cloudState = null;
let cloudLastUpdate = 0;
let cloudRefreshing = false;
let cloudBusy = false;
let cloudError = "";
async function cloudApi(action, payload) {
  const response = await fetch("/api/control?action=" + encodeURIComponent(action), {
    method: payload ? "POST" : "GET",
    headers: {"Content-Type":"application/json","X-Admin-Password":cloudPassword},
    body: payload ? JSON.stringify(payload) : undefined,
    cache:"no-store"
  });
  const data = await response.json().catch(()=>({error:"Backend returned invalid response"}));
  if(!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function cloudRefresh(showToast=false) {
  if(!cloudPassword || cloudRefreshing)return;
  cloudRefreshing=true;
  try {
    const fresh=await cloudApi("status");
    cloudState=fresh;
    cloudLastUpdate=Date.now();
    cloudError="";
    const badge=document.querySelector(".top .badge");
    if(badge) badge.innerHTML='<span class="dot"></span> '+(cloudState.active.length?"Workflow running":"Connected to GitHub");
    const foot=document.querySelector(".navfoot");
    if(foot) foot.textContent="Live server controls connected";
    if(showToast) toast("Latest GitHub status loaded");
    if(["worlds","about"].includes(tab)) render();
  } catch(e) {
    cloudError=e.message;
    if(/Unauthorized|not configured/i.test(e.message)){
      cloudState=null;
      cloudPassword="";
      sessionStorage.removeItem("mccloud-admin");
    }
    if(showToast) toast(e.message);
    if(["overview","worlds","about"].includes(tab))render();
  } finally {
    cloudRefreshing=false;
  }
}
async function cloudAction(action, data, promptText) {
  if(cloudBusy || (promptText && !confirm(promptText)))return;
  cloudBusy=true;
  try {
    const result=await cloudApi(action,data);
    toast(result.message||"Request accepted");
    await cloudRefresh();
  } catch(e) {toast(e.message)}
  finally {cloudBusy=false}
}
function cloudUnlock(parent) {
  const box=element("div","panel section");
  box.innerHTML='<div class="dashboard-kicker">SECURE CONNECTION</div><h2>Connect Minecraft Cloud</h2><p class="muted small">Enter the administrator password from your Cloudflare Worker secrets. Your private control credentials stay on the server.</p>';
  const input=element("input"); input.type="password"; input.autocomplete="off"; input.placeholder="Cloudflare admin password";
  const btn=button("Connect",async()=>{
    cloudPassword=input.value;
    try {
      cloudState=await cloudApi("status");
      sessionStorage.setItem("mccloud-admin",cloudPassword);
      toast("Dashboard connected");render();
    }catch(e){cloudPassword="";toast(e.message)}
  },"primary");
  const form=element("form","connect-form");
  input.autocomplete="current-password";
  form.append(input,btn);
  btn.type="button";
  form.onsubmit=e=>{e.preventDefault();btn.click()};
  box.append(form);
  if(cloudError) box.append(element("p","notice",cloudError));
  parent.prepend(box);
}
const previewOverview=overview;
overview=function(p){
  if(!cloudState){cloudUnlock(p);return}
  const active=cloudState.active;
  const hero=element("div","dashboard-hero");
  const heroText=element("div");
  heroText.append(element("div","dashboard-kicker","PAPER 26.3 · JAVA 25 · GITHUB ACTIONS"));
  heroText.append(element("h2","",active.length?"Minecraft workflow active":"Minecraft workflow stopped"));
  heroText.append(element("p","muted small",active.length?"The runner is queued or running; Paper readiness is shown in GitHub logs.":"Start a new workflow to restore the newest world and launch Paper."));
  hero.append(heroText);
  hero.append(element("span","status-label "+(active.length?"good":"waiting"),active.length?"Workflow active":"Not running"));
  p.append(hero);
  const cards=element("div","status-grid");
  for(const [key,value] of [["GitHub Workflow",active.length?"Running / queued":"Stopped"],["Backups kept",String(cloudState.backups.length)],["Paper version","26.3"],["Runtime","GitHub Actions"]]){
    const c=element("div","panel stat");c.append(element("span","",key),element("b","",value));cards.append(c)
  }
  p.append(cards);
  if(cloudError)addNotice(p,"Last refresh failed: "+cloudError+" — showing the last known status.");
  if(cloudState.warnings && cloudState.warnings.length) {
    for(const warning of cloudState.warnings) addNotice(p, warning);
  }
  const section=element("div","panel section");
  section.append(element("h2","","Server control"));
  addNotice(section,"Safe Stop warns and kicks players, saves all data, stops Paper and uploads a verified backup. It will NOT dispatch another run. Start restores the latest backup before running. The Paper bridge must be online.");
  const actions=element("div","flex");
  const startBtn=button("▶ Start",()=>cloudAction("start",{},"Start a new Minecraft server workflow?"),"primary");
  startBtn.disabled=active.length>0;
  actions.append(startBtn);
  if(active.length){
    const live=cloudState.bridge?.status;
    const available=Boolean(live?.session && Date.now()-(live.updatedAt||0)<45000);
    const stopBtn=button("■ Save & Stop",()=>cloudAction("stop",{},"Kick everyone, save all player/world data, shut down Paper, back up, and remain offline?"),"danger");
    stopBtn.disabled=!available;
    stopBtn.title=available?"Graceful stop with verified backup":"Live Paper bridge offline. Unsafe cancellation is intentionally not offered here.";
    actions.append(stopBtn);
  }
  actions.append(button("↻ Refresh status",()=>cloudRefresh(true),"outline"));
  actions.append(button("⚙ Configure server",()=>{tab="settings";render()},"outline"));
  section.append(actions);
  const tip=element("p","small muted","After Save & Stop, the server remains offline until you press Start. Allow time for the workflow to finish uploading the new backup. This is not immediate cancellation.");
  section.append(tip);
  if(cloudState.latest){
    const link=element("a","small", "Open latest GitHub run #"+cloudState.latest.id);
    link.href=cloudState.latest.html_url;link.target="_blank";link.rel="noopener noreferrer";section.append(link)
  }
  p.append(section);
  p.append(element("p","dashboard-meta","Last checked: "+(cloudLastUpdate?new Date(cloudLastUpdate).toLocaleTimeString():"not yet")+" · Automatic refresh every 30 seconds while this tab is open."));
};
const previewSettings=settingsPage;
settingsPage=function(p){
  if(!cloudState){cloudUnlock(p);return}
  previewSettings(p);
  const section=element("div","panel section");
  section.append(element("h2","","Apply settings to GitHub"));
  addNotice(section,"Only supported server.properties settings are sent. Paper-specific placeholders, plugins, and files are not uploaded. Changes take effect when the next Paper session starts.");
  const load=button("Load saved server settings",()=>{
    if(!cloudState.properties){toast("No server.properties stored in GitHub yet");return}
    for(const line of cloudState.properties.split(/\r?\n/)){
      const i=line.indexOf("=");
      if(i<1||line.startsWith("#"))continue;
      const key=line.slice(0,i),val=line.slice(i+1);
      const spec=schema.find(x=>x[0]===key);
      if(!spec)continue;
      if(spec[3]==="bool")settings[key]=val==="true";
      else if(spec[3]==="number") {if(Number.isFinite(+val))settings[key]=Number(val)}
      else settings[key]=val;
    }
    persist();render();toast("Loaded GitHub settings");
  },"outline");
  load.disabled=!cloudState.properties;
  section.append(load);
  section.append(button("Save supported settings to server",()=>{
    const allowed=["motd","max-players","difficulty","gamemode","pvp","allow-flight","white-list","enforce-whitelist","online-mode","enable-command-block","spawn-protection","view-distance","simulation-distance","max-world-size","allow-nether","spawn-monsters","spawn-animals","spawn-npcs","hardcore","force-gamemode","player-idle-timeout"];
    const data=Object.fromEntries(allowed.map(k=>[k,settings[k]]));
    cloudAction("settings",{properties:data},"Commit these settings to GitHub? They will apply when the server next starts.");
  },"primary"));
  p.prepend(section);
};
worldsPage=function(p){
  if(!cloudState){cloudUnlock(p);addNotice(p,"Connect first to see real workflow backup artifacts.");return}
  const box=element("div","panel");
  box.append(element("h2","","GitHub world backup artifacts"));
  addNotice(box,"The workflow automatically removes older artifacts after a successful handoff, keeping the latest ten. Download an artifact from its workflow run on GitHub.");
  if(!cloudState.backups.length) box.append(element("p","muted","No uploaded backups found yet."));
  for(const x of cloudState.backups) {
    const row=element("div","rowsetting");
    const info=element("div");
    info.append(element("strong","",new Date(x.created_at).toLocaleString()));
    info.append(element("div","desc",(x.size_in_bytes/1048576).toFixed(1)+" MiB • Run "+x.run_id));
    row.append(info);
    const a=element("a","btn outline","View run");a.href="https://github.com/majoodsaod-spec/minecraft-cloud-control/actions/runs/"+x.run_id;
    a.target="_blank";a.rel="noopener noreferrer";row.append(a);box.append(row)
  }
  box.append(button("Refresh backups",()=>cloudRefresh(true)));
  p.append(box);
};
const oldAbout=aboutPage;
aboutPage=function(p){
  oldAbout(p);
  if(!cloudState){cloudUnlock(p);return}
  const section=element("div","panel section");
  section.append(element("h2","","Connected operations"));
  section.append(element("p","muted small","Working: GitHub workflow status, start, cancellation, backup listing, and updating supported server.properties values for the next run. Not yet connected: live player list, direct console commands, remote file manager, plugin upload, and RCON."));
  section.append(button("Disconnect this tab",()=>{sessionStorage.removeItem("mccloud-admin");cloudPassword="";cloudState=null;render()},"outline"));p.prepend(section);
};
render();
if(cloudPassword)cloudRefresh();
window.setInterval(()=>{
  if(!document.hidden && cloudPassword && !cloudBusy)cloudRefresh();
},30000);
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden&&cloudPassword&&Date.now()-cloudLastUpdate>=30000)cloudRefresh();
});
