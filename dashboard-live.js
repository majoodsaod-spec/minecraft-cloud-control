"use strict";
// Browser stores the admin password only for the current tab. GitHub token stays in Cloudflare.
let cloudPassword = sessionStorage.getItem("mccloud-admin") || "";
let cloudState = null;
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
  try {
    cloudState=await cloudApi("status");
    const badge=document.querySelector(".top .badge");
    if(badge) badge.innerHTML='<span class="dot"></span> '+(cloudState.active.length?"Workflow running":"Connected to GitHub");
    const foot=document.querySelector(".navfoot");
    if(foot) foot.textContent="Cloudflare ↔ GitHub controls enabled";
    if(showToast) toast("Latest GitHub status loaded");
    render();
  } catch(e) {
    cloudState=null;
    if(showToast) toast(e.message);
  }
}
async function cloudAction(action, data, promptText) {
  if(promptText && !confirm(promptText))return;
  try {
    const result=await cloudApi(action,data);
    toast(result.message||"Request accepted");
    await cloudRefresh();
  } catch(e) {toast(e.message)}
}
function cloudUnlock(parent) {
  const box=element("div","panel section");
  box.innerHTML='<h2>Connect Cloudflare controls</h2><p class="muted small">Enter the admin password configured in Cloudflare Pages. The password stays in this browser tab. GitHub credentials stay on the Cloudflare backend.</p>';
  const input=element("input"); input.type="password"; input.autocomplete="off"; input.placeholder="Cloudflare admin password";
  const btn=button("Connect",async()=>{
    cloudPassword=input.value;
    try {
      cloudState=await cloudApi("status");
      sessionStorage.setItem("mccloud-admin",cloudPassword);
      toast("Dashboard connected");render();
    }catch(e){cloudPassword="";toast(e.message)}
  },"primary");
  box.append(input,btn);parent.prepend(box);
}
const previewOverview=overview;
overview=function(p){
  if(!cloudState){previewOverview(p);cloudUnlock(p);return}
  const active=cloudState.active;
  const cards=element("div","grid two");
  for(const [key,value] of [["GitHub Workflow",active.length?"Running / queued":"Stopped"],["Backups kept",String(cloudState.backups.length)],["Paper version","26.3"],["Runtime","GitHub Actions"]]){
    const c=element("div","panel stat");c.append(element("span","",key),element("b","",value));cards.append(c)
  }
  p.append(cards);
  const section=element("div","panel section");
  section.append(element("h2","","Server control"));
  addNotice(section,"Start and Stop control GitHub Actions, not the live Minecraft console. Cancelling a run can lose progress since its last verified backup. Settings apply on a new server session.");
  const actions=element("div","flex");
  actions.append(button("▶ Start",()=>cloudAction("start",{},"Start a new Minecraft server workflow?"),"primary"));
  for(const r of active) {
    actions.append(button("■ Stop run "+r.id,()=>cloudAction("stop",{run_id:r.id},"Cancel this run? Progress since its last successful backup may be lost."),"danger"));
  }
  actions.append(button("↻ Refresh status",()=>cloudRefresh(true),"outline"));
  actions.append(button("⚙ Configure server",()=>{tab="settings";render()},"outline"));
  section.append(actions);
  const tip=element("p","small muted","Backups are created at graceful scheduled shutdown, not on demand. For a safe backup, use the regular 5h30m or idle restart.");
  section.append(tip);
  if(cloudState.latest){
    const link=element("a","small", "Open latest GitHub run #"+cloudState.latest.id);
    link.href=cloudState.latest.html_url;link.target="_blank";link.rel="noopener noreferrer";section.append(link)
  }
  p.append(section);
};
const previewSettings=settingsPage;
settingsPage=function(p){
  previewSettings(p);
  if(!cloudState){cloudUnlock(p);return}
  const section=element("div","panel section");
  section.append(element("h2","","Apply settings to GitHub"));
  addNotice(section,"Only supported server.properties settings are sent. Paper-specific placeholders, plugins, and files are not uploaded. Changes take effect when the next Paper session starts.");
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
if(cloudPassword)cloudRefresh();
