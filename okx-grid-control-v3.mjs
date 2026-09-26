// Grid Control 3.0.0 — self-contained Node.js 22+ application.
// Generated from the reviewed sources bundled in source/. No external runtime dependencies.
import http from 'node:http';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// ===== decimal.js =====
// Decimal bookkeeping: 18 fractional digits, no floating point quantity arithmetic.
export const SCALE = 10n ** 18n;
export function dec(value) {
  const m = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!m) throw new Error('Geçersiz ondalık: ' + String(value));
  const exponent = Number(m[4] || 0);
  if (Math.abs(exponent) > 100) throw new Error('Ondalık üs sınır dışında.');
  const digits = m[2] + (m[3] || '');
  const shift = 18 + exponent - (m[3] || '').length;
  let n = BigInt(digits);
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (n % divisor) throw new Error('18 ondalık basamaktan fazlası desteklenmiyor.');
    n /= divisor;
  }
  return m[1] === '-' ? -n : n;
}
export function str(n) {
  const sign = n < 0n ? '-' : ''; n = n < 0n ? -n : n;
  const fraction = (n % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return sign + (n / SCALE) + (fraction ? '.' + fraction : '');
}
export const add = (a, b) => str(dec(a) + dec(b));
export const sub = (a, b) => str(dec(a) - dec(b));
export const sum = values => str(values.reduce((n, v) => n + dec(v), 0n));
export function floorStep(value, step) { const d = dec(step); if (d <= 0n) throw new Error('Adım pozitif olmalı.'); return str(dec(value) / d * d); }
export function quantityFor(notional, price, ctVal, step) {
  return str((dec(notional) * SCALE * SCALE / (dec(price) * dec(ctVal))) / dec(step) * dec(step));
}
export function positive(value, name) {
  if (dec(value) <= 0n || !Number.isFinite(Number(value))) throw new Error(name + ' pozitif olmalı.');
  return Number(value);
}


// ===== okx.js =====

const SITES = { global:'https://www.okx.com', eea:'https://eea.okx.com', us:'https://us.okx.com', tr:'https://tr.okx.com' };
export class OkxError extends Error {
  constructor(message, code = '', uncertain = false) { super(message); this.code = String(code); this.uncertain = uncertain; this.status = 502; }
}
export function createOkxClient(config, request = fetch) {
  if (!SITES[config.site || 'global']) throw new Error('OKX_SITE geçersiz.');
  const base = SITES[config.site || 'global'];
  const credentialsReady = !!(config.apiKey && config.secretKey && config.passphrase);
  let offset = 0, syncAt = 0;
  const lanes = new Map();
  async function throttle(endpoint) {
    const interval = endpoint.includes('bills') ? 450 : 120;
    const now = Date.now(), next = Math.max(now, lanes.get(endpoint) || 0);
    lanes.set(endpoint, next + interval);
    if (next > now) await new Promise(r => setTimeout(r, next - now));
  }
  async function call(method, endpoint, params, auth = false) {
    if (auth && !credentialsReady) throw new OkxError('OKX API bilgileri eksik.', 'CONFIG');
    await throttle(endpoint);
    const query = method === 'GET' && params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined)).toString() : '';
    const route = endpoint + query, body = method === 'POST' ? JSON.stringify(params || {}) : '';
    const headers = { Accept:'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (config.demo !== false) headers['x-simulated-trading'] = '1';
    if (auth) {
      const timestamp = new Date(Date.now() + offset).toISOString();
      Object.assign(headers, {'OK-ACCESS-KEY':config.apiKey,'OK-ACCESS-PASSPHRASE':config.passphrase,'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':createHmac('sha256',config.secretKey).update(timestamp+method+route+body).digest('base64')});
      if (endpoint === '/api/v5/trade/order' && method === 'POST') headers.expTime = String(Date.now()+offset+10000);
    }
    let response, result;
    try { response = await request(base+route,{method,headers,body:body||undefined,signal:AbortSignal.timeout(10000),redirect:'error'}); }
    catch { throw new OkxError('OKX bağlantısı tamamlanamadı.','NETWORK',method==='POST'); }
    try { result = await response.json(); }
    catch { throw new OkxError('OKX okunamayan yanıt verdi.','INVALID_RESPONSE',method==='POST'); }
    if(!result||!/^\d+$/.test(String(result.code)))throw new OkxError('OKX yanıt kodu eksik veya geçersiz.','INVALID_RESPONSE',method==='POST');
    const child = Array.isArray(result?.data) ? result.data.find(x => x.sCode && String(x.sCode)!=='0') : null;
    if (!response.ok || String(result?.code)!=='0' || child) {
      const code = String(child?.sCode || result?.code || response.status);
      const uncertain = method==='POST' && (response.status>=500 || ['50004','50001','50013','50026','50000','1','2'].includes(code));
      throw new OkxError('OKX ('+code+'): '+String(child?.sMsg||result?.msg||'İstek başarısız.').slice(0,300),code,uncertain);
    }
    if (!Array.isArray(result.data)) throw new OkxError('OKX veri biçimi geçersiz.','INVALID_RESPONSE',method==='POST');
    return result.data;
  }
  async function pages(endpoint, params, key, maxPages=100) {
    const all = new Map(); let after;
    for (let i=0;i<maxPages;i++) {
      const rows = await call('GET',endpoint,{...params,limit:'100',after},true);
      for (const row of rows) { if (!row[key]) throw new OkxError('Sayfalama kimliği eksik.','PAGINATION'); all.set(row[key],row); }
      if (rows.length<100) return [...all.values()];
      const next = rows.at(-1)[key];
      if (next===after) throw new OkxError('Sayfalama ilerlemedi.','PAGINATION');
      after=next;
    }
    throw new OkxError('Sayfalama sınırı aşıldı; veri eksik.','PAGINATION');
  }
  return {
    site:config.site||'global', demo:config.demo!==false, credentialsReady, call, now:()=>Math.round(Date.now()+offset),
    async syncTime() {
      if (Date.now()-syncAt<60000) return;
      const start=Date.now(), rows=await call('GET','/api/v5/public/time');
      const server=Number(rows[0]?.ts);
      if (!Number.isFinite(server)||server<1e12) throw new OkxError('Sunucu saati alınamadı.','CLOCK');
      offset=server-(start+Date.now())/2; syncAt=Date.now();
    },
    instruments:()=>call('GET','/api/v5/public/instruments',{instType:'SWAP'}).then(rows=>rows.filter(x=>x.state==='live'&&x.instId.endsWith('-USDT-SWAP')&&x.ctType==='linear')),
    ticker:instId=>call('GET','/api/v5/market/ticker',{instId}).then(x=>{if(!x[0])throw new OkxError('Fiyat yok.');return x[0];}),
    accountConfig:()=>call('GET','/api/v5/account/config',undefined,true).then(x=>x[0]||{}),
    balance:()=>call('GET','/api/v5/account/balance',{ccy:'USDT'},true).then(x=>x[0]||{}),
    positions:instId=>call('GET','/api/v5/account/positions',{instId},true),
    pendingOrders:instId=>pages('/api/v5/trade/orders-pending',{instId,instType:'SWAP'},'ordId'),
    algoOrders:async instId=>{const rows=[];for(const ordType of ['conditional','oco','trigger','move_order_stop','iceberg','twap'])rows.push(...await pages('/api/v5/trade/orders-algo-pending',{instId,ordType},'algoId'));return rows;},
    gridList:()=>pages('/api/v5/tradingBot/grid/orders-algo-pending',{algoOrdType:'contract_grid'},'algoId'),
    setLeverage:(instId,leverage,mgnMode='cross')=>call('POST','/api/v5/account/set-leverage',{instId,lever:String(leverage),mgnMode},true),
    leverageInfo:instId=>call('GET','/api/v5/account/leverage-info',{instId,mgnMode:'cross'},true),
    async placeOrder(body) {const rows=await call('POST','/api/v5/trade/order',body,true);if(!rows[0]?.ordId)throw new OkxError('Emir kimliği dönmedi; sonuç belirsiz.','INVALID_RESPONSE',true);return rows[0];},
    orderDetails:(instId,clOrdId)=>call('GET','/api/v5/trade/order',{instId,clOrdId},true).then(x=>x[0]||null),
    cancelOrder:(instId,clOrdId)=>call('POST','/api/v5/trade/cancel-order',{instId,clOrdId},true),
    bills:(begin,end)=>pages('/api/v5/account/bills-archive',{instType:'SWAP',begin:String(begin),end:String(end)},'billId')
  };
}


