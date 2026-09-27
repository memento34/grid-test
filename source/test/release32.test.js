import test from 'node:test';
import assert from 'node:assert/strict';
import {GridEngine,defaultGridRange,buildLevels} from '../engine.js';
import {Store} from '../store.js';
import {Alerts} from '../alerts.js';
import {createApp} from '../server.js';
import {dec,str} from '../decimal.js';
import {input,setup} from './helpers.js';

const neutral=()=>({...input,...defaultGridRange('100'),direction:'neutral'});
const net=x=>{x.fake.client.accountConfig=async()=>({posMode:'net_mode'});};
const entries=(x,side)=>x.engine.live(x.store.data.bots[0],undefined,'entry').filter(o=>!side||x.store.data.bots[0].levels[o.level].direction===side);
const markFilled=(x,o)=>x.fake.fill(o.clOrdId,o.sz);

test('neutral pivot uses starting ticker instead of midpoint, one direction per level',async()=>{
  const x=setup();try{
    const p=await x.engine.plan({...neutral(),minPx:'80',maxPx:'150'});
    assert.equal(p.settings.referencePx,'100');assert.equal(p.settings.neutralPolicy,'fixed-center');
    assert(p.levels.filter(l=>l.direction==='long').every(l=>Number(l.entryPx)<100&&Number(l.exitPx)<=100));
    assert(p.levels.filter(l=>l.direction==='short').every(l=>Number(l.entryPx)>100&&Number(l.exitPx)>=100));
    assert.equal(p.levels.length,p.settings.gridNum);assert.equal(new Set(p.levels.map(l=>l.entryPx)).size,p.levels.length);
    assert.equal(p.levels.find(l=>l.direction==='long').exitPx,'100');
    assert.equal(p.levels.find(l=>l.direction==='short').exitPx,'100');
  }finally{x.cleanup();}
});

test('narrow neutral range may have fewer than five entries without rejecting the bot',async()=>{
  const x=setup();try{await x.engine.create({...neutral(),minPx:'98',maxPx:'102'});await x.engine.tick();const b=x.store.data.bots[0];
    assert.equal(b.neutralCaps.long,2);assert.equal(b.neutralCaps.short,1);assert.equal(x.fake.placed.length,3);
  }finally{x.cleanup();}
});

test('net neutral starts flat, needs no hedge switch and sizes margin for one side',async()=>{
  const x=setup();try{net(x);const p=await x.engine.plan(neutral());
    assert.equal(p.settings.neutralExecution,'net-sequential');assert.equal(p.maxEntryNotional,100);assert.equal(p.maxReservedNotional,1000);
    await x.engine.create(neutral());await x.engine.tick();assert.equal(x.fake.placed.length,0);
    x.fake.setPrice(100.1);await x.engine.tick();assert.equal(entries(x,'short').length,5);assert.equal(entries(x,'long').length,0);
    assert(x.fake.placed.every(o=>o.side==='sell'&&!o.posSide&&o.tdMode==='cross'));
  }finally{x.cleanup();}
});

test('100 to 105.2 then 96 at 1 percent: five shorts close, then four longs remain (net mode)',async()=>{
  const x=setup();try{net(x);await x.engine.create(neutral());await x.engine.tick();
    const sweep=async price=>{
      x.fake.setPrice(price);
      for(const o of [...x.fake.orders.values()])if(['live','partially_filled'].includes(o.state)&&(o.side==='sell'?Number(o.px)<=price:Number(o.px)>=price))markFilled(x,o);
      await x.engine.tick();await x.engine.tick();
    };
    await sweep(100.1);for(const p of [101.1,102.1,103.1,104.2,105.2])await sweep(p);
    const b=x.store.data.bots[0];assert.equal(b.levels.filter(l=>l.direction==='short'&&dec(l.remaining)>0n).length,5);
    for(const p of [104,103,102,101,99.9])await sweep(p);
    assert.equal(b.levels.filter(l=>l.direction==='short'&&dec(l.remaining)>0n).length,0);
    assert.equal(b.levels.filter(l=>l.direction==='short').reduce((n,l)=>n+l.cycle,0),5);
    assert.equal(entries(x,'long').length,5);await sweep(96);
    assert.equal(b.levels.filter(l=>l.direction==='long'&&dec(l.remaining)>0n).length,4);
    assert.equal(b.status,'running');assert.equal(b.matched,true);
    assert(x.engine.live(b,undefined,'exit').every(o=>x.fake.orders.get(o.clOrdId).reduceOnly===true));
    assert(x.fake.placed.every(o=>o.ordType!=='market'));
  }finally{x.cleanup();}
});

