import { createHmac } from 'node:crypto';
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
    if (config.demo === true) headers['x-simulated-trading'] = '1';
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
    site:config.site||'global', demo:config.demo===true, credentialsReady, call, now:()=>Math.round(Date.now()+offset),
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
