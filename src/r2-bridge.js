// Cloudflare R2-backed bridge: no Durable Objects and no SQLite row quota.
// The runner sends one heartbeat about every five seconds, within R2 Standard
// free-tier Class A limits. R2 conditional puts prevent lost control commands.
const KEY="live-control-v1.json";
const empty=()=>({status:{},desired:"on",commands:[],history:[]});
const clean=x=>x&&typeof x==="object"&&!Array.isArray(x)?x:empty();

async function current(bucket){
  const object=await bucket.get(KEY);
  if(!object)return {data:empty(),etag:null};
  const data=clean(await object.json());
  return {data,etag:object.etag};
}

async function mutate(bucket,patch){
  for(let attempt=0;attempt<8;attempt++){
    const {data,etag}=await current(bucket);
    const result=patch(data);
    if(result?.skip)return result.value;
    const payload=JSON.stringify(data);
    // R2 supports optimistic concurrency via If-Match / If-None-Match.
    const onlyIf=new Headers({[etag?"If-Match":"If-None-Match"]:etag?'"'+etag+'"':"*"});
    const saved=await bucket.put(KEY,payload,{onlyIf});
    if(saved)return result?.value;
  }
  throw Error("Live bridge is busy; please retry the control request");
}
export async function r2BridgeCall(env,route,value){
  const bucket=env.MC_STATE;
  if(!bucket)throw Error("MC_STATE R2 binding is missing; create minecraft-cloud-state bucket");
  if(route==="state")return (await current(bucket)).data;
  if(route==="desired"){
    if(!["on","off"].includes(value?.desired))throw Error("Invalid desired state");
    return mutate(bucket,state=>{
      state.desired=value.desired;
      if(value.desired==="on"){
        state.commands=[];
        if(!state.status.session||["stopped","failed"].includes(state.status.phase)){
          state.status={...state.status,phase:"starting",ready:false,updatedAt:Date.now()};
        }
      }else if(state.status.session&&state.status.ready){
        state.status={...state.status,phase:"shutdown_requested",updatedAt:Date.now()};
      }
      return {value:{ok:true,desired:state.desired}};
    });
  }
  if(route==="enqueue"){
    if(!value||typeof value.type!=="string")throw Error("Invalid command");
    const id=crypto.randomUUID();
    return mutate(bucket,state=>{
      state.commands=Array.isArray(state.commands)?state.commands:[];
      if(state.commands.length>=30)throw Error("Too many pending commands");
      state.commands.push({id,type:value.type,args:value.args||{},issuedAt:Date.now()});
      return {value:{ok:true,id}};
    });
  }
  if(route==="event"){
    if(!["saving","stopping","backing_up","stopped","failed"].includes(value?.phase))
      throw Error("Invalid lifecycle phase");
    return mutate(bucket,state=>{
      const session=String(value.session||"");
      if(!session||(state.status.session&&state.status.session!==session))
        throw Error("Wrong server session");
      state.status={...state.status,phase:value.phase,ready:false,
        updatedAt:Date.now(),session,detail:String(value.detail||"").slice(0,180)};
      return {value:{ok:true}};
    });
  }
  if(route==="heartbeat"){
    if(!value||typeof value.session!=="string"||!value.session||value.session.length>128)
      throw Error("Missing runner session");
    return mutate(bucket,state=>{
      const old=state.status||{};
      const patch=value.status||{};
      const next={...old,...patch,updatedAt:Date.now(),session:value.session};
      if(["shutdown_requested","saving","stopping","backing_up","stopped"].includes(old.phase)
        &&patch.phase==="running"&&old.session===value.session)next.phase=old.phase;
      next.logs=(Array.isArray(patch.logs)?patch.logs.slice(-60):[]).map(x=>String(x).slice(0,400));
      next.players=Array.isArray(patch.players)?patch.players.slice(0,100):[];
      state.status=next;
      const ack=Array.isArray(value.acks)?value.acks.slice(-40):[];
      const acked=new Set(ack.filter(x=>x&&typeof x.id==="string").map(x=>x.id));
      const history=Array.isArray(state.history)?state.history:[];
      for(const item of ack){
        if(!item?.id)continue;
        if(!history.some(h=>h.id===item.id)){
          history.unshift({id:item.id,type:item.type,ok:!!item.ok,result:item.result||null,at:Date.now()});
        }
      }
      state.history=history.slice(0,30);
      const now=Date.now();
      state.commands=(Array.isArray(state.commands)?state.commands:[])
        .filter(cmd=>!acked.has(cmd.id)&&now-cmd.issuedAt<300000);
      return {value:{commands:state.commands.slice(0,20),desired:state.desired||"on"}};
    });
  }
  throw Error("Unknown live bridge route");
}
