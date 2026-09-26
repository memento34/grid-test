import http from 'node:http';
import { createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOkxClient } from './okx.js';
import { Store } from './store.js';
import { Alerts } from './alerts.js';
import { GridEngine } from './engine.js';
const root=path.dirname(fileURLToPath(import.meta.url));
// The distribution builder replaces this with embedded static assets.
const EMBEDDED_ASSETS=null;
const safeEqual=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a)).digest(),createHash('sha256').update(String(b)).digest());
const intEnv=(v,d)=>Number.isInteger(Number(v))&&Number(v)>0?Number(v):d;
export function createApp(env=process.env,dependencies={}){
  if(!['true','false',undefined].includes(env.OKX_DEMO))throw new Error('OKX_DEMO true veya false olmalı.');
  const config={apiKey:env.OKX_API_KEY,secretKey:env.OKX_SECRET_KEY,passphrase:env.OKX_PASSPHRASE,site:env.OKX_SITE||'global',demo:env.OKX_DEMO==='true'};
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
    app.server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('Grid Control 3.0.1 • '+(process.env.OKX_DEMO==='true'?'DEMO':'CANLI')+' • port '+(process.env.PORT||3000)));
    let closing=false;
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;const deadline=setTimeout(()=>process.exit(1),25000);deadline.unref();app.close().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});});
  }
  }
}
