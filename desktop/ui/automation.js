/* Opt-in server automation. GitHub stores configuration; no background
   Windows task or local scheduler is required. */
(function(){
"use strict";
const invoke=(name,args={})=>window.__TAURI__.core.invoke(name,args);
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const file="server/automation-policy.json";
const days=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const state={config:null,sha:null,loading:false,saving:false,error:"",notice:"",loaded:false};
const root=()=>document.querySelector("#automation-root");
function render(){
  const content=document.querySelector("#content");
  if(!content)return;
  const policy=state.config||{enabled:false,weekday_utc:6,hour_utc:3};
  content.innerHTML='<section id="automation-root" class="server-manager">'+
    '<div class="page-header"><div><div class="eyebrow">SERVER</div><h1>Automations</h1>'+
    '<p>Schedule safe world maintenance without interrupting players.</p></div>'+
    '<div class="header-actions"><button class="btn" data-auto-action="refresh">Refresh</button>'+
    '<button class="btn primary" data-auto-action="save" '+(!state.loaded||state.saving?"disabled":"")+
    '>Save schedule</button></div></div>'+
    '<div class="notice"><strong>Safety:</strong> weekly maintenance is opt-in and only starts when no players are online. The server uses the normal save, verified backup, and restart workflow. Times are in UTC.</div>'+
    (state.error?'<div class="server-manager-message error">'+esc(state.error)+'</div>':"")+
    (state.notice?'<div class="server-manager-message">'+esc(state.notice)+'</div>':"")+
    '<section class="panel"><h2 class="panel-title">Weekly maintenance</h2>'+
    '<div class="server-setting-grid">'+
    '<label class="field">Enable automatic maintenance'+
      '<input type="checkbox" id="automation-enabled" '+(policy.enabled?"checked ":"")+
      (!state.loaded||state.saving?"disabled":"")+'></label>'+
    '<label class="field">Day (UTC)<select id="automation-weekday" '+(!state.loaded||state.saving?"disabled":"")+'>'+
      days.map((day,i)=>'<option value="'+i+'" '+(policy.weekday_utc===i?"selected":"")+'>'+day+'</option>').join("")+'</select></label>'+
    '<label class="field">Start hour (UTC)<select id="automation-hour" '+(!state.loaded||state.saving?"disabled":"")+'>'+
      Array.from({length:24},(_,i)=>'<option value="'+i+'" '+(policy.hour_utc===i?"selected":"")+'>'+String(i).padStart(2,"0")+':00</option>').join("")+'</select></label>'+
    '</div><p class="field-tip">Maintenance is attempted only in the first 15 minutes of the selected hour, and only while empty. If players are online, the window is skipped. The next verified world snapshot stores the maintenance receipt so the same week is not repeated.</p>'+
    '</section></section>';
  if(!state.loaded&&!state.loading)load();
}
async function load(){
  if(state.loading)return;
  state.loading=true;state.error="";
  try{
    const response=await invoke("github_file",{path:file});
    const parsed=JSON.parse(atob(String(response.content||"").replace(/\s/g,"")));
    const policy=parsed?.weekly_maintenance;
    if(!policy||typeof policy.enabled!=="boolean"||
      !Number.isInteger(policy.weekday_utc)||!Number.isInteger(policy.hour_utc)||
      policy.weekday_utc<0||policy.weekday_utc>6||policy.hour_utc<0||policy.hour_utc>23){
      throw Error("Invalid automation configuration");
    }
    state.config={...policy};
    state.sha=String(response.sha||"");
    state.loaded=true;
  }catch(error){
    state.error=String(error).slice(0,220);
    state.loaded=false;
  }finally{state.loading=false;if(root())render();}
}
async function save(){
  if(state.saving||!state.loaded||!state.sha)return;
  const enabled=Boolean(document.querySelector("#automation-enabled")?.checked);
  const weekday_utc=Number(document.querySelector("#automation-weekday")?.value);
  const hour_utc=Number(document.querySelector("#automation-hour")?.value);
  if(!Number.isInteger(weekday_utc)||weekday_utc<0||weekday_utc>6||
     !Number.isInteger(hour_utc)||hour_utc<0||hour_utc>23)return;
  if(!window.confirm((enabled?"Enable":"Disable")+" weekly empty-server maintenance on "+
      days[weekday_utc]+" at "+String(hour_utc).padStart(2,"0")+":00 UTC?\n\n"+
      "Changes apply when a new Paper runner starts."))return;
  state.saving=true;state.error="";
  try{
    const payload={weekly_maintenance:{enabled,weekday_utc,hour_utc}};
    await invoke("github_save_file",{args:{
      path:file,sha:state.sha,content_base64:btoa(JSON.stringify(payload,null,2)+"\n"),
      message:"chore(automation): update weekly maintenance schedule"
    }});
    state.notice="Automation configuration saved. It will apply on the next runner startup.";
    state.loaded=false;
    await load();
  }catch(error){state.error=String(error).slice(0,220);}
  finally{state.saving=false;if(root())render();}
}
document.addEventListener("click",event=>{
  const button=event.target.closest("[data-auto-action]");
  if(!button||!root())return;
  if(button.dataset.autoAction==="refresh"){state.loaded=false;load();}
  if(button.dataset.autoAction==="save")save();
});
window.ServerAutomations={render,load};
})();