// ===== store.js =====


export class Store {
  constructor(dir,identity) {
    mkdirSync(dir,{recursive:true});this.file=path.join(dir,'grid-v3.json');this.lock=path.join(dir,'grid-v3.lock');
    try{this.fd=openSync(this.lock,'wx',0o600);}catch{throw new Error('DATA_DIR kilitli. Diğer süreci durdurun; çökmüş süreçten kalan grid-v3.lock dosyasını ancak tek süreç olduğundan emin olduktan sonra kaldırın.');}
    writeFileSync(this.fd,JSON.stringify({pid:process.pid,started:new Date().toISOString()}));fsyncSync(this.fd);
    try{
      if(!existsSync(this.file)&&existsSync(path.join(dir,'manual-grids.json')))throw new Error('v2 kayıtları bulundu. Önce v2 botlarını tamamen kapatın; v3 için yeni DATA_DIR kullanın. Aktif v2 kayıtları otomatik taşınmaz.');
      this.data=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{version:3,identity,bots:[],events:[],alerts:{},bills:[],ledgerThrough:0};
      if(this.data.version!==3||this.data.identity!==identity||!Array.isArray(this.data.bots)||!Array.isArray(this.data.bills))throw new Error('Kayıt sürümü / hesap / demo-canlı kimliği uyuşmuyor.');
    }catch(e){this.close();throw e;}
  }
  save(){
    const tmp=this.file+'.tmp';let fd;
    try{fd=openSync(tmp,'w',0o600);writeFileSync(fd,JSON.stringify(this.data));fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
    for(let attempt=0;;attempt++){
      try{renameSync(tmp,this.file);break;}
      catch(e){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25*(attempt+1));}
    }
    if(process.platform!=='win32'){const d=openSync(path.dirname(this.file),'r');try{fsyncSync(d);}finally{closeSync(d);}}
  }
  close(){if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}}
}


// ===== alerts.js =====
export class Alerts {
  constructor(store,config={},request=fetch,now=Date.now){
    this.store=store;this.config=config;this.request=request;this.now=now;this.enabled=!!(config.token&&config.chatId);this.busy=false;this.error='';this.retryAt=0;
    this.cooldown=Math.max(15,Number(config.cooldownMinutes)||60)*60000;
  }
  redact(text){let safe=String(text);for(const secret of this.config.secrets||[])if(secret)safe=safe.split(secret).join('[gizli]');return safe.slice(0,500);}
  raise(key,message,graceMs=0){
    const now=this.now(),old=this.store.data.alerts[key];
    if(!old||old.resolved)this.store.data.alerts[key]={key,message:this.redact(message),firstAt:now,lastAt:now,count:1,sentAt:old?.sentAt||0,eligibleAt:now+graceMs,resolved:false};
    else{old.lastAt=now;old.count++;old.message=this.redact(message);}
  }
  resolve(key){if(this.store.data.alerts[key])this.store.data.alerts[key].resolved=true;}
  async flush(){
    if(!this.enabled||this.busy||this.now()<this.retryAt)return;
    const now=this.now(),data=this.store.data;
    if(data.telegramLastAt&&now-data.telegramLastAt<300000)return;
    const alerts=Object.values(data.alerts).filter(x=>!x.resolved&&now>=x.eligibleAt&&(!x.sentAt||now-x.sentAt>=this.cooldown));
    if(!alerts.length)return;this.busy=true;
    try{
      const text=['GRID CONTROL • CİDDİ HATA',this.config.demo?'Ortam: DEMO':'Ortam: CANLI',...alerts.slice(0,6).map(x=>'• '+x.message+' (tekrar: '+x.count+')'),alerts.length>6?'Ek olaylar panelde: '+(alerts.length-6):'','OKX emirlerini ve paneldeki olay kaydını kontrol edin.',new Date(now).toISOString()].filter(Boolean).join('\n');
      const response=await this.request('https://api.telegram.org/bot'+this.config.token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:this.config.chatId,text,protect_content:true,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(8000),redirect:'error'});
      const result=await response.json();
      if(!response.ok||!result.ok){this.retryAt=now+Math.max(60,Number(result.parameters?.retry_after)||0)*1000;throw new Error('Telegram gönderimi başarısız.');}
      for(const a of alerts.slice(0,6))a.sentAt=now;data.telegramLastAt=now;this.error='';this.store.save();
    }catch{this.error='Telegram iletilemedi. Token / chat ID / ağ bağlantısını kontrol edin.';this.retryAt=Math.max(this.retryAt,now+60000);}
    finally{this.busy=false;}
  }
}


// ===== engine.js =====


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
    if(!this.okx.demo&&input.confirm!=='CANLI')throw new Error('Canlı başlatma için CANLI onayı gerekli.');
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


// ===== server.js =====









