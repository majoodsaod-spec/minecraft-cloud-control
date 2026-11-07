// Run with node --test tests/test_bridge_free_tier.mjs
// Check that repeated heartbeats use memory, not paid/limited row writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source=readFileSync(new URL("../src/bridge.js",import.meta.url),"utf8");
const { MinecraftBridge }=await import("data:text/javascript;charset=utf-8,"+encodeURIComponent(source));

function makeBridge(failWrites=false) {
  const records=new Map(),writes=[];
  const storage={
    async get(key){return records.get(key);},
    async put(key,value){
      writes.push(key);
      if(failWrites)throw Error("Exceeded allowed rows written in Durable Objects free tier");
      records.set(key,structuredClone(value));
    }
  };
  const bridge=new MinecraftBridge({storage},{});
  const send=async (route,payload,method="POST")=>{
    const req=new Request("https://bridge.internal/"+route,{
      method,headers:{"Content-Type":"application/json"},
      body:method==="POST"?JSON.stringify(payload):undefined
    });
    const response=await bridge.fetch(req);
    return {code:response.status,body:await response.json()};
  };
  return {send,writes,records};
}

test("1,000 heartbeats do not write 3,000 SQL rows",async()=>{
  const {send,writes}=makeBridge();
  for(let i=0;i<1000;i++){
    const r=await send("heartbeat",{session:"runner-7",status:{
      ready:true,phase:"running",players:["BedrockPlayer"],uptime:i,logs:["hello"]
    },acks:[]});
    assert.equal(r.code,200);
  }
  assert.ok(writes.filter(x=>x==="status").length<=1,"only one recovery snapshot, not one per request");
  assert.equal(writes.filter(x=>x==="history").length,0);
  assert.equal(writes.filter(x=>x==="commands").length,0);
  const current=await send("state",null,"GET");
  assert.equal(current.body.status.uptime,999);
  assert.deepEqual(current.body.status.players,["BedrockPlayer"]);
});

test("commands are executed and acknowledged without heartbeats rewriting them",async()=>{
  const {send,writes}=makeBridge();
  const first=await send("enqueue",{type:"console",args:{command:"list"}});
  assert.equal(first.code,200);
  const commandId=first.body.id;
  let r=await send("heartbeat",{session:"runner-8",status:{ready:true,phase:"running",players:[],logs:[]},acks:[]});
  assert.equal(r.body.commands[0].id,commandId);
  r=await send("heartbeat",{session:"runner-8",status:{ready:true,phase:"running",players:[],logs:[]},
    acks:[{id:commandId,type:"console",ok:true,result:"done"}]});
  assert.equal(r.body.commands.length,0);
  const state=await send("state",null,"GET");
  assert.equal(state.body.history[0].id,commandId);
  assert.equal(writes.filter(x=>x==="history").length,1);
  assert.equal(writes.filter(x=>x==="commands").length,2);
});

test("quota exhausted: telemetry stays live in memory rather than returning HTTP 400/502",async()=>{
  const {send,writes}=makeBridge(true);
  let r=await send("heartbeat",{session:"runner-9",status:{
    ready:true,phase:"running",players:["Steve"],logs:["online"],uptime:22
  },acks:[]});
  assert.equal(r.code,200);
  r=await send("state",null,"GET");
  assert.equal(r.body.status.ready,true);
  assert.equal(r.body.status.players[0],"Steve");
  assert.ok(writes.length<=1);
});
