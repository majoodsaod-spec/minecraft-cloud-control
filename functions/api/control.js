// Cloudflare Pages Function. Secrets must be configured in Pages settings, never in index.html.
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
const allowedSettings = new Set(["motd","max-players","difficulty","gamemode","pvp","allow-flight","white-list","enforce-whitelist","online-mode","enable-command-block","spawn-protection","view-distance","simulation-distance","max-world-size","allow-nether","spawn-monsters","spawn-animals","spawn-npcs","hardcore","force-gamemode","player-idle-timeout"]);
export async function onRequest({ request, env }) {
  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN)
    return json({error: "Backend not configured: set ADMIN_PASSWORD and GITHUB_TOKEN in Cloudflare Pages secrets."}, 503);
  const pass = request.headers.get("X-Admin-Password") || "";
  if (!await equals(pass, env.ADMIN_PASSWORD)) return json({error: "Unauthorized"}, 401);
  if (!["GET", "POST"].includes(request.method)) return json({error:"Method not allowed"},405);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  try {
    if (request.method === "GET" && action === "status") {
      const [runs, artifacts, cfg] = await Promise.all([
        github(env, "/actions/workflows/" + workflow + "/runs?per_page=30"),
        github(env, "/actions/artifacts?name=minecraft-world&per_page=100"),
        github(env, "/contents/server/server.properties").catch(() => null)
      ]);
      const active = runs.workflow_runs.filter(r => ["queued","in_progress","waiting","requested","pending"].includes(r.status));
      return json({active: active.map(r=>({id:r.id,status:r.status,html_url:r.html_url,created_at:r.created_at})),
        latest: runs.workflow_runs[0] ? {id:runs.workflow_runs[0].id,status:runs.workflow_runs[0].status,conclusion:runs.workflow_runs[0].conclusion,html_url:runs.workflow_runs[0].html_url}: null,
        backups: artifacts.artifacts.filter(a=>!a.expired).slice(0,10).map(a=>({id:a.id,name:a.name,size_in_bytes:a.size_in_bytes,created_at:a.created_at,run_id:a.workflow_run?.id})),
        properties: cfg ? readText(cfg) : null});
    }
    if (request.method === "GET") return json({error:"Unknown action"},404);
    const input = await request.json().catch(()=>({}));
    if (action === "start") {
      await github(env, "/actions/workflows/" + workflow + "/dispatches", {method:"POST",body:JSON.stringify({ref:"main"})});
      return json({ok:true,message:"Workflow requested"});
    }
    if (action === "stop") {
      const id = Number(input.run_id);
      if (!Number.isSafeInteger(id) || id <= 0) return json({error:"Valid run ID required"},400);
      await github(env, "/actions/runs/" + id + "/cancel", {method:"POST"});
      return json({ok:true,message:"Cancellation requested; latest unsaved progress may be lost"});
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
