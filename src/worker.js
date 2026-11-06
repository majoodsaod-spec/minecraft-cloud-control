import { MinecraftBridge } from "./bridge.js";
export { MinecraftBridge } from "./bridge.js";
// Cloudflare Worker handler. Credentials are Worker secrets, never browser assets.
// Required: ADMIN_PASSWORD, GITHUB_TOKEN. Optional: GITHUB_REPO.
const workflow = "paper-state-test.yml";
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" }
});
const encoder = new TextEncoder();
async function equals(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  return new Uint8Array(x).every((byte, i) => byte === new Uint8Array(y)[i]);
}
async function github(env, path, options = {}) {
  const repo = env.GITHUB_REPO || "majoodsaod-spec/minecraft-cloud-control";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository setting");
  const res = await fetch("https://api.github.com/repos/" + repo + path, {
    ...options,
    headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "minecraft-cloud-control", ...(options.headers || {}) }
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    throw new Error("GitHub " + res.status + ": " + text);
  }
  return res.status === 204 ? null : res.json();
}
const readText = data => {
  const raw = atob(data.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};
const encodeText = text => {
  const bytes = encoder.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
};
const bridgeStub = env => env.MC_BRIDGE.get(env.MC_BRIDGE.idFromName("primary"));
async function bridgeCall(env, route, value) {
  const response=await bridgeStub(env).fetch("https://bridge.internal/"+route,{
    method:value===undefined?"GET":"POST",
    headers:{"Content-Type":"application/json"},
    body:value===undefined?undefined:JSON.stringify(value)
  });
  const body=await response.json();
  if(!response.ok)throw Error(body.error||"Live control service unavailable");
  return body;
}
const liveCommands=new Set(["console","kick","ban","pardon","whitelist-add","whitelist-remove","whitelist-on","whitelist-off","op","deop","save","restart","shutdown","files-list","files-read","files-write","files-delete","files-mkdir","files-rename","files-upload","files-download","plugins-list"]);
function validateLiveCommand(body) {
  if(!body||!liveCommands.has(body.type))throw Error("Unknown control operation");
  const args=body.args||{};
  if(typeof args!=="object"||Array.isArray(args))throw Error("Invalid command arguments");
  if(body.type==="console" && (typeof args.command!=="string" || args.command.length>240 || /[\r\n]/.test(args.command)))throw Error("Invalid console command");
  if(["kick","ban","pardon","whitelist-add","whitelist-remove","op","deop"].includes(body.type) && !/^[A-Za-z0-9_]{3,16}$/.test(args.player||""))throw Error("Invalid Minecraft username");
  if(body.type.startsWith("files-") && !(body.type==="files-list" && (args.path==="." || args.path==="")) && (typeof args.path!=="string"||args.path.length>180||args.path.startsWith("/")||args.path.split("/").some(p=>!p||p==="."||p==="..")||args.path.split("").some(ch=>ch==="\\"||ch.charCodeAt(0)<32)))throw Error("Invalid file path");
  if(body.type==="files-write"&&(typeof args.content!=="string"||args.content.length>262144))throw Error("File content must be text, maximum 256 KiB");
  if(body.type==="files-rename" && (typeof args.target!=="string"||args.target.length>180||
      args.target.startsWith("/")||args.target.split("/").some(p=>!p||p==="."||p==="..")||
      /[\\\\\\x00-\\x1f]/.test(args.target)))throw Error("Invalid destination name");
  if(body.type==="files-upload"&&(typeof args.content!=="string"||args.content.length>350000||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(args.content)))throw Error("Invalid upload (maximum 256 KiB UTF-8 text)");

  return {type:body.type,args};
}
const allowedSettings = new Set(["motd","max-players","difficulty","gamemode","pvp","allow-flight","white-list","enforce-whitelist","online-mode","enable-command-block","spawn-protection","view-distance","simulation-distance","max-world-size","allow-nether","spawn-monsters","spawn-animals","spawn-npcs","hardcore","force-gamemode","player-idle-timeout"]);
async function handleControl(request, env) {
  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN)
    return json({error: "Backend not configured: set ADMIN_PASSWORD and GITHUB_TOKEN in Cloudflare Pages secrets."}, 503);
  const pass = request.headers.get("X-Admin-Password") || "";
  if (!await equals(pass, env.ADMIN_PASSWORD)) return json({error: "Unauthorized"}, 401);
  if (!["GET", "POST"].includes(request.method)) return json({error:"Method not allowed"},405);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  try {
    if (request.method === "GET" && action === "diagnostics") {
      const checks={
        bridgeSecretConfigured:typeof env.BRIDGE_TOKEN==="string" && env.BRIDGE_TOKEN.length>0,
        bridgeBindingConfigured:!!env.MC_BRIDGE,
        githubTokenConfigured:!!env.GITHUB_TOKEN,
        repository:env.GITHUB_REPO||"majoodsaod-spec/minecraft-cloud-control"
      };
      try{
        const state=await bridgeCall(env,"state");
        checks.bridgeStorageAvailable=true;
        checks.lastHeartbeat=state.status?.updatedAt||null;
        checks.currentPhase=state.status?.phase||"unknown";
      }catch(error){
        checks.bridgeStorageAvailable=false;
        checks.bridgeError=String(error.message||error).slice(0,200);
      }
      return json(checks);
    }
    if (request.method === "GET" && action === "live") {
      return json({bridge:await bridgeCall(env,"state")});
    }
    if (request.method === "GET" && action === "status") {
      // A failure to list artifacts must not hide server controls or recent runs.
      const [runsResult, artifactsResult, cfgResult, bedrockResult] = await Promise.allSettled([
        github(env, "/actions/workflows/" + workflow + "/runs?per_page=30"),
        github(env, "/actions/artifacts?name=minecraft-world&per_page=100"),
        github(env, "/contents/server/server.properties"),
        github(env, "/contents/server/bedrock.json")
      ]);
      if (runsResult.status === "rejected") {
        throw new Error("Cannot read GitHub workflow runs. Check that GITHUB_TOKEN has Actions: Read and write access to the correct private repository. " + runsResult.reason.message);
      }
      const runs = runsResult.value;
      const artifacts = artifactsResult.status === "fulfilled" ? artifactsResult.value : {artifacts:[]};
      const cfg = cfgResult.status === "fulfilled" ? cfgResult.value : null;
      const bedrockCfg = bedrockResult.status === "fulfilled" ? bedrockResult.value : null;
      const bedrock=bedrockCfg ? JSON.parse(readText(bedrockCfg)) : {host:"",port:19132};
      const warnings = [];
      if (artifactsResult.status === "rejected") {
        warnings.push("Cannot list GitHub backup artifacts. Check token repository access and Actions permissions. " + artifactsResult.reason.message);
      }
      const active = runs.workflow_runs.filter(r => ["queued","in_progress","waiting","requested","pending"].includes(r.status));
      const bridgeResult=await bridgeCall(env,"state").then(
        value=>({value,error:null}),
        error=>({value:{status:{},history:[],commands:[],desired:"on"},error})
      );
      if(bridgeResult.error){
        warnings.push("Live server connection is unavailable. Check Worker Durable Object deployment: "+String(bridgeResult.error.message||bridgeResult.error).slice(0,180));
      }
      const bridge=bridgeResult.value;
      return json({active: active.map(r=>({id:r.id,status:r.status,html_url:r.html_url,created_at:r.created_at})),
        latest: runs.workflow_runs[0] ? {id:runs.workflow_runs[0].id,status:runs.workflow_runs[0].status,conclusion:runs.workflow_runs[0].conclusion,html_url:runs.workflow_runs[0].html_url}: null,
        backups: artifacts.artifacts.filter(a=>!a.expired).slice(0,10).map(a=>({id:a.id,name:a.name,size_in_bytes:a.size_in_bytes,created_at:a.created_at,run_id:a.workflow_run?.id})),
        warnings,
        bridge,
        bedrock:{host:bedrock.host||"",port:bedrock.port||19132,configured:!!bedrock.host},
        properties: cfg ? readText(cfg) : null});
    }
    if (request.method === "GET") return json({error:"Unknown action"},404);
    const input = await request.json().catch(()=>({}));
    if(action==="live-command") {
      const data=validateLiveCommand(input);
      const state=await bridgeCall(env,"state");
      if(!state.status?.session||Date.now()-(state.status.updatedAt||0)>45000)
        return json({error:"Paper agent is offline; live commands require an active session."},409);
      return json(await bridgeCall(env,"enqueue",data),202);
    }
    const managedPlugins = new Set(["EssentialsX.jar","Chunky.jar","PerformanceAnalyzer.jar","LetMeDespawn.jar","Geyser-Spigot.jar","floodgate-spigot.jar"]);
    if(action==="plugin-upload") {
      const name=input.name,content=input.content;
      if(typeof name!=="string"||!name.endsWith(".jar")||name.length>80||!/^[A-Za-z0-9_.-]+$/.test(name)||name.startsWith("."))
        return json({error:"Invalid plugin filename"},400);
      if(managedPlugins.has(name))return json({error:"This plugin is managed automatically; use Enable/Disable instead."},409);
      if(typeof content!=="string"||content.length>7000000||!/^[A-Za-z0-9+/]*={0,2}$/.test(content))
        return json({error:"Plugin JAR too large (maximum 5 MiB per upload) or invalid"},400);
      const path="/contents/server/plugins/"+encodeURIComponent(name);
      const existing=await github(env,path).catch(err=>String(err).includes("GitHub 404:")?null:Promise.reject(err));
      await github(env,path,{method:"PUT",body:JSON.stringify({branch:"main",message:"Stage Paper plugin "+name+" from Minecraft Cloud",content,...(existing?{sha:existing.sha}:{})})});
      return json({ok:true,message:"Plugin saved. It will install at the next server restart."});
    }
    if(action==="plugin-remove") {
      const name=input.name;
      if(typeof name!=="string"||!name.endsWith(".jar")||name.length>80||!/^[A-Za-z0-9_.-]+$/.test(name))return json({error:"Invalid plugin filename"},400);
      if(managedPlugins.has(name))return json({error:"Built-in managed plugins can be disabled, not deleted."},409);
      const path="/contents/server/plugins/"+encodeURIComponent(name);
      const existing=await github(env,path);
      await github(env,path,{method:"DELETE",body:JSON.stringify({branch:"main",message:"Remove Paper plugin "+name,sha:existing.sha})});
      return json({ok:true,message:"Plugin removed from configuration; restart to apply."});
    }
    if(action==="plugin-list") {
      const listing=await github(env,"/contents/server/plugins").catch(err=>String(err).includes("GitHub 404:")?[]:Promise.reject(err));
      const stored=await github(env,"/contents/server/plugins/plugins-state.json").catch(err=>String(err).includes("GitHub 404:")?null:Promise.reject(err));
      const enabled=stored?JSON.parse(readText(stored)):{};
      const custom=Array.isArray(listing)?listing.filter(x=>x.type==="file"&&x.name.endsWith(".jar")&&!managedPlugins.has(x.name)).map(x=>({name:x.name,size:x.size,managed:false,enabled:enabled[x.name]!==false})):[];
      const standard=[...managedPlugins].map(name=>({name,size:null,managed:true,enabled:enabled[name]!==false}));
      return json({plugins:[...standard,...custom]});
    }
    if(action==="plugin-toggle") {
      const name=input.name,enabled=input.enabled;
      if(typeof name!=="string"||!name.endsWith(".jar")||name.length>80||!/^[A-Za-z0-9_.-]+$/.test(name)||typeof enabled!=="boolean")
        return json({error:"Invalid plugin settings"},400);
      if(!managedPlugins.has(name))await github(env,"/contents/server/plugins/"+encodeURIComponent(name));
      const file="server/plugins/plugins-state.json";
      const current=await github(env,"/contents/"+file).catch(err=>String(err).includes("GitHub 404:")?null:Promise.reject(err));
      const values=current?JSON.parse(readText(current)):{};
      values[name]=enabled;
      await github(env,"/contents/"+file,{method:"PUT",body:JSON.stringify({
        branch:"main",message:(enabled?"Enable ":"Disable ")+name+" on next startup",
        content:encodeText(JSON.stringify(values,null,2)+"\n"),...(current?{sha:current.sha}:{})
      })});
      return json({ok:true,message:name+(enabled?" enabled":" disabled")+" for the next server start"});
    }
    if(action==="bedrock-address"){
      const host=String(input.host||"").trim().toLowerCase();
      const port=Number(input.port);
      if(host && (host.length>253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith(".") || host.endsWith(".")))
        return json({error:"Enter a valid public Bedrock server address, without a protocol or port"},400);
      if(!Number.isSafeInteger(port)||port<1||port>65535)
        return json({error:"Port must be 1–65535"},400);
      const path="/contents/server/bedrock.json";
      const current=await github(env,path).catch(error=>String(error).includes("GitHub 404:")?null:Promise.reject(error));
      const next=JSON.stringify({host,port,note:"Public Bedrock tunnel address shown in Minecraft dashboard. Not a connectivity verification."},null,2)+"\n";
      await github(env,path,{method:"PUT",body:JSON.stringify({
        message:"Update Bedrock join address in server dashboard",branch:"main",
        content:encodeText(next),...(current?{sha:current.sha}:{})
      })});
      return json({ok:true,message:host?"Bedrock address saved. Share only after testing your Playit tunnel.":"Bedrock address cleared."});
    }
    if (action === "restore") {
      const run=Number(input.run_id);
      if(!Number.isSafeInteger(run)||run<=0)return json({error:"Select a valid backup"},400);
      const recent=await github(env,"/actions/artifacts?name=minecraft-world&per_page=100");
      const selected=recent.artifacts.find(a=>!a.expired&&a.workflow_run?.id===run);
      if(!selected)return json({error:"This backup is missing or expired"},404);
      const runs=await github(env,"/actions/workflows/"+workflow+"/runs?per_page=30");
      if(runs.workflow_runs.some(r=>["queued","in_progress","waiting","requested","pending"].includes(r.status)))
        return json({error:"Stop the current server safely and finish its backup before restoring an older world"},409);
      await bridgeCall(env,"desired",{desired:"on"});
      await github(env,"/actions/workflows/"+workflow+"/dispatches",{method:"POST",body:JSON.stringify({ref:"main",inputs:{previous_run:String(run)}})});
      return json({ok:true,message:"Restore requested. The selected backup will become the world for the next server session."});
    }
    if (action === "start") {
      const latest=await github(env,"/actions/workflows/"+workflow+"/runs?per_page=30");
      if(latest.workflow_runs.some(r=>["queued","in_progress","waiting","requested","pending"].includes(r.status)))
        return json({error:"The Minecraft server is already starting or running"},409);
      await bridgeCall(env,"desired",{desired:"on"});
      await github(env, "/actions/workflows/" + workflow + "/dispatches", {method:"POST",body:JSON.stringify({ref:"main"})});
      return json({ok:true,message:"Server startup requested"});
    }
    if (action === "stop") {
      const state=await bridgeCall(env,"state");
      if(!state.status?.session || Date.now()-(state.status.updatedAt||0)>45000)
        return json({error:"Paper runner is offline. Cannot safely save and stop; no cancellation was sent."},409);
      await bridgeCall(env,"desired",{desired:"off"});
      await bridgeCall(env,"enqueue",{type:"shutdown",args:{}});
      return json({ok:true,message:"Safe shutdown requested: kick players, save all, stop Paper, upload verified backup, stay offline."},202);
    }
    if (action === "settings") {
      const body = input.properties;
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Invalid settings"},400);
      const lines = [];
      for (const [key, val] of Object.entries(body)) {
        if (!allowedSettings.has(key)) return json({error:"Unsupported setting: " + key},400);
        if (!["string","number","boolean"].includes(typeof val) || String(val).length > 200 || /[\r\n]/.test(String(val)))
          return json({error:"Invalid setting value: " + key},400);
        if (key === "online-mode" && val !== true) return json({error:"Online-mode must stay enabled"},400);
        lines.push(key+"="+val);
      }
      const file = "server/server.properties";
      const current = await github(env, "/contents/" + file).catch(err => {
        if (String(err).includes("GitHub 404:")) return null;
        throw err;
      });
      const content = current ? readText(current) : "";
      const values = new Map(content.split(/\r?\n/).filter(x=>x.includes("=")&&!x.startsWith("#")).map(x=>{const p=x.indexOf("=");return [x.slice(0,p),x.slice(p+1)];}));
      for (const line of lines) {const p=line.indexOf("=");values.set(line.slice(0,p),line.slice(p+1));}
      values.set("online-mode","true");
      const next = [...values].map(([k,v])=>k+"="+v).join("\n")+"\n";
      await github(env, "/contents/" + file, {method:"PUT",body:JSON.stringify({message:"Update Minecraft settings from Cloudflare panel",content:encodeText(next),branch:"main",...(current?{sha:current.sha}:{})})});
      return json({ok:true,message:"Settings saved to repository. They apply at the next server restart."});
    }
    return json({error:"Unknown action"},404);
  } catch (err) {
    return json({error:String(err.message||err)},502);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if(path==="/api/desired"){
      if(!env.BRIDGE_TOKEN)return json({error:"Bridge not configured"},503);
      const token=(request.headers.get("Authorization")||"").replace(/^Bearer /,"");
      if(!token||!await equals(token,env.BRIDGE_TOKEN))return json({error:"Unauthorized"},401);
      return json(await bridgeCall(env,"state").then(x=>({desired:x.desired})));
    }
    if(path==="/api/bridge-event"){
      if(!env.BRIDGE_TOKEN)return json({error:"Live bridge not configured"},503);
      const token=(request.headers.get("Authorization")||"").replace(/^Bearer /,"");
      if(!token||!await equals(token,env.BRIDGE_TOKEN))return json({error:"Unauthorized"},401);
      if(request.method!=="POST")return json({error:"Method not allowed"},405);
      try{
        const payload=await request.json();
        return json(await bridgeCall(env,"event",payload));
      }catch(e){return json({error:String(e.message)},400)}
    }
    if(path==="/api/bridge"){
      if(!env.BRIDGE_TOKEN)return json({error:"Live bridge not configured"},503);
      const token=(request.headers.get("Authorization")||"").replace(/^Bearer /,"");
      if(!token||!await equals(token,env.BRIDGE_TOKEN))return json({error:"Unauthorized"},401);
      if(request.method!=="POST")return json({error:"Method not allowed"},405);
      try {
        const input=await request.json();
        if(!input.session||typeof input.session!=="string"||input.session.length>128)return json({error:"Missing runner session"},400);
        return json(await bridgeCall(env,"heartbeat",input));
      }catch(e){return json({error:String(e.message)},400)}
    }
    if (path === "/api/control") return handleControl(request, env);
    if (path.startsWith("/api/")) return json({error:"Unknown API route"},404);
    return env.ASSETS.fetch(request);
  }
};