test('net neutral never places opposite entries while short exit is only partially filled',async()=>{
  const x=setup();try{net(x);await x.engine.create(neutral());x.fake.setPrice(100.1);await x.engine.tick();markFilled(x,entries(x,'short')[0]);await x.engine.tick();
    const b=x.store.data.bots[0],exit=x.engine.live(b,undefined,'exit')[0];x.fake.fill(exit.clOrdId,'1','partially_filled');x.fake.setPrice(96);
    await x.engine.tick();await x.engine.tick();assert.equal(entries(x,'long').length,0);assert(dec(b.levels[exit.level].remaining)>0n);
    markFilled(x,exit);await x.engine.tick();await x.engine.tick();assert(entries(x,'long').length>0);assert.equal(b.matched,true);
  }finally{x.cleanup();}
});

test('net neutral waits for pending short cancellations and handles late fills before switching',async()=>{
  const x=setup();try{net(x);await x.engine.create(neutral());x.fake.setPrice(100.1);await x.engine.tick();const shorts=entries(x,'short').slice();
    x.fake.client.cancelOrder=async()=>[];x.fake.setPrice(99.9);await x.engine.tick();await x.engine.tick();assert.equal(entries(x,'long').length,0);
    markFilled(x,shorts[0]);for(const o of shorts.slice(1))x.fake.orders.get(o.clOrdId).state='canceled';
    await x.engine.tick();assert.equal(entries(x,'long').length,0);assert.equal(x.engine.live(x.store.data.bots[0],undefined,'exit').length,1);
  }finally{x.cleanup();}
});

test('net neutral direction lock survives restart with an open short',async()=>{
  const x=setup();let recovered;try{net(x);await x.engine.create(neutral());x.fake.setPrice(100.1);await x.engine.tick();markFilled(x,entries(x,'short')[0]);await x.engine.tick();
    const old=x.store.data.bots[0],ids=old.orders.map(o=>o.clOrdId);x.store.close();recovered=new Store(x.dir,'test');
    const e=new GridEngine(x.fake.client,recovered,new Alerts(recovered));x.fake.setPrice(98);await e.tick();await e.tick();
    const b=recovered.data.bots[0];assert.equal(b.referencePx,'100');assert(ids.every(id=>b.orders.some(o=>o.clOrdId===id)));
    assert.equal(e.live(b,undefined,'entry').filter(o=>b.levels[o.level].direction==='long').length,0);assert.equal(b.matched,true);
  }finally{recovered?.close();x.cleanup();}
});

test('legacy moving-center neutral keeps existing grid prices, directions, capacity and IDs',async()=>{
  const x=setup();let recovered;try{await x.engine.create(neutral());const b=x.store.data.bots[0];
    b.neutralPolicy='per-side-window';delete b.referencePx;delete b.neutralExecution;b.gridNum=100;b.levels=buildLevels(b,x.fake.instrument);
    await x.engine.tick();const saved=JSON.stringify(b.levels),ids=b.orders.map(o=>o.clOrdId);x.store.close();recovered=new Store(x.dir,'test');
    const e=new GridEngine(x.fake.client,recovered,new Alerts(recovered));await e.tick();
    assert.equal(JSON.stringify(recovered.data.bots[0].levels),saved);assert.deepEqual(recovered.data.bots[0].orders.map(o=>o.clOrdId),ids);assert.equal(recovered.data.bots[0].neutralPolicy,'per-side-window');
  }finally{recovered?.close();x.cleanup();}
});

test('cancel 51400 race applies full entry fill once and installs one TP',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const b=x.store.data.bots[0],o=entries(x)[0],normalCancel=x.fake.client.cancelOrder;
    x.fake.client.cancelOrder=async(i,id)=>{if(id===o.clOrdId){markFilled(x,o);throw Object.assign(new Error('filled, canceled or nonexistent'),{code:'51400'});}return normalCancel(i,id);};
    await x.engine.control(b.id,'pause');await x.engine.cancel(b,o);assert.equal(o.state,'filled');assert.equal(b.levels[o.level].remaining,o.sz);
    await x.engine.tick();await x.engine.tick();const exits=b.orders.filter(z=>z.level===o.level&&z.purpose==='exit');assert.equal(exits.length,1);assert.equal(exits[0].sz,o.sz);
    assert(!x.store.data.events.some(e=>e.code==='cancel'&&e.severity==='critical'));
  }finally{x.cleanup();}
});

test('cancel 51401 terminal canceled order retains partial fill and protects it',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const b=x.store.data.bots[0],o=entries(x)[0];
    x.fake.client.cancelOrder=async()=>{x.fake.fill(o.clOrdId,'2','canceled');throw Object.assign(new Error('already canceled'),{code:'51401'});};
    await x.engine.cancel(b,o);assert.equal(o.state,'canceled');assert.equal(b.levels[o.level].remaining,'2');
    x.fake.client.cancelOrder=async()=>[];await x.engine.tick();assert.equal(b.orders.find(z=>z.level===o.level&&z.purpose==='exit').sz,'2');
  }finally{x.cleanup();}
});

