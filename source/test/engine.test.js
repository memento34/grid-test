import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store.js';
import {Alerts} from '../alerts.js';
import {GridEngine,deriveGrid,buildLevels} from '../engine.js';
import {dec,str,add,quantityFor} from '../decimal.js';
import {input,exchange,setup} from './helpers.js';
test('decimal quantities support scientific ticks and exact additions',()=>{
  assert.equal(add('0.1','0.2'),'0.3');assert.equal(str(dec('1e-8')),'0.00000001');assert.equal(quantityFor('20','99','0.01','1'),'20');assert.throws(()=>dec('NaN'));
});
test('grid count matches original example and too narrow ticks fail',()=>{
  assert.equal(deriveGrid(1884.25,3485.38,1).gridNum,61);
  assert.throws(()=>buildLevels({...input,gridNum:500},{ctVal:'1',tickSz:'1',minSz:'0.01',lotSz:'0.01'}),/dar/);
});
test('five entries, full fill TP, exit rearm, replay and durable restart',async()=>{
  const x=setup();try{
    await x.engine.create(input);await x.engine.tick();assert.equal(x.fake.placed.length,5);assert(x.fake.placed.every(o=>o.ordType==='post_only'&&o.tdMode==='cross'));
    const first=x.fake.placed[0];x.fake.fill(first.clOrdId,first.sz);await x.engine.tick();
    const exit=x.fake.placed.find(o=>o.side==='sell');assert(exit);assert.equal(exit.sz,first.sz);assert(Number(exit.px)>Number(first.px));
    const before=x.fake.placed.length;await x.engine.tick();assert.equal(x.fake.placed.length,before);
    x.store.close();const recovered=new Store(x.dir,'test'),alerts=new Alerts(recovered),e=new GridEngine(x.fake.client,recovered,alerts);await e.tick();assert.equal(x.fake.placed.length,before);
    x.fake.fill(exit.clOrdId,exit.sz);await e.tick();assert.equal(recovered.data.bots[0].levels.find(l=>l.entryPx===first.px).cycle,1);assert(x.fake.placed.filter(o=>o.side==='buy'&&o.px===first.px).length===2);recovered.close();
  }finally{x.cleanup();}
});
test('partial entry protected immediately; cancel/fill race adds only uncovered remainder',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const entry=x.fake.placed[0];
    x.fake.client.cancelOrder=async()=>[];x.fake.fill(entry.clOrdId,'3','partially_filled');await x.engine.tick();
    let exits=x.fake.placed.filter(o=>o.side==='sell');assert.equal(exits.length,1);assert.equal(exits[0].sz,'3');
    x.fake.fill(entry.clOrdId,'5','canceled');await x.engine.tick();exits=x.fake.placed.filter(o=>o.side==='sell');assert.deepEqual(exits.map(o=>o.sz),['3','2']);
    assert.equal(x.store.data.bots[0].levels.filter(l=>Number(l.remaining)>0).length,1);
  }finally{x.cleanup();}
});
test('partial exit then cancellation replaces only remaining quantity',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const entry=x.fake.placed[0];x.fake.fill(entry.clOrdId,entry.sz);await x.engine.tick();const exit=x.fake.placed.find(o=>o.side==='sell');
    x.fake.fill(exit.clOrdId,'2','partially_filled');await x.engine.tick();assert.equal(x.fake.placed.filter(o=>o.side==='sell').length,1);
    x.fake.orders.get(exit.clOrdId).state='canceled';await x.engine.tick();const exits=x.fake.placed.filter(o=>o.side==='sell');assert.equal(exits.length,2,JSON.stringify({bot:x.store.data.bots[0],events:x.store.data.events}));assert.equal(Number(exits[1].sz),Number(entry.sz)-2);
  }finally{x.cleanup();}
});
test('ambiguous POST accepted by exchange never gets resubmitted',async()=>{
  const x=setup();try{await x.engine.create(input);const original=x.fake.client.placeOrder;x.fake.client.placeOrder=async b=>{await original(b);throw Object.assign(new Error('timeout'),{uncertain:true});};
    await x.engine.tick();assert.equal(x.fake.placed.length,1);assert.equal(x.store.data.bots[0].status,'paused');
    x.fake.client.placeOrder=original;await x.engine.tick();assert.equal(x.fake.placed.length,1);assert.equal(x.store.data.bots[0].orders[0].uncertain,false);
  }finally{x.cleanup();}
});
test('one order lookup error does not block a different filled level TP',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const [a,b]=x.fake.placed;x.fake.fill(b.clOrdId,b.sz);
    const get=x.fake.client.orderDetails;x.fake.client.orderDetails=async(i,id)=>{if(id===a.clOrdId)throw new Error('temporary');return get(i,id);};
    await x.engine.tick();assert(x.fake.placed.some(o=>o.side==='sell'&&o.sz===b.sz));
  }finally{x.cleanup();}
});
test('stop drains exits; no new entry, confirms zero position before stopped',async()=>{
  const x=setup();try{const id=await x.engine.create(input);await x.engine.tick();const a=x.fake.placed[0];x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();const exit=x.fake.placed.find(o=>o.side==='sell');const before=x.fake.placed.length;
    await x.engine.control(id,'stop');await x.engine.tick();assert.equal(x.fake.orders.get(exit.clOrdId).state,'live');assert.equal(x.fake.placed.length,before);
    x.fake.fill(exit.clOrdId,exit.sz);await x.engine.tick();assert.equal(x.store.data.bots[0].status,'stopped');
  }finally{x.cleanup();}
});
test('cancel acknowledgements still reserve capacity until terminal confirmation',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();x.fake.client.cancelOrder=async()=>[];x.fake.setPrice(85);await x.engine.tick();await x.engine.tick();assert.equal(x.fake.placed.length,5);
  }finally{x.cleanup();}
});
test('net long exits are reduce-only',async()=>{
  const x=setup();try{x.fake.client.accountConfig=async()=>({posMode:'net_mode'});await x.engine.create(input);await x.engine.tick();const a=x.fake.placed[0];x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();assert.equal(x.fake.placed.find(o=>o.side==='sell').reduceOnly,true);
  }finally{x.cleanup();}
});
test('short entry and exit sides are correct',async()=>{
  const x=setup();try{await x.engine.create({...input,direction:'short'});await x.engine.tick();const a=x.fake.placed[0];assert.equal(a.side,'sell');assert.equal(a.posSide,'short');x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();const exit=x.fake.placed.find(o=>o.side==='buy');assert(exit);assert(Number(exit.px)<Number(a.px));
  }finally{x.cleanup();}
});
test('position mismatch prevents new orders and foreign order latches pause',async()=>{
  const x=setup();try{await x.engine.create(input);x.fake.client.positions=async()=>[{pos:'100',posSide:'long',mgnMode:'cross',lever:'10',upl:'0'}];await x.engine.tick();assert.equal(x.fake.placed.length,0);
    x.fake.client.pendingOrders=async()=>[{clOrdId:'foreign'}];await x.engine.tick();assert.equal(x.store.data.bots[0].ownershipLost,true);await assert.rejects(x.engine.control(x.store.data.bots[0].id,'resume'));
  }finally{x.cleanup();}
});
test('PnL sums fees with signs, funding pnl not balance debit, and does not double count bills',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const a=x.fake.placed[0];x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();const exit=x.fake.placed.find(o=>o.side==='sell');x.fake.fill(exit.clOrdId,exit.sz);await x.engine.tick();
    const b=x.store.data.bots[0];x.fake.rows.push({billId:'fund',instId:input.instId,type:'8',subType:'173',ccy:'USDT',pnl:'-0.12',balChg:'0',ts:String(Date.now())});
    x.engine.lastLedgerAttempt=0;await x.engine.syncLedger();let pnl=x.engine.pnl(b);assert.equal(pnl.gross,'2');assert.equal(pnl.fees,'-0.02');assert.equal(pnl.funding,'-0.12');assert.equal(pnl.realized,'1.86');assert.equal(pnl.complete,true);
    x.engine.lastLedgerAttempt=0;await x.engine.syncLedger();assert.equal(x.engine.pnl(b).realized,'1.86');
  }finally{x.cleanup();}
});
test('missing fill accounting and ledger error prevent a falsely complete total',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const a=x.fake.placed[0];x.fake.fill(a.clOrdId,a.sz);await x.engine.tick();x.fake.rows.length=0;x.store.data.bills=[];
    assert.equal(x.engine.pnl(x.store.data.bots[0]).complete,false);assert.equal(x.engine.pnl(x.store.data.bots[0]).total,null);
    x.engine.ledgerError='failed';assert.equal(x.engine.pnl(x.store.data.bots[0]).total,null);
  }finally{x.cleanup();}
});
test('legacy state, duplicate worker and wrong environment cannot start',()=>{
  const x=setup();try{assert.throws(()=>new Store(x.dir,'test'),/kilitli/);x.store.save();x.store.close();assert.throws(()=>new Store(x.dir,'live'),/uyuşmuyor/);}finally{x.cleanup();}
  const dir=mkdtempSync(path.join(tmpdir(),'legacy-'));try{writeFileSync(path.join(dir,'manual-grids.json'),'{}');assert.throws(()=>new Store(dir,'test'),/v2/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('persistence failure prevents the external order side effect',async()=>{
  const x=setup();try{await x.engine.create(input);x.store.save=()=>{throw new Error('disk full');};await assert.rejects(x.engine.tick());assert.equal(x.fake.placed.length,0);assert.match(x.engine.fatal,/Kalıcı/);}finally{x.cleanup();}
});
test('simultaneous fills cannot exceed reserved level capacity',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();for(const o of x.fake.placed.slice())x.fake.fill(o.clOrdId,o.sz);await x.engine.tick();assert.equal(x.fake.placed.filter(o=>o.side==='sell').length,5);assert.equal(x.fake.placed.filter(o=>o.side==='buy').length,5);await x.engine.tick();assert.equal(x.fake.placed.length,10);}finally{x.cleanup();}
});
test('regressing cumulative fill is quarantined without duplicate coverage',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const o=x.fake.placed[0];x.fake.client.cancelOrder=async()=>[];x.fake.fill(o.clOrdId,'3','partially_filled');await x.engine.tick();x.fake.orders.get(o.clOrdId).accFillSz='2';await x.engine.tick();assert.equal(x.fake.placed.filter(o=>o.side==='sell').length,1);assert.equal(x.store.data.bots[0].levels.find(l=>l.entryPx===o.px).remaining,'3');}finally{x.cleanup();}
});
test('unexpected manual trade in ledger latches ownership conflict',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();x.fake.rows.push({billId:'manual',ordId:'foreign',instId:input.instId,type:'2',ccy:'USDT',sz:'1',pnl:'1',fee:'-0.01',ts:String(Date.now())});x.engine.lastLedgerAttempt=0;await x.engine.syncLedger();const b=x.store.data.bots[0];assert.equal(b.ownershipLost,true);assert.equal(b.status,'paused');assert.equal(x.engine.pnl(b).total,null);}finally{x.cleanup();}
});
test('funding income and maker rebates retain positive signs',async()=>{
  const x=setup();try{await x.engine.create(input);await x.engine.tick();const o=x.fake.placed[0];x.fake.fill(o.clOrdId,o.sz);x.fake.rows[0].fee='0.02';x.fake.rows.push({billId:'income',instId:input.instId,type:'8',subType:'174',ccy:'USDT',pnl:'0.15',balChg:'0.15',ts:String(Date.now())});await x.engine.tick();x.engine.lastLedgerAttempt=0;await x.engine.syncLedger();const p=x.engine.pnl(x.store.data.bots[0]);assert.equal(p.funding,'0.15');assert.equal(p.fees,'0.02');assert.equal(p.realized,'0.17');}finally{x.cleanup();}
});
test('leverage drift and stale quotes block entry submission',async()=>{
  const x=setup();try{await x.engine.create(input);x.fake.client.leverageInfo=async()=>[{lever:'20',mgnMode:'cross'}];await x.engine.tick();assert.equal(x.fake.placed.length,0);assert.equal(x.store.data.bots[0].status,'paused');}finally{x.cleanup();}
  const y=setup();try{await y.engine.create(input);const get=y.fake.client.ticker;y.fake.client.ticker=async()=>({...await get(),ts:String(Date.now()-20000)});await y.engine.tick();assert.equal(y.fake.placed.length,0);}finally{y.cleanup();}
});
test('live grid starts without typed confirmation; existing exposure still blocks creation',async()=>{
  const x=setup();try{x.fake.client.demo=false;await x.engine.create(input);await x.engine.tick();assert.equal(x.fake.placed.length,5);}finally{x.cleanup();}
  const y=setup();try{y.fake.client.demo=false;y.fake.client.positions=async()=>[{pos:'1'}];await assert.rejects(y.engine.create(input),/pozisyon/);assert.equal(y.fake.placed.length,0);}finally{y.cleanup();}
});
test('loss threshold pauses entries without pretending positions were closed',async()=>{
  const x=setup();try{await x.engine.create({...input,maxLoss:'1'});await x.engine.tick();const a=x.fake.placed[0];x.fake.fill(a.clOrdId,a.sz);const positions=x.fake.client.positions;x.fake.client.positions=async()=> (await positions()).map(p=>({...p,upl:'-10'}));await x.engine.tick();x.engine.lastLedgerAttempt=0;await x.engine.syncLedger();await x.engine.tick();const b=x.store.data.bots[0];assert.equal(b.status,'paused');assert(b.levels.some(l=>Number(l.remaining)>0));assert(x.fake.placed.some(o=>o.side==='sell'&&o.ordType==='limit'));assert(!x.fake.placed.some(o=>o.ordType==='market'));}finally{x.cleanup();}
});
test('crash after exchange accepts but before acknowledgement save recovers intent once',async()=>{
  const x=setup();let recovered;try{await x.engine.create(input);const b=x.store.data.bots[0],l=b.levels[0],save=x.store.save.bind(x.store);let saves=0;x.store.save=()=>{if(++saves===2)throw new Error('crash');save();};await assert.rejects(x.engine.place(b,l,'entry',l.sz));assert.equal(x.fake.placed.length,1);x.store.close();recovered=new Store(x.dir,'test');const e=new GridEngine(x.fake.client,recovered,new Alerts(recovered));recovered.data.bots[0].status='paused';await e.tick();assert.equal(x.fake.placed.length,1);assert.equal(recovered.data.bots[0].orders[0].uncertain,false);}finally{recovered?.close();x.cleanup();}
});
