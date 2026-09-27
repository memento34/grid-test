import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store.js';
import {Alerts} from '../alerts.js';
import {GridEngine} from '../engine.js';
import {dec,str} from '../decimal.js';
export const input={instId:'TEST-USDT-SWAP',direction:'long',minPx:'70',maxPx:'110',targetPct:'3',amountPerTrade:'20'};
export function exchange(){
  const orders=new Map(),placed=[],rows=[];let price=100,serial=0;
  const instrument={instId:input.instId,state:'live',ctType:'linear',settleCcy:'USDT',tickSz:'0.01',lotSz:'1',minSz:'1',ctVal:'0.01',ctValCcy:'TEST'};
  const client={demo:true,credentialsReady:true,site:'global',syncTime:async()=>{},instruments:async()=>[instrument],ticker:async()=>({last:String(price),bidPx:String(price-0.01),askPx:String(price+0.01),ts:String(Date.now())}),accountConfig:async()=>({posMode:'long_short_mode'}),balance:async()=>({details:[{ccy:'USDT',availEq:'1000'}]}),algoOrders:async()=>[],gridList:async()=>[],setLeverage:async()=>[{lever:'10',mgnMode:'cross'}],
    leverageInfo:async()=>[{lever:'10',mgnMode:'cross'}],
    placeOrder:async body=>{placed.push(body);const ordId=String(++serial);orders.set(body.clOrdId,{...body,ordId,state:'live',accFillSz:'0',avgPx:body.px});return {ordId};},
    orderDetails:async(_,id)=>({...orders.get(id)}),
    cancelOrder:async(_,id)=>{const o=orders.get(id);if(o&&o.state!=='filled')o.state='canceled';return [{sCode:'0'}];},
    pendingOrders:async()=>[...orders.values()].filter(o=>['live','partially_filled'].includes(o.state)),
    positions:async()=>{
      let long=0n,short=0n;
      for(const o of orders.values()){const q=dec(o.accFillSz);if(o.posSide==='short')short+=o.side==='sell'?q:-q;else long+=o.side==='buy'?q:-q;}
      if((await client.accountConfig()).posMode==='net_mode')return long===0n?[]:[{instId:input.instId,posSide:'net',pos:str(long),mgnMode:'cross',lever:'10',upl:'1.25',markPx:String(price),liqPx:'10'}];
      return [['long',long],['short',short]].filter(([,q])=>q!==0n).map(([posSide,q])=>({instId:input.instId,posSide,pos:str(q),mgnMode:'cross',lever:'10',upl:'1.25',markPx:String(price),liqPx:'10'}));
    },bills:async()=>rows
  };
  const fill=(id,amount,state='filled')=>{const o=orders.get(id),delta=dec(amount)-dec(o.accFillSz);o.accFillSz=amount;o.state=state;if(delta>0n)rows.push({billId:String(rows.length+1),instId:input.instId,type:'2',subType:'3',ordId:o.ordId,ccy:'USDT',pnl:o.side==='sell'?'2':'0',fee:'-0.01',sz:str(delta),ts:String(Date.now()),balChg:'0'});};
  return {client,orders,placed,rows,fill,instrument,setPrice:n=>{price=n;}};
}
export function setup(){const dir=mkdtempSync(path.join(tmpdir(),'grid3-')),fake=exchange(),store=new Store(dir,'test'),alerts=new Alerts(store),engine=new GridEngine(fake.client,store,alerts);return {dir,fake,store,alerts,engine,cleanup:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};}
