import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const src=readFileSync(new URL("../desktop/ui/server_lifecycle.js",import.meta.url),"utf8");
const shell={};
runInNewContext(src,{window:shell});
const {create,advance,label,detail,stages}=shell.ServerLifecycle;

const sample=(phase,runId,session,ready=false,now=0,status="in_progress",conclusion=null)=>({
  phase,runId,session,ready,now,runStatus:status,runConclusion:conclusion
});

test("restart progress never returns to Requested across old-run backup and successor queue",()=>{
  let op=create("restarting","old-session",123,100);
  const history=[];
  const events=[
    sample("shutdown_requested",123,"old-session",true,105),
    sample("saving",123,"old-session",true,110),
    sample("backing_up",123,"old-session",false,120),
    sample("",123,"old-session",false,130,"completed","success"),
    sample("shutdown_requested",124,"old-session",false,140,"queued"),
    sample("backing_up",124,"old-session",false,145,"in_progress"),
    sample("starting",124,"new-session",false,160),
    sample("running",124,"new-session",true,170),
  ];
  for(const e of events){
    op=advance(op,e);
    assert.ok(op);
    history.push(label(op));
  }
  assert.deepEqual(history,[
    "Requested","Saving world","Backing up","Backing up",
    "Starting","Starting","Starting","Paper ready"
  ]);
  assert.equal(advance(op,sample("running",124,"new-session",true,200)),op);
  assert.equal(advance(op,sample("running",124,"new-session",true,2800)),null);
});

test("missed or delayed heartbeat cannot rewind a confirmed phase",()=>{
  const op=create("restarting","session-a",50,10);
  advance(op,sample("backing_up",50,"session-a",false,20));
  assert.equal(op.stageIndex,2);
  advance(op,sample("shutdown_requested",50,"session-a",true,30));
  assert.equal(op.stageIndex,2);
  advance(op,sample("starting",51,"session-a",false,40,"queued"));
  assert.equal(op.stageIndex,3);
  advance(op,sample("saving",50,"session-a",true,50,"in_progress"));
  assert.equal(op.stageIndex,3);
  advance(op,sample("running",51,"session-a",true,60,"in_progress"));
  // An old session heartbeat cannot complete the new startup.
  assert.equal(op.stageIndex,3);
  assert.match(detail(op),/successor GitHub runner/);
});

test("scheduled restart detected during backing-up does not create a second request",()=>{
  const op=create("restarting","session-a",300,10);
  advance(op,sample("backing_up",300,"session-a",false,25));
  const next=advance(op,sample("starting",301,"session-a",false,31,"queued"));
  assert.equal(label(next),"Starting");
  assert.equal(next.stageIndex,3);
});

test("restore progress also survives runner handoff",()=>{
  const op=create("restoring","old",1,10);
  advance(op,sample("saving",1,"old",false,20));
  advance(op,sample("backing_up",1,"old",false,30));
  advance(op,sample("shutdown_requested",2,"old",false,40,"queued"));
  assert.equal(label(op),"Restoring");
  advance(op,sample("running",2,"new",true,55));
  assert.equal(label(op),"Paper ready");
});

test("normal start and stop phases still work",()=>{
  const starting=create("starting",null,null,0);
  advance(starting,sample("",5,null,false,10,"queued"));
  assert.equal(label(starting),"Runner");
  advance(starting,sample("starting",5,"session-new",false,20));
  assert.equal(label(starting),"Loading world");
  advance(starting,sample("running",5,"session-new",true,30));
  assert.equal(label(starting),"Paper ready");

  const stopping=create("stopping","old",6,0);
  advance(stopping,sample("saving",6,"old",true,10));
  assert.equal(label(stopping),"Saving world");
  advance(stopping,sample("backing_up",6,"old",false,20));
  assert.equal(label(stopping),"Backing up");
  advance(stopping,sample("stopped",6,"old",false,30,"completed","success"));
  assert.equal(label(stopping),"Stopped");
});

test("a failed successor does not claim Paper is ready",()=>{
  const op=create("restarting","old",10,0);
  advance(op,sample("backing_up",10,"old",false,10));
  advance(op,sample("",11,"old",false,20,"in_progress"));
  advance(op,sample("failed",11,"old",false,30,"completed","failure"));
  assert.equal(op.failed,true);
  assert.equal(op.stageIndex,3);
  assert.match(detail(op),/Review GitHub logs/);
  assert.notEqual(label(op),"Paper ready");
});

test("lifecycle stages are ordered and never percentages",()=>{
  assert.deepEqual(Array.from(stages.restarting),[
    "Requested","Saving world","Backing up","Starting","Paper ready"
  ]);
  assert.ok(!src.includes("percentComplete"));
});

test("HTML loads lifecycle module before app and app uses the stage index",()=>{
  const html=readFileSync(new URL("../desktop/ui/index.html",import.meta.url),"utf8");
  const app=readFileSync(new URL("../desktop/ui/app.js",import.meta.url),"utf8");
  assert.ok(html.indexOf('src="./server_lifecycle.js"')>=0);
  assert.ok(html.indexOf('src="./server_lifecycle.js"')<html.indexOf('src="./app.js"'));
  assert.match(app,/ServerLifecycle\.advance\(state\.operation/);
  assert.match(app,/const index=current\.stageIndex;/);
  assert.match(app,/ServerLifecycle\.create\(/);
});
