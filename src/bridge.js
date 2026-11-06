// Per-server command queue and most recent Paper telemetry.
// All requests to this object must come through the authenticated Worker.
export class MinecraftBridge {
  constructor(ctx, env) {
    this.ctx=ctx;
    this.env=env;
  }
  async fetch(request) {
    const url=new URL(request.url);
    const get=(key,fallback)=>this.ctx.storage.get(key).then(value=>value??fallback);
    if (request.method==="GET" && url.pathname==="/state") {
      const [status,commands,history]=await Promise.all([get("status",{}),get("commands",[]),get("history",[])]);
      const desired=await get("desired","on");
      return Response.json({status,desired,commands:commands.map(({id,type,issuedAt})=>({id,type,issuedAt})),history});
    }
    if (request.method!=="POST")return new Response("Method not allowed",{status:405});
    const body=await request.json();
    if(url.pathname==="/desired"){
      if(!["on","off"].includes(body.desired))return Response.json({error:"Invalid desired state"},{status:400});
      await this.ctx.storage.put("desired",body.desired);
      if(body.desired==="on"){
        await this.ctx.storage.put("commands",[]);
        const state=await get("status",{});
        if(!state.session||["stopped","failed"].includes(state.phase))await this.ctx.storage.put("status",{...state,phase:"starting",ready:false,updatedAt:Date.now()});
      }
      return Response.json({ok:true,desired:body.desired});
    }
    if(url.pathname==="/enqueue"){
      const commands=await get("commands",[]);
      if(commands.length>=30)return Response.json({error:"Too many pending commands"},{status:429});
      const record={id:crypto.randomUUID(),type:body.type,args:body.args||{},issuedAt:Date.now()};
      commands.push(record);
      await this.ctx.storage.put("commands",commands);
      return Response.json({ok:true,id:record.id});
    }
    if(url.pathname==="/event"){
      const phase=body.phase;
      if(!["saving","stopping","backing_up","stopped","failed"].includes(phase))return Response.json({error:"Invalid phase"},{status:400});
      const current=await get("status",{});
      const session=String(body.session||"");
      if(!session|| (current.session && session!==current.session))return Response.json({error:"Wrong server session"},{status:409});
      const next={...current,phase,ready:false,updatedAt:Date.now(),session,
        detail:String(body.detail||"").slice(0,180)};
      await this.ctx.storage.put("status",next);
      return Response.json({ok:true});
    }
    if(url.pathname==="/heartbeat"){
      const status=await get("status",{});
      const patch=body.status||{};
      const next={...status,...patch,updatedAt:Date.now(),session:body.session||""};
      if(["saving","stopping","backing_up","stopped"].includes(status.phase) && patch.phase==="running" && status.session===body.session) next.phase=status.phase;
      const logs=Array.isArray(patch.logs)?patch.logs.slice(-100):[];
      next.logs=logs.map(x=>String(x).slice(0,400));
      next.players=Array.isArray(patch.players)?patch.players.slice(0,100):[];
      await this.ctx.storage.put("status",next);
      let commands=await get("commands",[]);
      let history=await get("history",[]);
      const acknowledgements=Array.isArray(body.acks)?body.acks.slice(-40):[];
      const acked=new Set(acknowledgements.map(x=>x.id));
      for(const ack of acknowledgements) {
        if(!ack?.id||!acked.has(ack.id))continue;
        history.unshift({id:ack.id,type:ack.type,ok:!!ack.ok,result:ack.result||null,at:Date.now()});
      }
      history=history.slice(0,30);
      commands=commands.filter(x=>!acked.has(x.id)&&Date.now()-x.issuedAt<300000);
      await this.ctx.storage.put("commands",commands);
      await this.ctx.storage.put("history",history);
      const desired=await get("desired","on");
      return Response.json({commands:commands.slice(0,20),desired});
    }
    return new Response("Not found",{status:404});
  }
}
