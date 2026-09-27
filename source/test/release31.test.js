import test from 'node:test';
import assert from 'node:assert/strict';
import {createOkxClient} from '../okx.js';
import {GridEngine,deriveGrid,defaultGridRange} from '../engine.js';
import {Alerts} from '../alerts.js';
import {Store} from '../store.js';
import {createApp} from '../server.js';
import {setup,input} from './helpers.js';

test('odd RTT never produces fractional expTime for entry or exit (51000 regression)',async()=>{
  let now=1700000000000;const headers=[];
  const client=createOkxClient({apiKey:'TEST',secretKey:'TEST',passphrase:'TEST'},async(url,options)=>{
    if(url.includes('/public/time')){now+=1;return {ok:true,status:200,json:async()=>({code:'0',data:[{ts:'1700000000000'}]})};}
    headers.push(options.headers);
    return {ok:true,status:200,json:async()=>/^\d{13}$/.test(options.headers.expTime)?{code:'0',data:[{ordId:String(headers.length),sCode:'0'}]}:{code:'1',data:[{sCode:'51000',sMsg:'Parameter expTime error'}]}};
  },()=>now);
  await client.syncTime();await client.placeOrder({side:'sell',posSide:'short'});now+=200;await client.placeOrder({side:'buy',posSide:'short'});
  assert.equal(headers.length,2);for(const h of headers){assert.match(h.expTime,/^\d{13}$/);assert.equal(Number(h.expTime)-Date.parse(h['OK-ACCESS-TIMESTAMP']),10000);}
});
test('default range is exactly 50 geometric steps each side and derives 100 intervals',()=>{
  for(const price of ['100','2688.5','0.0000012345','98765.4321']){
    const r=defaultGridRange(price);assert.equal(deriveGrid(r.minPx,r.maxPx,r.targetPct).gridNum,100);
    assert(Math.abs(Math.log(Number(price)/Number(r.minPx))/Math.log(1.01)-50)<1e-9);
    assert(Math.abs(Math.log(Number(r.maxPx)/Number(price))/Math.log(1.01)-50)<1e-9);
  }
});
const neutralInput=()=>({...input,...defaultGridRange('100'),direction:'neutral'});
const pending=(x,side)=>[...x.fake.orders.values()].filter(o=>o.posSide===side&&o.side===(side==='long'?'buy':'sell')&&['live','partially_filled'].includes(o.state));
test('neutral starts five long BELOW market and five short ABOVE market with 50+50 capacity',async()=>{
  const x=setup();try{await x.engine.create(neutralInput());await x.engine.tick();
    assert.equal(pending(x,'long').length,5);assert.equal(pending(x,'short').length,5);
    assert(pending(x,'long').every(o=>Number(o.px)<99.99));assert(pending(x,'short').every(o=>Number(o.px)>100.01));
    assert.deepEqual(x.store.data.bots[0].neutralCaps,{long:50,short:50});assert.equal(x.fake.placed.length,10);
  }finally{x.cleanup();}
});
test('neutral replenishes entry window after fills, preserving all take-profit orders',async()=>{
  const x=setup();try{await x.engine.create(neutralInput());await x.engine.tick();
    for(const side of ['long','short']){const a=pending(x,side)[0];x.fake.fill(a.clOrdId,a.sz);}
    await x.engine.tick();assert.equal(pending(x,'long').length,5);assert.equal(pending(x,'short').length,5);
    const b=x.store.data.bots[0],exits=x.engine.live(b,undefined,'exit');assert.equal(exits.length,2);
    const exitIDs=exits.map(o=>o.clOrdId);await x.engine.tick();assert(exitIDs.every(id=>x.fake.orders.get(id).state==='live'));
    assert.equal(b.levels.filter(l=>Number(l.remaining)>0).length,2);
  }finally{x.cleanup();}
});
test('neutral accumulates more than five positions but never exceeds each-side grid capacity',async()=>{
  const x=setup();try{const cfg={...input,minPx:'90',maxPx:'111',targetPct:'1',direction:'neutral'};await x.engine.create(cfg);await x.engine.tick();const b=x.store.data.bots[0],cap=b.neutralCaps.long;
    for(let round=0;round<cap+2;round++){const a=pending(x,'long')[0];if(!a)break;x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();}
    const longUsed=b.levels.filter(l=>l.direction==='long'&&(Number(l.remaining)>0||x.engine.live(b,l).length)).length;
    assert.equal(longUsed,cap);assert(b.levels.filter(l=>l.direction==='long'&&Number(l.remaining)>0).length>5);assert.equal(pending(x,'long').length,0);assert.equal(pending(x,'short').length,5);
  }finally{x.cleanup();}
});
test('neutral keeps long levels below fixed starting center as price rises',async()=>{
  const x=setup();try{await x.engine.create(neutralInput());await x.engine.tick();x.fake.setPrice(120);await x.engine.tick();await x.engine.tick();
    assert.equal(pending(x,'long').length,5);assert.equal(pending(x,'short').length,5);
    assert(pending(x,'long').every(o=>Number(o.px)<119.99));assert(pending(x,'short').every(o=>Number(o.px)>120.01));
    assert(pending(x,'long').every(o=>Number(o.px)<100),'Long entries must stay below the initial center');
  }finally{x.cleanup();}
});
test('neutral outstanding cancels reserve each-side entry window, not just total cap',async()=>{
  const x=setup();try{await x.engine.create(neutralInput());await x.engine.tick();x.fake.client.cancelOrder=async()=>[];x.fake.setPrice(120);await x.engine.tick();await x.engine.tick();assert.equal(pending(x,'long').length,5);assert.equal(pending(x,'short').length,5);assert.equal(x.fake.placed.length,10);}finally{x.cleanup();}
});
test('new neutral policy and open orders survive restart without duplicate entries',async()=>{
  const x=setup();let recovered;try{await x.engine.create(neutralInput());await x.engine.tick();const before=x.fake.placed.length;x.store.close();recovered=new Store(x.dir,'test');const engine=new GridEngine(x.fake.client,recovered,new Alerts(recovered));await engine.tick();assert.equal(x.fake.placed.length,before);assert.deepEqual(recovered.data.bots[0].neutralCaps,{long:50,short:50});}finally{recovered?.close();x.cleanup();}
});
test('old saved neutral bot retains original capacity and order identities',async()=>{
  const x=setup();try{await x.engine.create(neutralInput());const b=x.store.data.bots[0];delete b.neutralPolicy;delete b.neutralCaps;await x.engine.tick();assert.equal(x.fake.placed.length,5);}finally{x.cleanup();}
});
test('startup Telegram sends once after confirmation, survives notifier restart, and does not delay critical alerts',async()=>{
  let now=10000000;const store={data:{alerts:{}},save(){}},messages=[];const request=async(_,o)=>{messages.push(JSON.parse(o.body).text);return {ok:true,json:async()=>({ok:true})};};
  let alerts=new Alerts(store,{token:'t',chatId:'c'},request,()=>now);alerts.queueStartup('Sağlıklı bağlantı');await alerts.flush();assert.equal(messages.length,1);assert.match(messages[0],/SİSTEM HAZIR/);
  alerts=new Alerts(store,{token:'t',chatId:'c'},request,()=>now);alerts.queueStartup('Tekrar');await alerts.flush();assert.equal(messages.length,1);
  alerts.raise('serious','Kâr alma emri kurulamadı');await alerts.flush();assert.equal(messages.length,2);assert.match(messages[1],/CİDDİ HATA/);
});
test('unresolved critical incident suppresses startup health message',async()=>{
  const store={data:{alerts:{}},save(){}},messages=[];const alerts=new Alerts(store,{token:'t',chatId:'c'},async(_,o)=>{messages.push(JSON.parse(o.body).text);return {ok:true,json:async()=>({ok:true})};});
  alerts.queueStartup('Ready');alerts.raise('bad','API unavailable',60000);await alerts.flush();assert.equal(messages.length,0);
});
test('expired or persisted startup health requires a fresh successful check before sending',async()=>{
  let now=10000000;const store={data:{alerts:{}},save(){}},messages=[];
  const request=async(_,o)=>{messages.push(JSON.parse(o.body).text);return {ok:true,json:async()=>({ok:true})};};
  let alerts=new Alerts(store,{token:'t',chatId:'c'},request,()=>now);
  alerts.queueStartup('Old health');now+=90001;await alerts.flush();assert.equal(messages.length,0);
  alerts.queueStartup('Refreshed health');alerts=new Alerts(store,{token:'t',chatId:'c'},request,()=>now);
  await alerts.flush();assert.equal(messages.length,0);
  alerts.queueStartup('Rechecked after restart');await alerts.flush();assert.equal(messages.length,1);assert.match(messages[0],/Rechecked after restart/);
});
test('failed private account check never announces healthy startup',async()=>{
  const x=setup(),messages=[];x.fake.client.accountConfig=async()=>{throw new Error('API authentication denied');};
  x.alerts=new Alerts(x.store,{token:'t',chatId:'c'},async(_,o)=>{messages.push(JSON.parse(o.body).text);return {ok:true,json:async()=>({ok:true})};});
  const app=createApp({DASHBOARD_PASSWORD:'local',DATA_DIR:x.dir},{store:x.store,engine:x.engine,okx:x.fake.client,alerts:x.alerts,autoTick:false});
  try{x.engine.lastTick=Date.now();await app.checkStartup();assert.equal(messages.length,0);assert.equal(x.store.data.telegramStartup,undefined);assert.match(x.store.data.alerts['startup-api'].message,/authentication denied/);}finally{await app.close();x.cleanup();}
});
test('server startup health requires private account access, writable storage and completed loop',async()=>{
  const x=setup(),messages=[];x.alerts=new Alerts(x.store,{token:'t',chatId:'c'},async(_,o)=>{messages.push(JSON.parse(o.body).text);return {ok:true,json:async()=>({ok:true})};});
  const app=createApp({DASHBOARD_PASSWORD:'local',DATA_DIR:x.dir},{store:x.store,engine:x.engine,okx:x.fake.client,alerts:x.alerts,autoTick:false});
  try{await app.checkStartup();assert.equal(messages.length,0);x.engine.lastTick=Date.now();await app.checkStartup();assert.equal(messages.length,1);await app.checkStartup();assert.equal(messages.length,1);}finally{await app.close();x.cleanup();}
});