test('51400 without queryable order remains uncertain, never assumed canceled',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const b=x.store.data.bots[0],o=entries(x)[0];
    x.fake.client.cancelOrder=async()=>{throw Object.assign(new Error('not found'),{code:'51400'});};x.fake.client.orderDetails=async()=>null;
    await x.engine.cancel(b,o);assert.equal(o.uncertain,true);assert(x.engine.live(b).includes(o));assert.equal(b.levels[o.level].remaining,'0');
  }finally{x.cleanup();}
});

test('fill arriving between order read and position read is reconciled in same tick',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const b=x.store.data.bots[0],o=entries(x)[0],positions=x.fake.client.positions;let once=true;
    x.fake.client.positions=async()=>{if(once){once=false;markFilled(x,o);}return positions();};
    await x.engine.tick();assert.equal(b.matched,true);assert.equal(b.status,'running');assert.equal(b.levels[o.level].remaining,o.sz);
    assert.equal(b.orders.filter(z=>z.level===o.level&&z.purpose==='exit').length,1);assert(!x.store.data.events.some(e=>e.code==='position'));
  }finally{x.cleanup();}
});

test('exit filling after its first read does not produce false position alarm or duplicate exit',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();markFilled(x,entries(x)[0]);await x.engine.tick();
    const b=x.store.data.bots[0],exit=x.engine.live(b,undefined,'exit')[0],positions=x.fake.client.positions;let once=true;
    x.fake.client.positions=async()=>{if(once){once=false;markFilled(x,exit);}return positions();};
    await x.engine.tick();assert.equal(b.matched,true);assert.equal(b.status,'running');assert.equal(b.levels[exit.level].remaining,'0');assert.equal(b.levels[exit.level].cycle,1);
    assert.equal(b.orders.filter(o=>o.level===exit.level&&o.purpose==='exit').length,1);assert(!x.store.data.events.some(e=>e.code==='position'));
  }finally{x.cleanup();}
});

test('a genuinely different position still blocks entries and pauses after grace',async()=>{
  const x=setup();try{await x.engine.create(input);const b=x.store.data.bots[0];b.mismatchSince=Date.now()-20000;
    x.fake.client.positions=async()=>[{instId:input.instId,posSide:'long',pos:'999',mgnMode:'cross',lever:'10',upl:'0'}];await x.engine.tick();
    assert.equal(b.matched,false);assert.equal(b.status,'paused');assert.equal(x.fake.placed.length,0);assert(b.levels.every(l=>l.remaining==='0'));
  }finally{x.cleanup();}
});

test('short REST consistency wait is informational; persistent mismatch remains critical',async()=>{
  const x=setup();try{await x.engine.create(input);const b=x.store.data.bots[0];
    x.fake.client.positions=async()=>[{instId:input.instId,posSide:'long',pos:'999',mgnMode:'cross',lever:'10',upl:'0'}];await x.engine.tick();
    assert.equal(b.matched,false);assert.equal(x.fake.placed.length,0);assert(b.syncNote);assert(!x.store.data.events.some(e=>e.code==='position'&&e.severity==='critical'));
    b.mismatchSince=Date.now()-16000;await x.engine.tick();assert.equal(b.status,'paused');assert(x.store.data.events.some(e=>e.code==='position'&&e.severity==='critical'));
  }finally{x.cleanup();}
});

test('net neutral is accepted by authenticated HTTP preview and start routes',async()=>{
  const x=setup();net(x);const app=createApp({DASHBOARD_PASSWORD:'test',DATA_DIR:x.dir},{store:x.store,engine:x.engine,okx:x.fake.client,alerts:x.alerts,autoTick:false});
  try{
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
    const login=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({password:'test'})}),cookie=login.headers.get('set-cookie').split(';')[0];
    const cfg=await(await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
    const options={method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':cfg.csrf,'Content-Type':'application/json'},body:JSON.stringify(neutral())};
    const preview=await fetch(base+'/api/preview',options);assert.equal(preview.status,200);
    assert.equal((await preview.json()).settings.neutralExecution,'net-sequential');
    const start=await fetch(base+'/api/bots',options);assert.equal(start.status,201);assert.match((await start.json()).id,/^[a-f0-9]{12}$/);
    assert.equal(x.fake.placed.length,0);assert.equal(x.store.data.bots[0].posMode,'net_mode');
    const html=await(await fetch(base+'/')).text();assert(!html.includes('hedge gerekli'));assert(html.includes('sabit merkez'));
  }finally{await app.close();x.cleanup();}
});
