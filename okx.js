import { createHmac } from 'node:crypto';

const SITES = Object.freeze({
  global: 'https://www.okx.com',
  eea: 'https://eea.okx.com',
  us: 'https://us.okx.com',
  tr: 'https://tr.okx.com'
});

export class OkxError extends Error {
  constructor(message, code = '', status = 502) {
    super(message);
    this.name = 'OkxError';
    this.code = String(code);
    this.status = status;
  }
}

export function createOkxClient(config, request = fetch) {
  const site = config.site || 'global';
  if (!SITES[site]) throw new Error('OKX_SITE global, eea, us veya tr olmalı.');
  const base = SITES[site];
  const credentialsReady = Boolean(config.apiKey && config.secretKey && config.passphrase);

  async function call(method, path, params, privateCall = false) {
    if (privateCall && !credentialsReady) throw new OkxError('OKX API bilgileri Railway Variables içinde eksik.', '', 503);
    const query = method === 'GET' && params ? `?${new URLSearchParams(params).toString()}` : '';
    const requestPath = `${path}${query}`;
    const body = method === 'POST' ? JSON.stringify(params) : '';
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (privateCall) {
      const timestamp = new Date().toISOString();
      const prehash = `${timestamp}${method}${requestPath}${body}`;
      headers['OK-ACCESS-KEY'] = config.apiKey;
      headers['OK-ACCESS-SIGN'] = createHmac('sha256', config.secretKey).update(prehash).digest('base64');
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-PASSPHRASE'] = config.passphrase;
    }
    let response;
    try {
      response = await request(`${base}${requestPath}`, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(method === 'POST' ? 15000 : 10000)
      });
    } catch (error) {
      const suffix = method === 'POST' ? " Emir gönderildiyse durumunu OKX'ten kontrol edin." : '';
      throw new OkxError('OKX bağlantısı sonuçlanmadı: ' + error.message + '.' + suffix, 'NETWORK', 502);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new OkxError(`OKX geçersiz yanıt verdi (HTTP ${response.status}).`, 'INVALID_RESPONSE', 502);
    }
    if (!response.ok || result.code !== '0') {
      throw new OkxError(result.msg || `OKX hatası (HTTP ${response.status})`, result.code, 502);
    }
    if (method === 'POST' && Array.isArray(result.data)) {
      const failed = result.data.find(item => item && item.sCode && item.sCode !== '0');
      if (failed) throw new OkxError(failed.sMsg || 'OKX emri reddetti.', failed.sCode, 422);
    }
    return result.data ?? [];
  }

  return {
    site,
    credentialsReady,
    async instruments() {
      const data = await call('GET', '/api/v5/public/instruments', { instType: 'SWAP' });
      return data.filter(item => item.instId?.endsWith('-USDT-SWAP') && item.state === 'live')
        .map(item => ({ instId: item.instId, tickSz: item.tickSz, minSz: item.minSz, ctVal: item.ctVal }))
        .sort((a, b) => a.instId.localeCompare(b.instId));
    },
    async ticker(instId) {
      const data = await call('GET', '/api/v5/market/ticker', { instId });
      if (!data[0]) throw new OkxError('Parite fiyatı alınamadı.', '', 502);
      return { instId, last: data[0].last, bidPx: data[0].bidPx, askPx: data[0].askPx, ts: data[0].ts };
    },
    async gridList(status = 'active') {
      const path = status === 'history'
        ? '/api/v5/tradingBot/grid/orders-algo-history'
        : '/api/v5/tradingBot/grid/orders-algo-pending';
      return call('GET', path, { algoOrdType: 'contract_grid', limit: '100' }, true);
    },
    async gridDetails(algoId) {
      const data = await call('GET', '/api/v5/tradingBot/grid/orders-algo-details', { algoOrdType: 'contract_grid', algoId }, true);
      return data[0] || null;
    },
    async gridSubOrders(algoId, type) {
      return call('GET', '/api/v5/tradingBot/grid/sub-orders', { algoOrdType: 'contract_grid', algoId, type, limit: '100' }, true);
    },
    async createGrid(settings) {
      return call('POST', '/api/v5/tradingBot/grid/order-algo', {
        instId: settings.instId,
        algoOrdType: 'contract_grid',
        maxPx: settings.maxPx,
        minPx: settings.minPx,
        gridNum: String(settings.gridNum),
        runType: settings.runType,
        sz: settings.margin,
        direction: settings.direction,
        lever: String(settings.leverage),
        basePos: false,
        algoClOrdId: settings.algoClOrdId,
        triggerParams: [{ triggerAction: 'start', triggerStrategy: 'instant' }]
      }, true);
    },
    async stopGrid(algoId, instId, stopType) {
      return call('POST', '/api/v5/tradingBot/grid/stop-order-algo', [{
        algoId,
        algoOrdType: 'contract_grid',
        instId,
        stopType
      }], true);
    }
  };
}
