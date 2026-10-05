// Browser integration test with a PRIVATE, in-memory fake backend.
// This proves app flow/queue behavior, NOT deployed Firebase or timing accuracy.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const races=new Map();
const fakeModule=`
export async function connectBackend(){
  if(!navigator.onLine) throw new Error('Test backend is offline');
  const key='splitline-test-uid';const uid=localStorage[key]||(localStorage[key]=crypto.randomUUID());
  const listeners=new Set();
  const notify=()=>listeners.forEach(fn=>fn(navigator.onLine));
  window.addEventListener('online',notify);window.addEventListener('offline',notify);
  const request=async(op,value={})=>{const r=await fetch('./__test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,uid,...value})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;};
  return {uid,get online(){return navigator.onLine;},
    onConnection(fn){listeners.add(fn);fn(navigator.onLine);return()=>listeners.delete(fn);},
    async calibrate(){return {anchor:Date.now()-performance.now(),rtt:20,calibratedAt:Date.now()};},
    async create(id,room){await request('create',{id,room});},
    async join(id,token,name){return request('join',{id,token,name});},
    subscribe(id,callback,error){let active=true;let last='';const poll=async()=>{if(!active||!navigator.onLine)return;try{const room=await request('read',{id});const text=JSON.stringify(room);if(text!==last){last=text;callback(room);}}catch(e){if(navigator.onLine)error(e);}};const timer=setInterval(poll,150);poll();return()=>{active=false;clearInterval(timer);};},
    async presence(id,value){await request('presence',{id,value});},
    async start(id,startedAt){return request('start',{id,startedAt});},
    async finish(id,endedAt){return request('finish',{id,endedAt});},
    async send(id,item){await request('send',{id,item});},
    dispose(){window.removeEventListener('online',notify);window.removeEventListener('offline',notify);listeners.clear();}
  };
}`;
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__test'){
      let raw='';for await(const chunk of req)raw+=chunk;
      const {op,uid,id,...body}=JSON.parse(raw);let room=races.get(id);let value={};
      if(op==='create'){assert.ok(!room);assert.equal(body.room.owner,uid);room=structuredClone(body.room);races.set(id,room);}
      else if(op==='join'){if(!room||room.invite!==body.token)throw new Error('Invalid private invite');room.members[uid]={name:body.name,invite:body.token};value=room;}
      else{if(!room?.members?.[uid])throw new Error('Access denied');
        if(op==='read')value=room;
        if(op==='presence'){(room.presence||={})[uid]={...body.value,online:true,seenAt:Date.now()};}
        if(op==='start'){assert.equal(room.owner,uid);assert.equal(room.state.status,'ready');room.state={status:'running',startedAt:body.startedAt,endedAt:0};value=room.state;}
        if(op==='finish'){assert.equal(room.owner,uid);room.state={...room.state,status:'finished',endedAt:body.endedAt};}
        if(op==='send'){const item=body.item;assert.equal(item.data.coachId,uid);if(item.kind==='event'){assert.ok(room.athletes[item.data.athleteId]);assert.ok(room.checkpoints[item.data.checkpointId]);(room.events||={})[item.id]||=item.data;}else{assert.ok(room.events?.[item.id]);assert.ok(room.events[item.id].coachId===uid||room.owner===uid);(room.voids||={})[item.id]||=item.data;}}
      }
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));return;
    }
    let file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(file.includes('..'))throw new Error('Bad path');
    let content;
    if(file==='backend.mjs')content=fakeModule;
    else if(file==='firebase-config.mjs')content='export default {apiKey:"test",authDomain:"test.firebaseapp.com",databaseURL:"https://test.firebaseio.com",projectId:"test",appId:"test"};';
    else content=await fs.readFile(path.join(root,file));
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'text/plain'});res.end(content);
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
const coach1=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
const coach2=await browser.newContext({viewport:{width:375,height:812},deviceScaleFactor:1});
const starter=await coach1.newPage(), checkpoint=await coach2.newPage();
const errors=[];for(const page of [starter,checkpoint])page.on('pageerror',e=>errors.push(e.message));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<60;i++){if(await fn())return;await wait(100);}throw new Error('Timed out: '+label);}
async function data(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('splitline-store-v1')));}
async function active(page){const s=await data(page);return s.sessions[s.active];}
const click=(page,action)=>page.locator('[data-action="'+action+'"]').first().click();
try{
  await starter.goto(url);await checkpoint.goto(url);
  await click(starter,'create');
  await starter.locator('#coachName').fill('Coach Start');
  await starter.locator('#raceName').fill('Saturday time trial');
  await starter.locator('#roster').fill('12, Alex\n24, Jordan\n36, Sam');
  await click(starter,'save-race');
  await until(async()=>!!(await data(starter))?.active,'race created');
  let state=await data(starter),id=state.active;const token=state.sessions[id].token;
  await checkpoint.goto(url+'#join='+id+'.'+token);
  await checkpoint.locator('#coachName').waitFor();
  await checkpoint.locator('#coachName').fill('Coach Mile');await click(checkpoint,'save-join');
  await until(async()=>!!(await data(checkpoint))?.active,'second coach joined');
  await checkpoint.locator('#checkpoint').selectOption('c2');
  await until(async()=>Object.keys((await active(starter)).room.members).length===2,'crew synchronized');
  assert.equal(await checkpoint.locator('[data-action="start"]').count(),0,'only starter can start');
  await click(starter,'start');
  await until(async()=>(await active(checkpoint)).room.state.status==='running','shared start arrived');
  assert.equal((await active(starter)).room.state.startedAt,(await active(checkpoint)).room.state.startedAt,'same exact shared start');
  await wait(5300);
  await starter.locator('[data-action="tap"][data-id="a1"]').click();
  await until(async()=>Object.keys((await active(checkpoint)).room.events||{}).length===1,'first checkpoint visible on other phone');
  await checkpoint.locator('[data-action="tap"][data-id="a1"]').click();
  await until(async()=>Object.keys((await active(starter)).room.events||{}).length===2,'second checkpoint visible on starter');
  console.log('PASS shared start, two coaches, different checkpoints and cross-phone results');
  await until(async()=>Object.keys((await active(checkpoint)).pending).length===0,'online acknowledgement');
  await checkpoint.evaluate(async()=>{const r=await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await coach2.setOffline(true);await wait(300);
  await checkpoint.locator('[data-action="tap"][data-id="a2"]').click();
  assert.equal(Object.keys((await active(checkpoint)).pending).length,1);
  await click(checkpoint,'last-undo');
  assert.equal(Object.keys((await active(checkpoint)).pending).length,2,'pending undo must not overwrite pending tap');
  await checkpoint.locator('[data-action="tap"][data-id="a2"]').click();
  assert.equal(Object.keys((await active(checkpoint)).pending).length,3);
  await checkpoint.reload();await checkpoint.locator('[data-action="tap"][data-id="a2"]').waitFor();
  assert.equal(Object.keys((await active(checkpoint)).pending).length,3,'offline reload retains all queue items');
  await checkpoint.locator('[data-action="tap"][data-id="a3"]').click();
  assert.equal(Object.keys((await active(checkpoint)).pending).length,4,'can record cached started race after offline reload');
  console.log('PASS offline recording, offline undo/re-tap, reload recovery and cached-clock tap');
  await coach2.setOffline(false);
  await until(async()=>Object.keys((await active(checkpoint)).pending).length===0,'all offline taps upload');
  await until(async()=>Object.keys((await active(starter)).room.events||{}).length===5,'offline events visible to starter');
  assert.equal(Object.keys(races.get(id).events).length,5,'no retry duplicates');
  assert.equal(Object.keys(races.get(id).voids).length,1,'undo arrived separately');
  await click(starter,'view');
  await starter.locator('[data-action="view"][data-view="results"]').click();
  await starter.locator('#resultCheckpoint').selectOption('c2');
  assert.equal(await starter.locator('.results-table').first().locator('tbody tr').count(),3);
  const d=starter.waitForEvent('download');await click(starter,'export');const download=await d;assert.match(download.suggestedFilename(),/^splitline-results/);
  assert.ok(await starter.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'390px layout has no page overflow');
  assert.ok(await checkpoint.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'375px layout has no page overflow');
  await fs.mkdir(path.join(root,'test-output'),{recursive:true});
  await starter.screenshot({path:path.join(root,'test-output','results-mobile.png'),fullPage:true});
  await checkpoint.screenshot({path:path.join(root,'test-output','timing-mobile.png'),fullPage:true});
  console.log('PASS queued synchronization, idempotency, mobile layout and CSV export');
  await click(starter,'finish');await click(starter,'confirm-finish');
  await until(async()=>(await active(checkpoint)).room.state.status==='finished','race ended across phones');
  assert.ok(await checkpoint.locator('[data-action="start"]').count()===0);
  assert.deepEqual(errors,[],'no uncaught browser errors');
  console.log('PASS shared race end; no browser errors');
}finally{await browser.close();server.close();}
