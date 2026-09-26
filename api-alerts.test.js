import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createOkxClient} from '../okx.js';
import {Alerts} from '../alerts.js';
import {createApp} from '../server.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const credentials={apiKey:'KEY',secretKey:'SECRET',passphrase:'PASS',site:'global',demo:true};
const response=(data,code='0',status=200)=>({ok:status===200,status,json:async()=>({code,data,msg:'failure'})});
test('OKX signed exact request, simulation flag, expiry header and no credential redirect',async()=>{
  let capture;const c=createOkxClient(credentials,async(url,options)=>{capture={url,options};return response([{ordId:'42',sCode:'0'}]);});
  await c.placeOrder({instId:'BTC-USDT-SWAP',clOrdId:'G3test',sz:'1'});const h=capture.options.headers;
  assert.equal(capture.url,'https://www.okx.com/api/v5/trade/order');assert.equal(h['x-simulated-trading'],'1');assert.equal(capture.options.redirect,'error');assert(Number(h.expTime)>Date.now());
  assert.equal(h['OK-ACCESS-SIGN'],createHmac('sha256','SECRET').update(h['OK-ACCESS-TIMESTAMP']+'POST/api/v5/trade/order'+capture.options.body).digest('base64'));
});
test('live flag excludes simulation header',async()=>{let headers;const c=createOkxClient({...credentials,demo:false},async(_,o)=>{headers=o.headers;return response([{ordId:'1'}]);});await c.placeOrder({});assert.equal(headers['x-simulated-trading'],undefined);});
test('omitted demo option uses real order endpoint without simulation header',async()=>{
  const {demo,...liveCredentials}=credentials;let captured;
  const client=createOkxClient(liveCredentials,async(url,options)=>{captured={url,options};return response([{ordId:'live-mock'}]);});
  assert.equal(client.demo,false);await client.placeOrder({instId:'BTC-USDT-SWAP',sz:'1'});
  assert.equal(captured.url,'https://www.okx.com/api/v5/trade/order');assert.equal(captured.options.headers['x-simulated-trading'],undefined);
});
test('application defaults to live without OKX_DEMO environment variable',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'live-default-'));const app=createApp({DASHBOARD_PASSWORD:'test',DATA_DIR:dir},{autoTick:false});
  try{await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const cfg=await(await fetch('http://127.0.0.1:'+app.server.address().port+'/api/bootstrap')).json();assert.equal(cfg.demo,false);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('50004, HTTP 5xx, invalid JSON and missing ID preserve ambiguous placement',async()=>{
  for(const fn of [async()=>response([],'50004'),async()=>response([],'0',503),async()=>({ok:true,status:200,json:async()=>{throw new Error('invalid');}}),async()=>({ok:true,status:200,json:async()=>({data:[]})}),async()=>response([])]){
    await assert.rejects(createOkxClient(credentials,fn).placeOrder({}),e=>e.uncertain===true);
  }
});
test('nested rejection is definitive and retains code',async()=>{await assert.rejects(createOkxClient(credentials,async()=>response([{sCode:'51121',sMsg:'quantity'}])).placeOrder({}),e=>e.code==='51121'&&e.uncertain===false);});
test('archive walks all pages and deduplicates IDs',async()=>{
  const urls=[];const c=createOkxClient(credentials,async url=>{urls.push(url);return response(urls.length===1?Array.from({length:100},(_,i)=>({billId:String(200-i)})):[{billId:'101'},{billId:'100'}]);});
  const rows=await c.bills(1,3);assert.equal(rows.length,101);assert.equal(new URL(urls[1]).searchParams.get('after'),'101');assert.equal(new URL(urls[0]).searchParams.get('end'),'3');
});
test('broken pagination is explicit failure, never silently complete',async()=>{
  const c=createOkxClient(credentials,async()=>response(Array.from({length:100},(_,i)=>({billId:String(i)}))));await assert.rejects(c.bills(1,3),/ilerlemedi/);
});
test('Telegram persists deduplication, groups incidents, enforces quiet interval and redacts',async()=>{
  let now=10000000;const requests=[],store={data:{alerts:{}},save:()=>{}};
  const request=async(u,o)=>{requests.push(JSON.parse(o.body));return {ok:true,json:async()=>({ok:true})};};
  let a=new Alerts(store,{token:'TOKEN',chatId:'123',secrets:['KEY'],demo:true},request,()=>now);
  a.raise('api','KEY API offline',30000);await a.flush();assert.equal(requests.length,0);
  now+=31000;a.raise('order','Ambiguous order');await a.flush();assert.equal(requests.length,1);assert(requests[0].text.includes('[gizli]'));assert(!requests[0].text.includes('KEY'));assert(requests[0].text.includes('Ambiguous order'));
  a=new Alerts(store,{token:'TOKEN',chatId:'123'},request,()=>now);a.raise('api','still offline');await a.flush();assert.equal(requests.length,1);
  now+=300000;a.raise('new','New serious error');await a.flush();assert.equal(requests.length,2);
  now+=3600000;await a.flush();assert.equal(requests.length,3);
});
test('resolved transient errors never notify, Telegram outage backs off',async()=>{
  let now=100000;let calls=0;const store={data:{alerts:{}},save:()=>{}};
  const a=new Alerts(store,{token:'t',chatId:'c'},async()=>{calls++;return {ok:false,status:429,json:async()=>({ok:false,parameters:{retry_after:120}})};},()=>now);
  a.raise('x','temporary',30000);a.resolve('x');now+=40000;await a.flush();assert.equal(calls,0);
  a.raise('serious','error');await a.flush();assert.equal(calls,1);assert(a.error);now+=61000;await a.flush();assert.equal(calls,1);now+=60000;await a.flush();assert.equal(calls,2);
});
test('HTTP authentication, CSRF, origin, no secrets and export access control',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'server3-'));const app=createApp({DASHBOARD_PASSWORD:'test-secret',DATA_DIR:dir,OKX_DEMO:'true'},{autoTick:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  try{
    assert.equal((await fetch(base+'/api/state')).status,401);assert.equal((await fetch(base+'/api/export')).status,401);
    const login=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({password:'test-secret'})});const cookie=login.headers.get('set-cookie').split(';')[0];assert(login.headers.get('set-cookie').includes('HttpOnly'));
    const cfg=await (await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}})).json();assert(cfg.csrf);assert.equal(cfg.demo,true);
    assert.equal((await fetch(base+'/api/bots',{method:'POST',headers:{Cookie:cookie},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/bots',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':cfg.csrf,Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/bots',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':cfg.csrf},body:'{}'})).status,503);
    const state=await (await fetch(base+'/api/state',{headers:{Cookie:cookie}})).text();assert(!state.includes('test-secret'));assert(!state.includes('secretKey'));
    const html=await fetch(base+'/');assert.equal(html.status,200);assert(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
