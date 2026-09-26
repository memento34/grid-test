import { randomBytes } from 'node:crypto';
import { dec,str,add,sub,sum,positive,floorStep,quantityFor } from './decimal.js';
const TERMINAL=new Set(['filled','canceled','mmp_canceled','rejected']);
const active=o=>!TERMINAL.has(o.state);
const abs=n=>n<0n?-n:n;
export function deriveGrid(min,max,pct){
  const lo=positive(min,'Alt fiyat'),hi=positive(max,'Üst fiyat'),p=positive(pct,'Grid yüzdesi');
  if(hi<=lo||p<0.1||p>25)throw new Error('Fiyat aralığı veya yüzde geçersiz (%0,1–25).');
  const gridNum=Math.floor(Math.log(hi/lo)/Math.log1p(p/100));
  if(gridNum<2||gridNum>500)throw new Error('Grid sayısı 2–500 arasında olmalı.');
  return {gridNum,effectivePct:((hi/lo)**(1/gridNum)-1)*100};
}
export function buildLevels(c,i){
  if(!['long','short','neutral'].includes(c.direction))throw new Error('Yön geçersiz.');
  for(const k of ['tickSz','lotSz','minSz','ctVal'])positive(i[k],k);
  const prices=Array.from({length:c.gridNum+1},(_,n)=>floorStep((Number(c.minPx)*(Number(c.maxPx)/Number(c.minPx))**(n/c.gridNum)).toPrecision(15),i.tickSz));
  const mid=(Number(c.minPx)+Number(c.maxPx))/2;
  return prices.slice(0,-1).map((p,n)=>{
    if(dec(prices[n+1])<=dec(p))throw new Error('Grid aralığı fiyat adımından dar.');
    const direction=c.direction==='neutral'?(Number(p)<mid?'long':'short'):c.direction;
    const entryPx=direction==='long'?p:prices[n+1],exitPx=direction==='long'?prices[n+1]:p;
    const sz=quantityFor(c.amountPerTrade,entryPx,i.ctVal,i.lotSz);
    if(dec(sz)<dec(i.minSz))throw new Error('İşlem tutarı minimum sözleşme miktarına yetmiyor.');
    return {index:n,direction,entryPx,exitPx,sz,remaining:'0',cycle:0,hadFill:false,retryAt:0};
  });
}
export class GridEngine {
  constructor(okx,store,alerts,limits={}){
    this.okx=okx;this.store=store;this.alerts=alerts;this.maxTrade=limits.maxTrade||100;this.maxBots=limits.maxBots||5;
    this.busy=false;this.queue=Promise.resolve();this.fatal='';this.lastTick=0;this.lastDuration=0;this.ledgerError='';this.lastLedgerAttempt=0;this.balance=null;
    for(const b of store.data.bots){b.snapshotAt=0;b.matched=false;}
  }
  exclusive(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  exchangeNow(){return this.okx.now?this.okx.now():Date.now();}
  save(){try{this.store.save();}catch(e){this.fatal='Kalıcı kayıt yazılamadı; emir gönderimi durduruldu. '+e.message;this.alerts.raise('storage',this.fatal);throw e;}}
  event(bot,code,message,severity='info'){
    const events=this.store.data.events,last=events.at(-1);
    if(last?.botId===bot?.id&&last.code===code&&last.message===message&&Date.now()-last.at<60000)return;
    events.push({at:Date.now(),botId:bot?.id||'',instId:bot?.instId||'',code,message:this.alerts.redact(message),severity});
    if(events.length>1000)events.splice(0,events.length-1000);
  }
  issue(bot,code,message,grace=0){this.event(bot,code,message,'critical');this.alerts.raise(bot.id+':'+code,bot.instId+' • '+message,grace);bot.error=message;}
  resolve(bot,code){this.alerts.resolve(bot.id+':'+code);}
  live(bot,level,purpose){return bot.orders.filter(o=>active(o)&&(level===undefined||o.level===level.index)&&(!purpose||o.purpose===purpose));}
  async plan(input){
    const instId=String(input.instId||'');if(!/^[A-Z0-9]+-USDT-SWAP$/.test(instId))throw new Error('Yalnızca USDT SWAP desteklenir.');
    const amount=positive(input.amountPerTrade,'İşlem başı USDT');if(amount>this.maxTrade)throw new Error('İşlem başı limit '+this.maxTrade+' USDT.');
    const maxLevels=Number(input.maxLevels||5);if(!Number.isInteger(maxLevels)||maxLevels<1||maxLevels>5)throw new Error('Açık seviye sınırı 1–5.');
    const maxLoss=Number(input.maxLoss||0);if(!Number.isFinite(maxLoss)||maxLoss<0)throw new Error('Zarar eşiği geçersiz.');
    const instrument=(await this.okx.instruments()).find(i=>i.instId===instId);
    if(!instrument||instrument.ctType!=='linear'||instrument.ctValCcy!==instId.split('-')[0]||instrument.settleCcy!=='USDT')throw new Error('Canlı USDT doğrusal sözleşme bulunamadı.');
    const settings={instId,direction:input.direction,minPx:String(input.minPx),maxPx:String(input.maxPx),targetPct:Number(input.targetPct),...deriveGrid(input.minPx,input.maxPx,input.targetPct),amountPerTrade:String(input.amountPerTrade),maxLevels,maxLoss,tdMode:'cross',leverage:10};
    const levels=buildLevels(settings,instrument),ticker=await this.okx.ticker(instId);this.validateTicker(ticker);
    if(Number(ticker.last)<=Number(settings.minPx)||Number(ticker.last)>=Number(settings.maxPx))throw new Error('Anlık fiyat grid aralığının içinde olmalı.');
    return {settings,instrument,levels,ticker,maxEntryNotional:amount*maxLevels,approxInitialMargin:amount*maxLevels/10};
  }
  validateTicker(t){for(const k of ['last','bidPx','askPx'])positive(t[k],k);if(Number(t.bidPx)>Number(t.askPx)||!Number.isFinite(Number(t.ts))||Math.abs(this.exchangeNow()-Number(t.ts))>15000)throw new Error('Piyasa fiyatı eski veya geçersiz.');}
  create(input){return this.exclusive(async()=>{
    if(this.fatal)throw new Error(this.fatal);
    const bots=this.store.data.bots;
    if(bots.filter(b=>b.status!=='stopped').length>=this.maxBots)throw new Error('Aktif bot sınırına ulaşıldı.');
    if(bots.some(b=>b.instId===input.instId&&b.status!=='stopped'))throw new Error('Paritede mevcut bot var.');
    await this.okx.syncTime();const p=await this.plan(input);
    const account=await this.okx.accountConfig();
    if(!['net_mode','long_short_mode'].includes(account.posMode))throw new Error('Pozisyon modu desteklenmiyor.');
    if(input.direction==='neutral'&&account.posMode!=='long_short_mode')throw new Error('Nötr grid hedge (long/short) modu gerektirir.');
    const [positions,orders,algos,native,balance]=await Promise.all([this.okx.positions(input.instId),this.okx.pendingOrders(input.instId),this.okx.algoOrders(input.instId),this.okx.gridList(),this.okx.balance()]);
    if(positions.some(x=>dec(x.pos)!==0n)||orders.length||algos.length||native.some(x=>x.instId===input.instId))throw new Error('Bu paritede pozisyon, emir veya başka bot var. Ayrı parite / alt hesap kullanın.');
    const usdt=balance.details?.find(x=>x.ccy==='USDT');
    if(!usdt||!Number.isFinite(Number(usdt.availEq))||Number(usdt.availEq)<p.approxInitialMargin*1.2)throw new Error('USDT kullanılabilir özsermaye yetersiz veya doğrulanamadı (%20 başlangıç tamponu).');
    const applied=await this.okx.setLeverage(input.instId,10,'cross');
    if(!applied.some(x=>Number(x.lever)===10&&x.mgnMode==='cross'))throw new Error('Cross 10× doğrulanamadı.');
    const b={id:randomBytes(6).toString('hex'),...p.settings,instrument:p.instrument,posMode:account.posMode,status:'running',createdAt:this.exchangeNow(),orders:[],levels:p.levels,seq:0,error:'',matched:false,snapshotAt:0,positions:[],ownershipLost:false};
    bots.push(b);this.event(b,'created','Bot oluşturuldu.');this.save();return b.id;
  });}
  control(id,action){return this.exclusive(async()=>{
    const b=this.store.data.bots.find(x=>x.id===id);if(!b)throw new Error('Bot yok.');
    if(action==='resume'){
      if(this.fatal||b.ownershipLost||!b.matched||Date.now()-b.snapshotAt>15000||this.live(b).some(o=>o.uncertain)||this.ledgerError)throw new Error('Devam etmek için güncel mutabakat ve eksiksiz kayıt gerekir.');
      if(b.status==='stopped')throw new Error('Tamamlanmış bot yeniden başlatılamaz.');
      b.status='running';b.error='';for(const key of ['entry','exit','api','unknown','risk'])this.resolve(b,key);
    }else if(action==='pause')b.status='paused';
    else if(action==='stop'){if(b.status==='stopped')return;b.status='stopping';}
    else throw new Error('Komut geçersiz.');
    this.event(b,action,action==='stop'?'Yeni girişler kesildi; kâr alma emirlerinin dolması bekleniyor.':action==='pause'?'Girişler duraklatıldı; çıkış yönetimi sürüyor.':'Girişler yeniden etkin.');this.save();
  });}
  async place(b,l,purpose,sz){
    if(this.fatal)throw new Error(this.fatal);
    if(purpose==='entry'&&b.status!=='running')return;
    if(Date.now()<(l.retryAt||0))return;
    const q=dec(sz);if(q<=0n||q%dec(b.instrument.lotSz))throw new Error('Emir miktarı lot adımına uymuyor.');
    const entry=purpose==='entry',isLong=l.direction==='long';
    const o={clOrdId:'G3'+b.id+(++b.seq).toString(36).padStart(8,'0'),ordId:'',level:l.index,purpose,sz:str(q),fill:'0',state:'submitting',createdAt:Date.now(),uncertain:true,cancelAt:0};
    b.orders.push(o);this.save(); // Durable intent BEFORE any external side effect.
    const body={instId:b.instId,tdMode:'cross',clOrdId:o.clOrdId,side:entry?(isLong?'buy':'sell'):(isLong?'sell':'buy'),ordType:entry?'post_only':'limit',sz:o.sz,px:entry?l.entryPx:l.exitPx};
    if(b.posMode==='long_short_mode')body.posSide=l.direction;else if(!entry)body.reduceOnly=true;
    try{
      const result=await this.okx.placeOrder(body);o.ordId=result.ordId;o.state='live';o.uncertain=false;
      this.event(b,'order',purpose+' • seviye '+l.index+' • '+o.sz+' @ '+body.px);this.resolve(b,purpose);
    }catch(e){
      if(e.uncertain!==false){o.state='unknown';o.uncertain=true;this.issue(b,'unknown','Emir sonucu belirsiz: '+o.clOrdId+'. Aynı emir tekrar gönderilmeyecek.');}
      else{o.state='rejected';o.uncertain=false;o.finishedAt=Date.now();l.retryAt=Date.now()+30000;this.issue(b,purpose,(entry?'Giriş':'Kâr alma')+' emri reddedildi: '+e.message);}
      b.status=b.status==='stopping'?'stopping':'paused';
    }
    this.save();
  }
  async cancel(b,o){
    if(!active(o)||Date.now()-(o.cancelAt||0)<10000)return;
    o.cancelAt=Date.now();this.save();
    try{await this.okx.cancelOrder(b.instId,o.clOrdId);this.resolve(b,'cancel');}
    catch(e){this.issue(b,'cancel','Giriş iptali doğrulanamadı: '+e.message,30000);}
    // Cancel acknowledgement is NOT a terminal state.
  }
  async reconcile(b,o){
    const d=await this.okx.orderDetails(b.instId,o.clOrdId);
    if(!d)throw new Error('Emir bulunamadı: '+o.clOrdId);
    if(d.clOrdId!==o.clOrdId||(o.ordId&&d.ordId!==o.ordId)||d.instId!==b.instId)throw new Error('Emir kimliği uyuşmuyor.');
    if(!['live','partially_filled','filled','canceled','mmp_canceled'].includes(d.state))throw new Error('Bilinmeyen emir durumu.');
    const fill=dec(d.accFillSz),prev=dec(o.fill),sz=dec(o.sz);
    if(fill<prev||fill>sz||fill%dec(b.instrument.lotSz)||d.state==='filled'&&fill!==sz)throw new Error('Dolum miktarı tutarsız.');
    const l=b.levels[o.level],delta=fill-prev;
    const remaining=dec(l.remaining)+(o.purpose==='entry'?delta:-delta);
    if(remaining<0n)throw new Error('Çıkış dolumu kayıtlı pozisyonu aşıyor.');
    l.remaining=str(remaining);if(o.purpose==='entry'&&delta>0n)l.hadFill=true;
    o.fill=str(fill);o.ordId=d.ordId;o.state=d.state;o.uncertain=false;o.lastSeenAt=Date.now();o.avgPx=d.avgPx||'';
    if(TERMINAL.has(o.state))o.finishedAt=Date.now();
    if(delta>0n)this.event(b,'fill',o.purpose+' • seviye '+l.index+' • dolum '+str(delta)+' / '+o.sz);
    this.save();
    if(o.purpose==='entry'&&d.state==='partially_filled')await this.cancel(b,o);
  }
  async snapshot(b){
    const [positions,pending]=await Promise.all([this.okx.positions(b.instId),this.okx.pendingOrders(b.instId)]);
    const known=new Set(b.orders.map(o=>o.clOrdId));
    if(pending.some(o=>!known.has(o.clOrdId))){b.ownershipLost=true;throw new Error('Paritede bota ait olmayan emir var.');}
    const expected={long:0n,short:0n};for(const l of b.levels)expected[l.direction]+=dec(l.remaining);
    const actual={long:0n,short:0n};
    for(const p of positions){
      const q=dec(p.pos);if(q===0n)continue;
      if(p.mgnMode!=='cross'||Number(p.lever)!==10)throw new Error('Pozisyon marjin/kaldıraç ayarı değişmiş.');
      const direction=p.posSide==='net'?(q>0n?'long':'short'):p.posSide;
      if(!['long','short'].includes(direction))throw new Error('Pozisyon yönü geçersiz.');
      actual[direction]+=abs(q);
    }
    b.positions=positions;b.snapshotAt=Date.now();b.matched=actual.long===expected.long&&actual.short===expected.short;
    if(!b.matched)throw new Error('OKX pozisyonu ile kayıtlı dolumlar uyuşmuyor. Yeni emirler bekletiliyor.');
    b.mismatchSince=0;this.resolve(b,'position');
  }
  async verifySettings(b){
    const [account,leverage]=await Promise.all([this.okx.accountConfig(),this.okx.leverageInfo(b.instId)]);
    if(account.posMode!==b.posMode||!leverage.length||leverage.some(x=>Number(x.lever)!==10||x.mgnMode!=='cross'))throw new Error('OKX pozisyon modu / cross 10× ayarı değişmiş.');
    if(!b.settingsAt||Date.now()-b.settingsAt>60000){
      const [algos,native]=await Promise.all([this.okx.algoOrders(b.instId),this.okx.gridList()]);
      if(algos.length||native.some(x=>x.instId===b.instId)){b.ownershipLost=true;throw new Error('Paritede harici algo emir / grid botu bulundu.');}
      const i=(await this.okx.instruments()).find(x=>x.instId===b.instId);
      if(!i||['ctVal','lotSz','minSz','tickSz'].some(k=>dec(i[k])!==dec(b.instrument[k])))throw new Error('Sözleşme özellikleri değişmiş; grid planı yeniden değerlendirilmeli.');
      b.settingsAt=Date.now();
    }
  }
  async tickBot(b){
    let orderFailure=false;
    // Entries first: late entry fills and exit fills may appear in the same poll.
    for(const o of this.live(b).sort((a,z)=>(a.purpose==='entry'?0:1)-(z.purpose==='entry'?0:1))){
      try{await this.reconcile(b,o);}
      catch(e){orderFailure=true;o.uncertain=true;this.issue(b,'api','Emir sorgusu başarısız: '+e.message,30000);}
    }
    if(!orderFailure){this.resolve(b,'api');this.resolve(b,'unknown');}
    let matched=false;
    try{await this.snapshot(b);matched=true;}
    catch(e){b.matched=false;b.mismatchSince ||= Date.now();this.issue(b,'position',e.message,15000);if(b.ownershipLost||Date.now()-b.mismatchSince>15000){b.status=b.status==='stopping'?'stopping':'paused';}}
    // Entry cancellation does not depend on a working ticker or on another order query.
    if(b.status!=='running'||orderFailure||!matched||this.ledgerError){for(const o of this.live(b,undefined,'entry'))await this.cancel(b,o);}
    if(matched&&!b.ownershipLost){
      for(const l of b.levels){
        const orders=this.live(b,l);
        if(orders.some(o=>o.uncertain))continue;
        const reserved=orders.filter(o=>o.purpose==='exit').reduce((n,o)=>n+dec(o.sz)-dec(o.fill),0n);
        const uncovered=dec(l.remaining)-reserved;
        if(uncovered<0n){this.issue(b,'exit','Çıkış rezervi pozisyonu aşıyor.');b.status='paused';continue;}
        if(uncovered>0n){
          if(uncovered<dec(b.instrument.minSz)){this.issue(b,'dust','Kısmi dolum minimum emrin altında: '+str(uncovered)+' sözleşme. OKX üzerinden kontrol gerekli.');b.status='paused';}
          else{await this.place(b,l,'exit',str(uncovered));this.resolve(b,'dust');}
        }
        if(l.hadFill&&dec(l.remaining)===0n&&!this.live(b,l).length){l.cycle++;l.hadFill=false;}
      }
    }
    if(b.status==='stopping'&&!this.live(b).length&&b.levels.every(l=>dec(l.remaining)===0n)&&matched){b.status='stopped';b.stoppedAt=this.exchangeNow();this.event(b,'stopped','Bot kapandı; pozisyon ve emir kalmadı.');}
    if(b.status!=='running'||orderFailure||!matched||this.ledgerError){this.save();return;}
    await this.verifySettings(b);
    const ticker=await this.okx.ticker(b.instId);this.validateTicker(ticker);b.ticker=ticker;
    const pnl=this.pnl(b);
    if(b.maxLoss>0&&pnl.total!==null&&Number(pnl.total)<=-b.maxLoss){b.status='paused';this.issue(b,'risk','Zarar eşiği aşıldı; girişler durduruldu. Açık pozisyonlar piyasa emriyle kapatılmadı.');for(const o of this.live(b,undefined,'entry'))await this.cancel(b,o);this.save();return;}
    const occupied=b.levels.filter(l=>dec(l.remaining)>0n||this.live(b,l).some(o=>o.purpose==='exit')).length;
    const capacity=Math.max(0,b.maxLevels-occupied);
    const candidates=b.levels.filter(l=>dec(l.remaining)===0n&&!this.live(b,l,'exit').length&&Date.now()>=l.retryAt)
      .filter(l=>l.direction==='long'?Number(l.entryPx)<Number(ticker.bidPx):Number(l.entryPx)>Number(ticker.askPx))
      .sort((a,z)=>Math.abs(Number(a.entryPx)-Number(ticker.last))-Math.abs(Number(z.entryPx)-Number(ticker.last))).slice(0,capacity);
    const wanted=new Set(candidates.map(l=>l.index));
    for(const o of this.live(b,undefined,'entry'))if(!wanted.has(o.level))await this.cancel(b,o);
    // Count every reserved level, including entries waiting for cancel confirmation.
    for(const l of candidates){
      if(this.live(b,l).length)continue;
      const used=b.levels.filter(x=>dec(x.remaining)>0n||this.live(b,x).length).length;
      if(used>=b.maxLevels||b.status!=='running')break;
      await this.place(b,l,'entry',l.sz);
    }
    if(b.status==='running')b.error='';this.save();
  }
  async syncLedger(){
    const bots=this.store.data.bots;if(!bots.length)return;
    if(Date.now()-this.lastLedgerAttempt<30000)return;this.lastLedgerAttempt=Date.now();
    const earliest=Math.min(...bots.map(b=>b.createdAt));
    const begin=Math.max(earliest,(this.store.data.ledgerThrough||earliest)-86400000),end=this.exchangeNow();
    if(end-begin>89*86400000)throw new Error('89 günden uzun kayıt boşluğu: OKX arşiviyle manuel mutabakat gerekli.');
    const rows=await this.okx.bills(begin,end),byId=new Map(this.store.data.bills.map(r=>[r.billId,r]));
    for(const r of rows){if(!r.billId||!Number.isFinite(Number(r.ts)))throw new Error('Geçersiz hesap hareketi.');byId.set(r.billId,r);}
    this.store.data.bills=[...byId.values()];this.store.data.ledgerThrough=end;
    this.ledgerError='';this.alerts.resolve('ledger');
    for(const b of bots){
      const known=new Set(b.orders.filter(o=>o.ordId).map(o=>o.ordId));
      if(rows.some(r=>r.instId===b.instId&&Number(r.ts)>=b.createdAt&&(!b.stoppedAt||Number(r.ts)<=b.stoppedAt)&&String(r.type)==='2'&&!known.has(r.ordId))){
        // Uncertain orders may acquire their exchange ID on the next reconciliation.
        if(!this.live(b).some(o=>o.uncertain)){b.ownershipLost=true;if(b.status!=='stopped')b.status='paused';this.issue(b,'ownership','Bota ait olmayan işlem bulundu; PnL ayrımı ve pozisyon sahipliği bozuldu.');}
      }
    }
    this.save();
  }
  pnl(b){
    const byOrder=new Map(b.orders.filter(o=>o.ordId).map(o=>[o.ordId,o]));
    let gross=0n,fees=0n,funding=0n,other=0n;const grid=new Map(),issues=[];
    const volumes=new Map();
    try{
      for(const r of this.store.data.bills){
        if(r.instId!==b.instId)continue;
        const o=byOrder.get(r.ordId),isFunding=['173','174'].includes(String(r.subType));
        if(!o&&(Number(r.ts)<b.createdAt||b.stoppedAt&&Number(r.ts)>b.stoppedAt))continue;
        if(r.ccy!=='USDT'){issues.push('USDT dışı hareket');continue;}
        if(o){
          if(String(r.type)==='2'&&['pnl','fee','sz'].some(k=>r[k]===undefined||r[k]===null||r[k]===''))throw new Error('İşlem hareketinde PnL / ücret / miktar eksik.');
          const p=dec(r.pnl||'0'),f=dec(r.fee||'0');gross+=p;fees+=f;
          grid.set(o.level,(grid.get(o.level)||0n)+p+f);
          if(String(r.type)==='2')volumes.set(o.ordId,(volumes.get(o.ordId)||0n)+abs(dec(r.sz||'0')));
        }else if(isFunding)funding+=dec(r.pnl);
        else if(String(r.type)==='2'){issues.push('Bota ait olmayan işlem hareketi');}
        else if(dec(r.balChg||'0')!==0n){other+=dec(r.balChg);issues.push('Sınıflandırılmamış / tasfiye / düzeltme hareketi');}
      }
      for(const o of b.orders)if(dec(o.fill)>0n&&(volumes.get(o.ordId)||0n)!==dec(o.fill))issues.push('Dolumların muhasebe kaydı bekleniyor');
      if(this.ledgerError)issues.push(this.ledgerError);
      if(!this.store.data.ledgerThrough||this.exchangeNow()-this.store.data.ledgerThrough>90000)issues.push('Muhasebe verisi güncel değil');
      if(b.ownershipLost)issues.push('Parite başka işlemlerle karışmış');
      const realized=gross+fees+funding+other;
      const upl=b.status==='stopped'?0n:b.matched&&Date.now()-b.snapshotAt<15000?b.positions.reduce((n,p)=>n+(dec(p.pos)===0n?0n:dec(p.upl)),0n):null;
      return {gross:str(gross),fees:str(fees),funding:str(funding),other:str(other),realized:str(realized),unrealized:upl===null?null:str(upl),total:issues.length||upl===null?null:str(realized+upl),complete:issues.length===0,issues:[...new Set(issues)],asOf:this.store.data.ledgerThrough,grid:Object.fromEntries([...grid].map(([k,v])=>[k,str(v)]))};
    }catch(e){return {gross:null,fees:null,funding:null,other:null,realized:null,unrealized:null,total:null,complete:false,issues:['PnL doğrulanamadı: '+e.message],grid:{}};}
  }
  tick(){
    if(this.busy)return Promise.resolve();this.busy=true;
    return this.exclusive(async()=>{
      const start=Date.now();
      try{
        if(this.fatal)return;
        try{await this.okx.syncTime();this.alerts.resolve('connection');}catch(e){this.alerts.raise('connection','OKX saat / API bağlantısı başarısız.',30000);}
        for(const b of this.store.data.bots.filter(b=>b.status!=='stopped')){
          try{await this.tickBot(b);}
          catch(e){if(this.fatal)break;b.status=b.status==='stopping'?'stopping':'paused';this.issue(b,'engine','Grid yönetimi aksadı: '+e.message,30000);for(const o of this.live(b,undefined,'entry'))await this.cancel(b,o);this.save();}
        }
        try{await this.syncLedger();}catch(e){this.ledgerError=e.message;this.alerts.raise('ledger','PnL kayıtları alınamıyor: '+e.message,90000);}
        this.lastTick=Date.now();this.lastDuration=Date.now()-start;this.alerts.resolve('shutdown');this.save();
      }finally{this.busy=false;void this.alerts.flush();}
    });
  }
  summaries(){return this.store.data.bots.map(b=>({...b,orders:undefined,instrument:undefined,pnl:this.pnl(b),activeOrders:this.live(b),orderCount:b.orders.length,levels:b.levels.map(l=>({...l,phase:dec(l.remaining)>0n?'exiting':this.live(b,l).length?'entering':'idle'}))}));}
}