const root=path.dirname(fileURLToPath(import.meta.url));
// The distribution builder replaces this with embedded static assets.
const EMBEDDED_ASSETS={"index.html": "<!doctype html>\n<html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"dark\"><title>Grid Control — OKX</title><link rel=\"stylesheet\" href=\"/styles.css\"><script src=\"/app.js\" defer></script></head>\n<body>\n<div id=\"loginView\" class=\"login-wrap\"><form id=\"loginForm\" class=\"login-card\"><div class=\"brand-mark\">▦</div><p class=\"eyebrow\">OKX · OPERASYON PANELİ</p><h1>Grid Control<span class=\"mint\">.</span></h1><p class=\"muted\">Emirler, pozisyonlar ve net performans.<br>Tek bir çalışma alanında.</p><label>Panel şifresi<input id=\"password\" type=\"password\" autocomplete=\"current-password\" required placeholder=\"Şifrenizi girin\"></label><button class=\"primary\" type=\"submit\">Güvenli giriş <span>→</span></button><p id=\"loginError\" class=\"error\" role=\"alert\"></p><div class=\"login-note\">API anahtarları sunucuda tutulur.</div></form></div>\n<div id=\"workspace\" hidden>\n<aside class=\"sidebar\"><a class=\"brand\" href=\"/\">▦ <span>Grid Control<b>PRO / 03</b></span></a><div class=\"nav-label\">ÇALIŞMA ALANI</div><nav><a class=\"nav-item selected\" href=\"#overview\">◈ <span>Genel bakış</span></a><a class=\"nav-item\" href=\"#strategies\">▤ <span>Grid stratejileri</span></a><a class=\"nav-item\" href=\"#activity\">≋ <span>Olay kaydı</span></a><a class=\"nav-item\" href=\"/api/export\" download>↓ <span>Kayıtları dışa aktar</span></a></nav><div class=\"sidebar-bottom\"><div class=\"integration\"><span class=\"dot\"></span><div>OKX API <small id=\"siteLabel\">REST v5</small></div></div><p>Cross marjin · 10×<br>USDT sürekli vadeli</p><button id=\"logout\" class=\"ghost full\">Oturumu kapat ↗</button></div></aside>\n<main><header class=\"topbar\"><div><span class=\"muted\">Çalışma alanı</span><span class=\"slash\">/</span><span>Genel bakış</span></div><div class=\"top-status\"><span id=\"modeBadge\" class=\"badge\">DEMO</span><span id=\"syncStatus\" class=\"muted\">Bağlanıyor…</span><button id=\"refresh\" class=\"icon-button\" aria-label=\"Verileri yenile\">↻</button></div></header>\n<div class=\"content\" id=\"overview\"><section class=\"page-heading\"><div><p class=\"eyebrow\">KONTROL SENDE</p><h1>Grid çalışma alanı</h1><p class=\"muted\">Her dolumu izle. Gerçek net sonucu gör.</p></div><button id=\"newBot\" class=\"primary\">＋ Yeni grid oluştur</button></section>\n<div id=\"globalWarning\" class=\"notice\" hidden></div>\n<section class=\"metrics\" aria-label=\"Performans özeti\"><article class=\"metric featured\"><span>Toplam net PnL <small>USDT</small></span><strong id=\"totalPnl\">—</strong><p id=\"totalHint\">Gerçekleşmiş + gerçekleşmemiş</p></article><article class=\"metric\"><span>Gerçekleşmiş PnL</span><strong id=\"realizedPnl\">—</strong><p>Komisyon ve funding dahil</p></article><article class=\"metric\"><span>Gerçekleşmemiş PnL</span><strong id=\"unrealizedPnl\">—</strong><p>OKX pozisyon verisi · mark fiyat</p></article><article class=\"metric\"><span>Aktif emir / tamamlanan döngü</span><strong id=\"activityMetric\">0 <i>/</i> 0</strong><p id=\"botCount\">Henüz strateji yok</p></article></section>\n<section class=\"work-grid\" id=\"strategies\"><div class=\"panel strategies-panel\"><div class=\"panel-heading\"><div><h2>Grid stratejileri <span id=\"strategyCount\" class=\"count\">0</span></h2><p class=\"muted\">Parite başına tek bot, en fazla beş açık seviye.</p></div><span class=\"live-label\"><span class=\"dot\"></span> API verisi</span></div><div id=\"botList\"></div></div><aside class=\"panel health-panel\"><div class=\"panel-heading\"><h2>Sistem durumu</h2><span id=\"healthDot\" class=\"dot\"></span></div><div id=\"healthRows\" class=\"health-rows\"></div><div class=\"telegram-box\"><span class=\"telegram-icon\">↗</span><h3>Az bildirim. Önemli olaylar.</h3><p id=\"telegramInfo\">Telegram yalnızca ciddi hatalarda bildirim gönderir.</p><span class=\"tag\">CİDDİ HATA FİLTRESİ</span></div><p class=\"micro\">Sunucu çevrimdışıyken bu uygulama Telegram mesajı gönderemez. Açık OKX emirleri borsada kalır.</p></aside></section>\n<section id=\"detailPanel\" class=\"panel detail-panel\" hidden><div class=\"panel-heading\"><div><p class=\"eyebrow\">STRATEJİ DETAYI</p><h2 id=\"detailTitle\"></h2></div><button id=\"closeDetail\" class=\"ghost\">Kapat ×</button></div><div id=\"detailBody\"></div></section>\n<section id=\"activity\" class=\"panel activity-panel\"><div class=\"panel-heading\"><div><h2>Olay kaydı</h2><p class=\"muted\">Dolumlar, emirler ve müdahale gerektiren durumlar.</p></div><select id=\"eventFilter\" aria-label=\"Olay filtresi\"><option value=\"all\">Tüm olaylar</option><option value=\"critical\">Ciddi hatalar</option><option value=\"fill\">Dolumlar</option></select></div><div class=\"table-scroll\"><table><thead><tr><th>Zaman</th><th>Parite</th><th>Olay</th><th>Açıklama</th></tr></thead><tbody id=\"eventRows\"></tbody></table></div></section>\n<footer><span>GRID CONTROL / 03</span><span>Net PnL, kapanışta henüz oluşmamış komisyonu içermez.</span><span id=\"lastUpdate\">—</span></footer></div></main></div>\n<dialog id=\"createDialog\"><form id=\"createForm\"><div class=\"dialog-heading\"><div><p class=\"eyebrow\">YENİ STRATEJİ</p><h2>Gridini yapılandır</h2></div><button type=\"button\" id=\"closeCreate\" class=\"ghost\" aria-label=\"Kapat\">×</button></div><p class=\"muted\">Geometrik seviyeler. Post-only giriş, limit kâr alma.</p><div class=\"form-grid\"><label class=\"span2\">Parite<select name=\"instId\" id=\"instrument\" required><option value=\"\">Pariteler yükleniyor…</option></select></label><label>Yön<select name=\"direction\"><option value=\"long\">Long</option><option value=\"short\">Short</option><option value=\"neutral\">Nötr · hedge gerekli</option></select></label><label>İşlem başı USDT<input name=\"amountPerTrade\" type=\"number\" step=\"any\" min=\"0.01\" value=\"20\" required></label><label>Alt fiyat<input name=\"minPx\" type=\"number\" min=\"0\" step=\"any\" placeholder=\"Alt sınır\" required></label><label>Üst fiyat<input name=\"maxPx\" type=\"number\" min=\"0\" step=\"any\" placeholder=\"Üst sınır\" required></label><label>Hedef grid aralığı (%)<input name=\"targetPct\" type=\"number\" min=\"0.1\" max=\"25\" step=\"0.01\" value=\"1\" required></label><label>Açık seviye sınırı<select name=\"maxLevels\"><option>1</option><option>2</option><option>3</option><option>4</option><option selected>5</option></select></label><label class=\"span2\">Zararda girişleri durdur (USDT · 0 = kapalı)<input name=\"maxLoss\" type=\"number\" min=\"0\" step=\"any\" value=\"0\"><small>Stop-loss değildir. Mevcut pozisyonlar kâr alma emirleriyle açık kalır.</small></label></div><div class=\"notice compact\">Cross 10×, hesabın paylaşılan teminatını kullanır. İşlem başı USDT emir değeridir; kaldıraçla tekrar çarpılmaz.</div><div id=\"previewResult\" hidden></div><label id=\"liveConfirm\" hidden>Canlı emir göndermek için CANLI yazın<input name=\"confirm\" autocomplete=\"off\" placeholder=\"CANLI\"></label><p id=\"createError\" class=\"error\" role=\"alert\"></p><div class=\"dialog-actions\"><button type=\"button\" id=\"previewButton\" class=\"secondary\">Planı hesapla</button><button type=\"submit\" id=\"startButton\" class=\"primary\" disabled>Gridi başlat →</button></div></form></dialog>\n<div id=\"toast\" role=\"status\" hidden></div>\n</body></html>\n", "styles.css": ":root{--bg:#0c1015;--panel:#131920;--line:#26303b;--text:#e9eff5;--muted:#8998a8;--green:#6ae1b2;--red:#fa8a91;--amber:#e5bd76;--font:Inter,Segoe UI,Arial,sans-serif}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button{cursor:pointer;border:0}button:disabled{cursor:wait;opacity:.45}a{color:inherit;text-decoration:none}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--green);outline-offset:3px}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1{font-size:32px;letter-spacing:-1px;font-weight:620;line-height:1.25}h2{font-size:17px;letter-spacing:-.3px;font-weight:600}h3{font-size:14px;font-weight:600}.muted{color:var(--muted);font-size:13px}.mint,.positive{color:var(--green)!important}.negative,.error{color:var(--red)!important}.eyebrow{font-size:10px;letter-spacing:2px;font-weight:650;color:var(--muted);margin-bottom:10px}.primary,.secondary,.ghost{display:inline-flex;align-items:center;justify-content:center;gap:16px;padding:11px 17px;border-radius:7px;font-size:12px;font-weight:650;white-space:nowrap}.primary{background:var(--green);color:#072019;box-shadow:0 2px 0 #377e6444}.primary:hover{background:#8eefc7}.secondary{background:#293540;color:var(--text);border:1px solid #415262}.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}.ghost:hover{color:var(--text);background:#1c2630}.full{width:100%}.icon-button{width:30px;height:30px;border-radius:6px;background:var(--panel);color:var(--muted);font-size:20px;border:1px solid var(--line)}.sidebar{position:fixed;width:224px;inset:0 auto 0 0;background:#10161d;border-right:1px solid var(--line);padding:31px 21px;display:flex;flex-direction:column;z-index:5}.brand{display:flex;align-items:center;gap:12px;font-size:29px;color:var(--green);margin-bottom:50px}.brand span{font-size:16px;letter-spacing:-.5px;color:var(--text);font-weight:600}.brand b{display:block;color:var(--muted);font-size:9px;letter-spacing:2.6px;font-weight:500;margin-top:3px}.nav-label{font-size:9px;color:#657486;letter-spacing:1.5px;margin:0 12px 16px}.nav-item{display:flex;align-items:center;gap:12px;border-radius:7px;padding:12px;margin-bottom:6px;color:#8fa0b2;font-size:16px}.nav-item span{font-size:12px}.nav-item.selected{background:#1d302d;color:var(--green)}.nav-item:hover{background:#1b242d}.sidebar-bottom{margin-top:auto}.integration{display:flex;align-items:center;gap:12px;padding:15px 5px;border-top:1px solid var(--line);font-size:12px}.integration small{display:block;color:var(--muted);font-size:10px}.sidebar-bottom p{color:#728396;font-size:11px;line-height:1.8;padding:0 5px 21px}.dot{display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;box-shadow:0 0 0 4px #6ae1b20c;flex-shrink:0}.dot.warning{background:var(--amber)}main{margin-left:224px}.topbar{height:77px;border-bottom:1px solid var(--line);padding:0 36px;display:flex;align-items:center;justify-content:space-between;font-size:12px}.slash{margin:0 14px;color:#445463}.top-status{display:flex;align-items:center;gap:15px}.badge,.tag{display:inline-flex;align-items:center;padding:4px 8px;font-size:9px;font-weight:650;letter-spacing:1px;border:1px solid #3f534c;border-radius:5px;color:var(--green);background:#182a24}.badge.live{background:#342623;border-color:#7e5542;color:var(--amber)}.content{max-width:1600px;padding:37px 36px 20px;margin:auto}.page-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}.page-heading .muted{margin-top:9px}.metrics{display:grid;grid-template-columns:1.15fr 1fr 1fr 1fr;gap:14px;margin-bottom:27px}.metric{min-height:148px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:20px}.metric.featured{background:linear-gradient(115deg,#17302b,#15201e);border-color:#31574b}.metric>span{font-size:11px;color:#a2b1bf;display:flex;align-items:center;justify-content:space-between;gap:4px}.metric small{font-size:9px;color:#7e9f93;border:1px solid #355047;padding:2px 5px;border-radius:3px}.metric strong{font-size:29px;font-weight:550;letter-spacing:-1.1px;display:block;margin-top:14px;font-variant-numeric:tabular-nums;line-height:1.2}.metric p{font-size:10px;color:#81938f;margin-top:10px}.metric i{font-size:20px;font-style:normal;color:#475566;margin:0 9px}.work-grid{display:grid;grid-template-columns:minmax(0,1fr) 278px;gap:22px;margin-bottom:24px}.panel{border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}.panel-heading{padding:23px 23px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-heading p.muted{font-size:11px;margin-top:6px}.count{display:inline-block;font-size:10px;color:#a4b3c2;background:#26313d;border-radius:4px;padding:2px 6px;margin-left:7px;vertical-align:middle}.live-label{font-size:10px;color:var(--muted);white-space:nowrap;display:flex;align-items:center;gap:7px}.empty{padding:50px 25px 58px;text-align:center}.empty .empty-icon{font-size:39px;color:#3c5e56;margin-bottom:14px}.empty h3{font-size:17px;margin-bottom:9px}.empty p{color:var(--muted);font-size:12px;max-width:340px;margin:0 auto 22px}.bot-card{padding:20px 23px;border-top:1px solid var(--line)}.bot-top{display:flex;justify-content:space-between;gap:10px}.symbol-wrap{display:flex;gap:12px;align-items:center}.symbol-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:9px;background:#283a34;border:1px solid #425b4e;font-weight:700;color:var(--green);font-size:14px}.symbol{font-size:15px;font-weight:600}.symbol-wrap p{font-size:10px;color:var(--muted);margin-top:2px}.state-pill{font-size:9px;padding:4px 7px;border-radius:4px;color:var(--green);background:#22372e;align-self:flex-start;letter-spacing:.3px}.state-pill.paused,.state-pill.stopping{color:var(--amber);background:#372e23}.state-pill.stopped{color:var(--muted);background:#26303b}.bot-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:20px}.stat-label{font-size:10px;color:var(--muted);display:block;margin-bottom:4px}.stat-value{font-size:16px;font-variant-numeric:tabular-nums}.bot-sub{font-size:10px;color:#758698;margin-top:16px;display:flex;justify-content:space-between;gap:10px}.bot-actions{display:flex;align-items:center;gap:7px;margin-top:17px}.bot-actions button{font-size:10px;padding:7px 10px}.bot-actions .detail-button{margin-left:auto;color:var(--green);border-color:#365346}.bot-error{margin-top:12px;font-size:11px;color:var(--amber);background:#362e233d;border-left:2px solid #987949;padding:8px 10px;overflow-wrap:anywhere}.health-panel .panel-heading{padding-bottom:12px}.health-rows{padding:0 22px}.health-row{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #222d37;font-size:10px;color:var(--muted)}.health-row b{font-weight:500;color:#c1d0db}.telegram-box{margin:20px 20px 14px;background:#17232d;border:1px solid #2c4051;border-radius:8px;padding:16px}.telegram-icon{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:7px;background:#263f50;color:#9fcee9;font-size:20px;margin-bottom:12px}.telegram-box h3{font-size:12px;line-height:1.6}.telegram-box p{font-size:10px;line-height:1.8;color:#8da7b8;margin:7px 0 14px}.telegram-box .tag{font-size:7px;border-color:#354c5e;background:transparent;color:#9fc0d7;letter-spacing:1px}.micro{font-size:9px;line-height:1.8;color:#718294;padding:0 22px 20px}.notice{padding:14px 18px;border:1px solid #6f5934;background:#292319;color:#e9c686;border-radius:7px;font-size:12px;margin-bottom:22px;white-space:pre-line}.notice.compact{font-size:11px;line-height:1.8;padding:12px;margin-top:18px;margin-bottom:15px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th{font-size:9px;letter-spacing:.6px;color:#77899d;font-weight:500;padding:12px 23px;background:#11171e;border-block:1px solid var(--line)}td{font-size:11px;padding:13px 23px;border-bottom:1px solid #222b36;color:#aabbca}td:last-child{white-space:normal;min-width:230px}.activity-panel tbody tr:last-child td{border:0}.activity-panel select{width:auto;font-size:10px;padding:8px 12px}.event-label{font-size:9px;padding:3px 6px;background:#23323a;color:#9bbfce;border-radius:4px}.event-label.critical{background:#3e282b;color:#efa2a6}.activity-panel{margin-top:24px}footer{display:flex;align-items:center;justify-content:space-between;gap:15px;padding-top:23px;font-size:9px;color:#526375}footer span:first-child{letter-spacing:2px}.detail-panel{margin-top:24px}.pnl-breakdown{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border-block:1px solid var(--line)}.pnl-breakdown>div{background:#131c23;padding:18px 23px}.detail-info{padding:14px 23px;font-size:11px;color:var(--muted)}.detail-panel h3{padding:15px 23px}.level-status{font-size:9px}.chart{padding:5px 23px 20px}.chart svg{width:100%;height:150px;display:block}.chart text{fill:#8c9fab;font-size:10px;font-family:var(--font)}.chart .grid-line{stroke:#26343f;stroke-width:1}.chart .price-line{stroke:#6ae1b2;stroke-width:2}.chart .level-line{stroke:#548474;stroke-width:1.5}.chart .market-label{fill:#6ae1b2}.error{font-size:12px;margin-top:12px;min-height:0;overflow-wrap:anywhere}input,select{display:block;background:#0e161d;border:1px solid #35404c;border-radius:6px;padding:11px 12px;color:var(--text);width:100%;min-height:42px;margin-top:7px}input::placeholder{color:#576877}label{font-size:11px;color:#a3b3c2;display:block}label small{display:block;color:#708799;font-size:10px;margin-top:7px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:17px;margin-top:24px}.span2{grid-column:span 2}dialog{background:#151d25;border:1px solid #3d4b58;color:var(--text);border-radius:14px;width:550px;max-width:calc(100% - 24px);padding:27px;box-shadow:0 25px 100px #000a;max-height:92vh}dialog::backdrop{background:#0009;backdrop-filter:blur(4px)}.dialog-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.dialog-heading h2{font-size:23px}.dialog-heading .ghost{padding:2px 9px;font-size:24px}.dialog-actions{display:flex;justify-content:space-between;gap:12px;margin-top:22px}.preview-summary{background:#182b24;border:1px solid #385a49;border-radius:7px;padding:13px;margin-bottom:16px;font-size:11px;color:#b0d9c8;line-height:1.9}#toast{position:fixed;bottom:25px;right:25px;max-width:420px;background:#213b31;border:1px solid #55796a;color:#d5eddf;padding:14px 20px;border-radius:8px;z-index:20;box-shadow:0 10px 30px #0005;font-size:12px}.login-wrap{min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 0%,#18352d 0%,#0c1015 60%)}.login-card{width:390px;max-width:calc(100vw - 40px);padding:36px;border:1px solid #31433b;border-radius:14px;background:#121b1c;box-shadow:0 30px 100px #0005}.brand-mark{font-size:43px;color:var(--green);line-height:1;margin-bottom:25px}.login-card h1{font-size:33px}.login-card .muted{margin:15px 0 27px;line-height:1.9}.login-card .primary{width:100%;justify-content:space-between;margin-top:20px}.login-note{border-top:1px solid #293b33;padding-top:20px;margin-top:25px;color:#6d8b7f;font-size:10px;text-align:center}\n@media(min-width:1550px){.metrics{gap:20px}.metric{padding:24px}.work-grid{grid-template-columns:minmax(0,1fr) 310px}.bot-stats{grid-template-columns:repeat(3,1fr)}.bot-card{padding:24px}}\n@media(max-width:1150px){.sidebar{width:190px;padding-inline:15px}main{margin-left:190px}.content{padding:28px 24px}.topbar{padding:0 24px}.metrics{grid-template-columns:1fr 1fr}.work-grid{grid-template-columns:minmax(0,1fr) 245px}.live-label{display:none}.metric{min-height:135px}}\n@media(max-width:850px){.sidebar{width:66px;padding:24px 8px}.brand{justify-content:center;margin-bottom:30px}.brand span,.nav-label,.nav-item span,.sidebar-bottom{display:none}.nav-item{justify-content:center;padding:12px 0}.sidebar nav .nav-item{font-size:22px}main{margin-left:66px}.work-grid{grid-template-columns:1fr}.health-panel{display:none}.page-heading h1{font-size:27px}.top-status .muted{display:none}.pnl-breakdown{grid-template-columns:repeat(2,1fr)}footer span:nth-child(2){display:none}}\n@media(max-width:540px){.content{padding:24px 15px}.topbar{padding:0 15px;height:62px}.topbar .muted,.slash{display:none}.page-heading{display:block}.page-heading .primary{margin-top:18px}.page-heading h1{font-size:25px}.metrics{gap:9px}.metric{padding:14px;min-height:125px}.metric strong{font-size:23px}.metric>span{font-size:9px}.metric p{font-size:9px}.metric small{display:none}.panel-heading{padding:18px 15px}.panel-heading p.muted{font-size:10px}.bot-card{padding:18px 15px}.bot-stats{gap:9px}.stat-value{font-size:14px}.stat-label{font-size:9px}.bot-actions{flex-wrap:wrap}.bot-sub{font-size:9px}.bot-actions button{padding:7px 8px}.form-grid{gap:12px}dialog{padding:21px}th,td{padding:11px 15px}.pnl-breakdown>div{padding:15px}.bot-top{gap:5px}.symbol{font-size:13px}.symbol-icon{width:29px;height:29px}.state-pill{font-size:8px}#toast{left:15px;right:15px;bottom:15px}}\n", "app.js": "'use strict';\nconst $=id=>document.getElementById(id);\nconst esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nconst n=(v,d)=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':Number(v)!==0&&Math.abs(Number(v))<1e-8&&d===undefined?String(v).replace('.',','):Number(v).toLocaleString('tr-TR',{minimumFractionDigits:d??2,maximumFractionDigits:d??8});\nconst money=v=>v===null||v===undefined?'—':(Number(v)>0?'+':'')+n(v);\nconst cls=v=>Number(v)>0?'positive':Number(v)<0?'negative':'';\nconst date=t=>t?new Date(t).toLocaleString('tr-TR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';\nconst states={running:'ÇALIŞIYOR',paused:'DURAKLATILDI',stopping:'ÇIKIŞ BEKLİYOR',stopped:'TAMAMLANDI'};\nconst direction={long:'Long',short:'Short',neutral:'Nötr'};\nlet config={},state=null,selected='',refreshing=false,previewSignature='',pending=false;\nasync function api(url,method='GET',body){\n  const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(method==='POST'?{'X-CSRF-Token':config.csrf||''}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});\n  const result=await response.json();\n  if(!response.ok){if(response.status===401&&url!=='/api/login')showLogin();throw new Error(result.error||'İstek başarısız.');}return result;\n}\nfunction toast(message){$('toast').textContent=message;$('toast').hidden=false;setTimeout(()=>$('toast').hidden=true,6000);}\nfunction showLogin(){$('workspace').hidden=true;$('loginView').hidden=false;}\nasync function boot(){\n  try{config=await api('/api/bootstrap');if(!config.loggedIn){showLogin();return;}\n    $('loginView').hidden=true;$('workspace').hidden=false;$('modeBadge').textContent=config.demo?'DEMO':'CANLI';$('modeBadge').className='badge'+(config.demo?'':' live');$('siteLabel').textContent=config.site.toUpperCase()+' · REST v5';$('liveConfirm').hidden=config.demo;await refresh();\n  }catch(e){$('loginError').textContent=e.message;}\n}\nfunction metric(id,value){$(id).textContent=money(value);$(id).className=cls(value);}\nfunction render(){\n  const bots=state.bots,complete=bots.every(b=>b.pnl.complete),hasUpl=bots.every(b=>b.pnl.unrealized!==null);\n  const aggregate=key=>bots.reduce((s,b)=>s+Number(b.pnl[key]||0),0);\n  metric('totalPnl',bots.every(b=>b.pnl.total!==null)?aggregate('total'):null);metric('realizedPnl',complete?aggregate('realized'):null);metric('unrealizedPnl',hasUpl?aggregate('unrealized'):null);\n  $('totalHint').textContent=complete?'Gerçekleşmiş + gerçekleşmemiş':'Muhasebe verisi eksik · detayları kontrol edin';\n  $('activityMetric').innerHTML=bots.reduce((s,b)=>s+b.activeOrders.length,0)+' <i>/</i> '+bots.reduce((s,b)=>s+b.levels.reduce((a,l)=>a+l.cycle,0),0);\n  $('botCount').textContent=bots.filter(b=>b.status==='running').length+' çalışan · '+bots.filter(b=>['paused','stopping'].includes(b.status)).length+' bekleyen strateji';$('strategyCount').textContent=bots.length;\n  const warnings=[!config.storageReady?'Kalıcı DATA_DIR tanımlı değil. Yeni bot başlatılamaz.':'',!config.configured?'OKX API veya panel yapılandırması eksik.':'',state.health.fatal,state.health.ledgerError,bots.some(b=>b.ownershipLost)?'Pozisyon sahipliği uyuşmazlığı var. OKX üzerinden inceleme gerekiyor.':''].filter(Boolean);\n  $('globalWarning').hidden=!warnings.length;$('globalWarning').textContent=warnings.join('\\n');\n  $('botList').innerHTML=bots.length?bots.slice().reverse().map(b=>{\n    const p=b.pnl,filled=b.levels.filter(l=>Number(l.remaining)>0).length;\n    return '<article class=\"bot-card\"><div class=\"bot-top\"><div class=\"symbol-wrap\"><div class=\"symbol-icon\">'+esc(b.instId.slice(0,1))+'</div><div><div class=\"symbol\">'+esc(b.instId.replace('-SWAP',''))+'</div><p>'+esc(direction[b.direction])+' · Cross 10× · '+b.gridNum+' grid</p></div></div><span class=\"state-pill '+esc(b.status)+'\">'+esc(states[b.status]||b.status)+'</span></div><div class=\"bot-stats\"><div><span class=\"stat-label\">Net PnL · USDT</span><span class=\"stat-value '+cls(p.total)+'\">'+money(p.total)+'</span></div><div><span class=\"stat-label\">Komisyon / iade</span><span class=\"stat-value '+cls(p.fees)+'\">'+money(p.fees)+'</span></div><div><span class=\"stat-label\">Funding · USDT</span><span class=\"stat-value '+cls(p.funding)+'\">'+money(p.funding)+'</span></div></div><div class=\"bot-sub\"><span>'+n(b.minPx)+' — '+n(b.maxPx)+'</span><span>'+filled+'/'+b.maxLevels+' açık seviye · '+b.activeOrders.length+' emir</span></div>'+(!p.complete?'<p class=\"bot-error\">PnL kısmi: '+esc(p.issues.join(' · '))+'</p>':'')+(b.error?'<p class=\"bot-error\">'+esc(b.error)+'</p>':'')+'<div class=\"bot-actions\">'+(b.status==='running'?'<button class=\"ghost\" data-action=\"pause\" data-id=\"'+b.id+'\">Ⅱ Duraklat</button>':b.status==='paused'?'<button class=\"ghost\" data-action=\"resume\" data-id=\"'+b.id+'\">▷ Devam et</button>':'')+(b.status!=='stopped'&&b.status!=='stopping'?'<button class=\"ghost\" data-action=\"stop\" data-id=\"'+b.id+'\">Girişleri bitir</button>':'')+'<button class=\"ghost detail-button\" data-action=\"detail\" data-id=\"'+b.id+'\">Detaylar ↗</button></div></article>';\n  }).join(''):'<div class=\"empty\"><div class=\"empty-icon\">▦</div><h3>İlk gridin için hazır</h3><p>Bir fiyat aralığı belirle. Emir dolumları ve gerçek net performans burada görünür.</p><button class=\"primary\" data-action=\"create\">＋ Grid oluştur</button></div>';\n  const fresh=state.health.lastTick&&Date.now()-state.health.lastTick<60000;\n  $('syncStatus').textContent=fresh?'Senkronize':'Senkronizasyon bekleniyor';$('healthDot').className='dot'+(fresh&&!state.health.fatal?'':' warning');\n  const tg=state.health.telegram;\n  $('healthRows').innerHTML=[['Emir döngüsü',fresh?'Güncel':'Bekliyor'],['Son döngü süresi',n(state.health.duration/1000,1)+' sn'],['Muhasebe',state.health.ledgerError?'Veri eksik':date(state.health.ledgerThrough)],['Telegram',tg.error?'İletim hatası':tg.enabled?'Bağlantı ayarlı':'Ayarlanmadı'],['Kalıcı kayıt',state.health.fatal?'Yazma hatası':config.storageReady?'Yol tanımlı':'Eksik']].map(([k,v])=>'<div class=\"health-row\"><span>'+k+'</span><b>'+esc(v)+'</b></div>').join('');\n  $('telegramInfo').textContent=tg.error||(!tg.enabled?'TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID değişkenlerini ekleyin.':'Aynı hata en fazla saatlik; mesajlar en az 5 dakika arayla birleştirilir.');\n  $('lastUpdate').textContent='Panel: '+new Date().toLocaleTimeString('tr-TR');renderEvents();if(selected)renderDetail();\n}\nfunction renderEvents(){\n  if(!state)return;const filter=$('eventFilter').value,rows=state.events.filter(e=>filter==='all'||e.severity===filter||e.code===filter);\n  $('eventRows').innerHTML=rows.length?rows.slice(0,60).map(e=>'<tr><td>'+date(e.at)+'</td><td>'+esc(e.instId.replace('-SWAP','')||'Sistem')+'</td><td><span class=\"event-label '+esc(e.severity)+'\">'+esc(({fill:'DOLUM',order:'EMİR',created:'BAŞLATMA',pause:'DURAKLATMA',stop:'BİTİRME',stopped:'TAMAMLANDI',resume:'DEVAM'})[e.code]||e.code.toUpperCase())+'</span></td><td>'+esc(e.message)+'</td></tr>').join(''):'<tr><td colspan=\"4\">Henüz bu filtreye uygun kayıt yok.</td></tr>';\n}\nfunction renderDetail(){\n  const b=state.bots.find(b=>b.id===selected);if(!b)return;const p=b.pnl;\n  $('detailPanel').hidden=false;$('detailTitle').textContent=b.instId+' · '+direction[b.direction];\n  const lo=Number(b.minPx),hi=Number(b.maxPx),price=Number(b.ticker?.last),x=value=>35+Math.max(0,Math.min(1,(value-lo)/(hi-lo)))*630;\n  const chart='<div class=\"chart\"><svg viewBox=\"0 0 700 150\" role=\"img\" aria-label=\"Grid seviyeleri ve son piyasa fiyatı\"><line class=\"grid-line\" x1=\"35\" y1=\"75\" x2=\"665\" y2=\"75\"/>'+b.levels.map(l=>'<line class=\"level-line\" x1=\"'+x(Number(l.entryPx))+'\" y1=\"'+(l.phase==='idle'?65:45)+'\" x2=\"'+x(Number(l.entryPx))+'\" y2=\"85\"/>').join('')+(Number.isFinite(price)?'<line class=\"price-line\" x1=\"'+x(price)+'\" y1=\"27\" x2=\"'+x(price)+'\" y2=\"110\"/><text class=\"market-label\" text-anchor=\"middle\" x=\"'+x(price)+'\" y=\"19\">Son: '+n(price)+'</text>':'')+'<text x=\"35\" y=\"132\">'+n(lo)+'</text><text x=\"665\" y=\"132\" text-anchor=\"end\">'+n(hi)+'</text></svg></div>';\n  $('detailBody').innerHTML='<div class=\"pnl-breakdown\">'+[['Brüt gerçekleşmiş',p.gross],['Komisyon / iade',p.fees],['Funding',p.funding],['Diğer hareketler',p.other],['Net gerçekleşmiş',p.realized],['Gerçekleşmemiş',p.unrealized],['Toplam net',p.total],['Tamamlanan döngü',b.levels.reduce((s,l)=>s+l.cycle,0)]].map(([k,v])=>'<div><span class=\"stat-label\">'+k+'</span><span class=\"stat-value '+cls(v)+'\">'+money(v)+'</span></div>').join('')+'</div><p class=\"detail-info\">'+(p.complete?'Muhasebe kayıtları dolumlarla eşleşiyor.':'KISMİ VERİ: '+esc(p.issues.join(' · ')))+' · Son muhasebe: '+date(p.asOf)+'<br>Gerçekleşmemiş PnL OKX mark fiyatına dayanır. Funding bot toplamındadır. Seviye PnL’si, ilgili emirlere yazılan OKX kâr/zararı ve komisyonudur; OKX birleşik pozisyon maliyetini kullandığından bağımsız grid çifti kârından farklı olabilir.</p>'+chart+'<h3>Açık emirler</h3><div class=\"table-scroll\"><table><thead><tr><th>Seviye</th><th>İşlem</th><th>Dolum / miktar</th><th>Durum / emir kimliği</th></tr></thead><tbody>'+ (b.activeOrders.length?b.activeOrders.map(o=>'<tr><td>#'+(o.level+1)+'</td><td>'+(o.purpose==='entry'?'Giriş':'Kâr alma')+'</td><td>'+esc(o.fill)+' / '+esc(o.sz)+'</td><td>'+esc(o.state)+' · '+esc(o.ordId||o.clOrdId)+'</td></tr>').join(''):'<tr><td colspan=\"4\">Açık emir yok.</td></tr>')+'</tbody></table></div><h3>Grid seviyeleri</h3><div class=\"table-scroll\"><table><thead><tr><th>Seviye / yön</th><th>Giriş → çıkış</th><th>Açık sözleşme</th><th>Döngü</th><th>Emirlere yazılan net PnL*</th></tr></thead><tbody>'+b.levels.map(l=>'<tr><td>#'+(l.index+1)+' · '+direction[l.direction]+'</td><td>'+esc(l.entryPx)+' → '+esc(l.exitPx)+'</td><td>'+esc(l.remaining)+' <span class=\"level-status\">'+({idle:'bekliyor',entering:'giriş emri',exiting:'çıkış izleniyor'})[l.phase]+'</span></td><td>'+l.cycle+'</td><td class=\"'+cls(p.grid[l.index])+'\">'+money(p.grid[l.index]||'0')+'</td></tr>').join('')+'</tbody></table></div><p class=\"detail-info\">* Funding dahil değildir. Kısmi veri uyarısı varken seviye değerleri de eksik olabilir. Başlangıç: '+date(b.createdAt)+' · Bot: '+esc(b.id)+'</p>';\n}\nasync function refresh(){if(refreshing||$('workspace').hidden)return;refreshing=true;try{state=await api('/api/state');render();}catch(e){$('globalWarning').hidden=false;$('globalWarning').textContent='VERİ GÜNCELLENEMİYOR: '+e.message+' Ekrandaki değerler eski olabilir.';$('syncStatus').textContent='Bağlantı kesildi';}finally{refreshing=false;}}\nasync function openCreate(){\n  $('createError').textContent='';$('previewResult').hidden=true;$('startButton').disabled=true;previewSignature='';$('createDialog').showModal();\n  try{const r=await api('/api/instruments');$('instrument').innerHTML=r.instruments.map(i=>'<option>'+esc(i.instId)+'</option>').join('');$('createForm').elements.amountPerTrade.max=config.limits.maxTrade;}catch(e){$('createError').textContent=e.message;}\n}\nconst formData=()=>Object.fromEntries(new FormData($('createForm')));\nconst signature=data=>JSON.stringify(Object.entries(data).filter(([k])=>k!=='confirm'));\n$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await api('/api/login','POST',{password:$('password').value});$('password').value='';$('loginError').textContent='';await boot();}catch(error){$('loginError').textContent=error.message;}finally{button.disabled=false;}});\n$('logout').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});showLogin();}catch(e){toast(e.message);}});\n$('refresh').addEventListener('click',refresh);$('eventFilter').addEventListener('change',renderEvents);$('newBot').addEventListener('click',openCreate);$('closeCreate').addEventListener('click',()=>{if(!pending)$('createDialog').close();});$('closeDetail').addEventListener('click',()=>{selected='';$('detailPanel').hidden=true;});\n$('botList').addEventListener('click',async e=>{\n  const button=e.target.closest('[data-action]');if(!button)return;const {action,id}=button.dataset;\n  if(action==='create')return openCreate();if(action==='detail'){selected=id;renderDetail();$('detailPanel').scrollIntoView({behavior:'smooth',block:'start'});return;}\n  if(action==='stop'&&!confirm('Yeni girişler iptal edilecek. Açık pozisyonlar kâr alma fiyatına ulaşana kadar açık kalacak. Devam edilsin mi?'))return;\n  button.disabled=true;try{await api('/api/bots/'+id+'/'+action,'POST',{});toast('Komut kaydedildi. Sonraki emir döngüsünde uygulanacak.');await refresh();}catch(error){toast(error.message);}finally{button.disabled=false;}\n});\n$('createForm').addEventListener('input',()=>{if(previewSignature!==signature(formData())){$('startButton').disabled=true;$('previewResult').hidden=true;}});\n$('previewButton').addEventListener('click',async()=>{\n  if(!$('createForm').reportValidity())return;const data=formData();$('previewButton').disabled=true;$('createError').textContent='';\n  try{const p=await api('/api/preview','POST',data);if(signature(data)!==signature(formData()))return;previewSignature=signature(data);$('previewResult').innerHTML='<div class=\"preview-summary\"><b>'+p.settings.gridNum+' grid · gerçek aralık %'+n(p.settings.effectivePct,3)+'</b><br>Son fiyat: '+n(p.ticker.last)+' USDT<br>En fazla başlangıç emir değeri: '+n(p.maxEntryNotional)+' USDT<br>Yaklaşık başlangıç marjini: '+n(p.approxInitialMargin)+' USDT (+ komisyon / güvenlik payı)<br>Başlatırken pozisyon, emirler ve bakiye yeniden kontrol edilir.</div>';$('previewResult').hidden=false;$('startButton').disabled=false;}catch(e){$('createError').textContent=e.message;}finally{$('previewButton').disabled=false;}\n});\n$('createForm').addEventListener('submit',async e=>{\n  e.preventDefault();if(pending)return;const data=formData();if(signature(data)!==previewSignature){$('createError').textContent='Önce güncel planı hesaplayın.';return;}if(!config.demo&&data.confirm!=='CANLI'){$('createError').textContent='CANLI yazarak onaylayın.';return;}\n  pending=true;$('startButton').disabled=true;$('closeCreate').disabled=true;$('createError').textContent='Hesap ve emir kontrolleri yapılıyor…';\n  try{const r=await api('/api/bots','POST',data);selected=r.id;$('createDialog').close();toast('Grid kaydedildi. Emir yönetimi başlıyor.');await refresh();}catch(e){$('createError').textContent=e.message+' Başlatma yanıtı belirsizse tekrar denemeden önce strateji listesini yenileyin.';await refresh();}finally{pending=false;$('closeCreate').disabled=false;previewSignature='';}\n});\nboot();setInterval(refresh,5000);\n"};
const safeEqual=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
const intEnv=(v,d)=>Number.isInteger(Number(v))&&Number(v)>0?Number(v):d;
export function createApp(env=process.env,dependencies={}){
  if(!['true','false',undefined].includes(env.OKX_DEMO))throw new Error('OKX_DEMO true veya false olmalı.');
  const config={apiKey:env.OKX_API_KEY,secretKey:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE,site:env.OKX_SITE||'global',demo:env.OKX_DEMO!=='false'};
  const okx=dependencies.okx||createOkxClient(config),storageReady=!!env.DATA_DIR;
  const identity=createHash('sha256').update([config.site,config.demo,config.apiKey||'unconfigured'].join(':')).digest('hex');
  const store=dependencies.store||new Store(env.DATA_DIR||path.join(root,'data'),identity);
  const alerts=dependencies.alerts||new Alerts(store,{token:env.TELEGRAM_BOT_TOKEN,chatId:env.TELEGRAM_CHAT_ID,demo:config.demo,cooldownMinutes:env.TELEGRAM_COOLDOWN_MINUTES,secrets:[config.apiKey,config.secretKey,config.passphrase,env.TELEGRAM_BOT_TOKEN]});
  const engine=dependencies.engine||new GridEngine(okx,store,alerts,{maxTrade:intEnv(env.MAX_TRADE_USDT,100),maxBots:intEnv(env.MAX_ACTIVE_BOTS,5)});
  const sessions=new Map(),attempts=new Map(),sessionKey=randomBytes(32);
  let shuttingDown=false;const bootAt=Date.now();
  const csrf=token=>createHmac('sha256',sessionKey).update(token).digest('hex');
  const cookie=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('grid_session='))?.slice(13)||'';
  const auth=req=>{const token=cookie(req),expires=sessions.get(token);return expires&&expires>Date.now()?token:null;};
  const fail=(message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
  const send=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
  const write=req=>{const token=auth(req);if(!token)fail('Oturum açın.',401);if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)fail('Kaynak doğrulanamadı.',403);if(!safeEqual(req.headers['x-csrf-token']||'',csrf(token)))fail('CSRF doğrulaması başarısız.',403);if(shuttingDown)fail('Sunucu kapanıyor.',503);};
  async function json(req){let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>12000)fail('İstek çok büyük.',413);}try{return JSON.parse(body||'{}');}catch{fail('Geçersiz JSON.');}}
  async function route(req,res){
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost'),p=url.pathname;
      if(p==='/favicon.ico'){res.writeHead(204);return res.end();}
      const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8']};
      if(req.method==='GET'&&assets[p]){const [file,type]=assets[p],content=EMBEDDED_ASSETS?EMBEDDED_ASSETS[file]:await readFile(path.join(root,'public',file));res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});return res.end(content);}
      if(p==='/health')return send(res,shuttingDown||engine.fatal?503:200,{ok:!shuttingDown&&!engine.fatal});
      if(p==='/ready')return send(res,!engine.fatal&&Date.now()-engine.lastTick<60000?200:503,{ready:!engine.fatal&&Date.now()-engine.lastTick<60000});
      if(req.method==='GET'&&p==='/api/bootstrap'){const token=auth(req);return send(res,200,{loggedIn:!!token,configured:!!env.DASHBOARD_PASSWORD&&okx.credentialsReady,demo:config.demo,site:config.site,storageReady,csrf:token?csrf(token):null,limits:token?{maxTrade:engine.maxTrade,maxBots:engine.maxBots}:null});}
      if(req.method==='POST'&&p==='/api/login'){
        if(!env.DASHBOARD_PASSWORD)fail('DASHBOARD_PASSWORD eksik.',503);
        const ip=env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0]:req.socket.remoteAddress;
        for(const [k,v] of attempts)if(v.until<Date.now())attempts.delete(k);
        if(attempts.size>10000)fail('Giriş yoğunluğu fazla.',429);
        const a=attempts.get(ip)||{count:0,until:Date.now()+600000};if(a.count>=8)fail('Çok fazla deneme. 10 dakika bekleyin.',429);
        const body=await json(req);if(!safeEqual(body.password||'',env.DASHBOARD_PASSWORD)){a.count++;attempts.set(ip,a);fail('Şifre yanlış.',401);}
        attempts.delete(ip);for(const [k,v] of sessions)if(v<Date.now())sessions.delete(k);
        const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+43200000);
        const secure=env.NODE_ENV==='production'?'; Secure':'';
        return send(res,200,{ok:true},{'Set-Cookie':'grid_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+secure});
      }
      if(!p.startsWith('/api/'))return send(res,404,{error:'Bulunamadı.'});
      if(!auth(req))fail('Oturum açın.',401);
      if(req.method==='POST'&&p==='/api/logout'){write(req);sessions.delete(auth(req));return send(res,200,{ok:true},{'Set-Cookie':'grid_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
      if(req.method==='GET'&&p==='/api/instruments')return send(res,200,{instruments:await okx.instruments()});
      if(req.method==='GET'&&p==='/api/state')return send(res,200,{bots:engine.summaries(),events:store.data.events.slice(-100).reverse(),health:{lastTick:engine.lastTick,duration:engine.lastDuration,fatal:engine.fatal,ledgerError:engine.ledgerError,ledgerThrough:store.data.ledgerThrough,telegram:{enabled:alerts.enabled,error:alerts.error,lastSentAt:store.data.telegramLastAt||null}},alerts:Object.values(store.data.alerts).filter(x=>!x.resolved)});
      if(req.method==='GET'&&p==='/api/export'){
        const result={exportedAt:new Date().toISOString(),version:3,bots:store.data.bots,bills:store.data.bills,events:store.data.events};
        return send(res,200,result,{'Content-Disposition':'attachment; filename="grid-audit.json"'});
      }
      if(req.method==='POST'&&p==='/api/preview'){write(req);return send(res,200,await engine.plan(await json(req)));}
      if(req.method==='POST'&&p==='/api/bots'){
        write(req);if(!okx.credentialsReady)fail('OKX API bilgileri eksik.',503);if(!storageReady)fail('DATA_DIR kalıcı disk yolu ayarlanmalı.',503);
        return send(res,201,{id:await engine.create(await json(req))});
      }
      const m=p.match(/^\/api\/bots\/([a-f0-9]{12})\/(pause|resume|stop)$/);
      if(req.method==='POST'&&m){write(req);await engine.control(m[1],m[2]);return send(res,200,{ok:true});}
      return send(res,404,{error:'Bulunamadı.'});
    }catch(e){const status=e.status||400;send(res,status,{error:alerts.redact(e.message),code:e.code||''});}
  }
  const server=http.createServer(route);server.requestTimeout=15000;server.headersTimeout=10000;
  const pollMs=Math.max(1500,intEnv(env.POLL_MS,3000));
  let timer;
  async function loop(){if(shuttingDown)return;try{await engine.tick();}catch(e){console.error('Grid döngüsü:',alerts.redact(e.message));}finally{if(!shuttingDown){timer=setTimeout(loop,pollMs);timer.unref();}}}
  if(dependencies.autoTick!==false){timer=setTimeout(loop,100);timer.unref();}
  const watchdog=setInterval(()=>{if(Date.now()-(engine.lastTick||bootAt)>60000&&store.data.bots.some(b=>b.status!=='stopped')){alerts.raise('watchdog','Grid döngüsü 60 saniyedir tamamlanmadı. Emir koruması gecikebilir.');void alerts.flush();}else alerts.resolve('watchdog');},10000);watchdog.unref();
  server.on('close',()=>{shuttingDown=true;clearTimeout(timer);clearInterval(watchdog);});
  async function close(){
    shuttingDown=true;clearTimeout(timer);clearInterval(watchdog);
    await engine.queue;
    for(const b of store.data.bots.filter(b=>b.status==='running'))await engine.control(b.id,'pause');
    if(dependencies.autoTick!==false)await engine.tick();
    if(store.data.bots.some(b=>b.status!=='stopped'&&(engine.live(b).length||b.levels.some(l=>Number(l.remaining)>0)))){alerts.raise('shutdown','Sunucu kapanıyor; OKX açık emir/pozisyonlarını kontrol edin. Çıkış yönetimi yeniden başlatmaya kadar duracak.');await alerts.flush();}
    while(alerts.busy)await new Promise(r=>setTimeout(r,50));
    if(server.listening)await new Promise(r=>server.close(r));store.close();
  }
  return {server,engine,store,alerts,close};
}
export async function telegramChatIds(env=process.env,request=fetch){
  if(!env.TELEGRAM_BOT_TOKEN)throw new Error('Önce TELEGRAM_BOT_TOKEN ayarlayın.');
  const response=await request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getUpdates',{signal:AbortSignal.timeout(10000),redirect:'error'});
  const result=await response.json();if(!response.ok||!result.ok)throw new Error('Telegram sorgusu başarısız. Token ve bot webhook ayarını kontrol edin.');
  const chats=new Map();for(const u of result.result||[]){const c=(u.message||u.channel_post)?.chat;if(c)chats.set(String(c.id),{chatId:String(c.id),type:c.type,name:c.title||c.first_name||''});}
  return [...chats.values()];
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--telegram-chat-id')){
    telegramChatIds().then(chats=>console.log(chats.length?JSON.stringify(chats,null,2):'Önce Telegram üzerinde botunuza /start gönderin.')).catch(()=>{console.error('Telegram chat ID alınamadı. Token / ağ / webhook ayarını kontrol edin.');process.exitCode=1;});
  }else{
  let app;
  try{app=createApp();}catch(e){console.error(e.message);process.exitCode=1;}
  if(app){
    app.server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('Grid Control 3 • '+(process.env.OKX_DEMO==='false'?'CANLI':'DEMO')+' • port '+(process.env.PORT||3000)));
    let closing=false;
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();app.close().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});});
  }
  }
}
