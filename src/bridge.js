// Per-server command queue and most recent Paper telemetry.
// All requests to this object must come through the authenticated Worker.
export class MinecraftBridge {
  constructor(ctx, env) {
    this.ctx=ctx;
    this.env=env;
    // Rapidly-changing telemetry belongs in memory, not one SQLite write
    // every heartbeat. Durable Objects receive a heartbeat every 2 seconds,
    // so this hot state remains available while Paper is connected.
    this.liveStatus=null;
    this.liveCommands=null;
    this.liveHistory=null;
    this.lastSnapshotAttempt=0;
    this.lastStorageWarning=0;
  }
  async persistIfPossible(key,value) {
    try {
      await this.ctx.storage.put(key,value);
      return true;
    } catch(error) {
      // On the free tier, today's row budget can be exhausted. Do not take
      // live telemetry or command acknowledgements offline as a result.
      const now=Date.now();
      if(now-this.lastStorageWarning>60000) {
        console.warn("Minecraft bridge: persistent storage write unavailable; live memory continues until quota reset.");
        this.lastStorageWarning=now;
      }
      return false;
    }
  }
  async fetch(request) {
    const url=new URL(request.url);
    const get=(key,fallback)=>this.ctx.storage.get(key).then(value=>value??fallback);
    if (request.method==="GET" && url.pathname==="/state") {
      const [storedStatus,storedCommands,storedHistory,desired]=await Promise.all([
        this.liveStatus?Promise.resolve(this.liveStatus):get("status",{}),
        this.liveCommands?Promise.resolve(this.liveCommands):get("commands",[]),
        this.liveHistory?Promise.resolve(this.liveHistory):get("history",[]),
        get("desired","on")
      ]);
      return Response.json({status:storedStatus,desired,
        commands:storedCommands.map(({id,type,issuedAt})=>({id,type,issuedAt})),
        history:storedHistory});
    }
    if (request.method!=="POST")return new Response("Method not allowed",{status:405});
    const body=await request.json();
    if(url.pathname==="/desired"){
      if(!["on","off"].includes(body.desired))return Response.json({error:"Invalid desired state"},{status:400});
      await this.ctx.storage.put("desired",body.desired);
      if(body.desired==="on"){
        this.liveCommands=[];
        await this.persistIfPossible("commands",[]);
        const state=this.liveStatus||await get("status",{});
        if(!state.session||["stopped","failed"].includes(state.phase)) {
          this.liveStatus={...state,phase:"starting",ready:false,updatedAt:Date.now()};
          await this.persistIfPossible("status",this.liveStatus);
        }
      } else {
        const state=this.liveStatus||await get("status",{});
        if(state.session && state.ready) {
          this.liveStatus={...state,phase:"shutdown_requested",updatedAt:Date.now()};
          await this.persistIfPossible("status",this.liveStatus);
        }
      }
      return Response.json({ok:true,desired:body.desired});
    }
    if(url.pathname==="/enqueue"){
      const commands=this.liveCommands||await get("commands",[]);
      if(commands.length>=30)return Response.json({error:"Too many pending commands"},{status:429});
      const record={id:crypto.randomUUID(),type:body.type,args:body.args||{},issuedAt:Date.now()};
      commands.push(record);
      this.liveCommands=commands;
      await this.persistIfPossible("commands",commands);
      return Response.json({ok:true,id:record.id});
    }
    if(url.pathname==="/event"){
      const phase=body.phase;
      if(!["saving","stopping","backing_up","stopped","failed"].includes(phase))return Response.json({error:"Invalid phase"},{status:400});
      const current=this.liveStatus||await get("status",{});
      const session=String(body.session||"");
      if(!session|| (current.session && session!==current.session))return Response.json({error:"Wrong server session"},{status:409});
      const next={...current,phase,ready:false,updatedAt:Date.now(),session,
        detail:String(body.detail||"").slice(0,180)};
      this.liveStatus=next;
      await this.persistIfPossible("status",next);
      return Response.json({ok:true});
    }
    if(url.pathname==="/heartbeat"){
      const status=this.liveStatus||await get("status",{});
      const patch=body.status||{};
      const next={...status,...patch,updatedAt:Date.now(),session:body.session||""};
      if(["shutdown_requested","saving","stopping","backing_up","stopped"].includes(status.phase) && patch.phase==="running" && status.session===body.session) next.phase=status.phase;
      const logs=Array.isArray(patch.logs)?patch.logs.slice(-100):[];
      next.logs=logs.map(x=>String(x).slice(0,400));
      next.players=Array.isArray(patch.players)?patch.players.slice(0,100):[];
      this.liveStatus=next;
      // One recovery snapshot per ten minutes instead of continuously
      // rewriting 3+ SQLite rows every 1-2 seconds. A lost DO instance will
      // receive a fresh heartbeat shortly after restarting.
      const now=Date.now();
      if(now-this.lastSnapshotAttempt>=600000){
        this.lastSnapshotAttempt=now;
        const snapshot={...next,logs:next.logs.slice(-20)};
        await this.persistIfPossible("status",snapshot);
      }
      let commands=this.liveCommands||await get("commands",[]);
      let history=this.liveHistory||await get("history",[]);
      const acknowledgements=Array.isArray(body.acks)?body.acks.slice(-40):[];
      const acked=new Set(acknowledgements.map(x=>x.id));
      for(const ack of acknowledgements) {
        if(!ack?.id||!acked.has(ack.id))continue;
        history.unshift({id:ack.id,type:ack.type,ok:!!ack.ok,result:ack.result||null,at:Date.now()});
      }
      history=history.slice(0,30);
      const remaining=commands.filter(x=>!acked.has(x.id)&&Date.now()-x.issuedAt<300000);
      const changed=remaining.length!==commands.length;
      commands=remaining;
      this.liveCommands=commands;
      this.liveHistory=history;
      // Do not write unchanged queues or history on every heartbeat.
      if(changed)await this.persistIfPossible("commands",commands);
      if(acknowledgements.length)await this.persistIfPossible("history",history);
      const desired=await get("desired","on");
      return Response.json({commands:commands.slice(0,20),desired});
    }
    return new Response("Not found",{status:404});
  }
}
