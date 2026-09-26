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
    const responseCode = result?.code == null ? '' : String(result.code);
    if (!response.ok || responseCode !== '0') {
      const nested = Array.isArray(result?.data)
        ? result.data.find(item => item?.sMsg || (item?.sCode && String(item.sCode) !== '0'))
        : null;
      const code = responseCode && responseCode !== '0' ? responseCode : String(nested?.sCode || '');
      const detail = result?.msg || nested?.sMsg || 'OKX açıklama göndermedi.';
      throw new OkxError('OKX isteği reddetti' + (code ? ' (kod ' + code + ')' : ' (HTTP ' + response.status + ')') + ': ' + detail, code, 502);
    }
    if (method === 'POST' && Array.isArray(result.data)) {
      const failed = result.data.find(item => item?.sCode != null && String(item.sCode) !== '0');
      if (failed) {
        const code = String(failed.sCode);
        throw new OkxError('OKX emri reddetti (kod ' + code + '): ' + (failed.sMsg || 'OKX açıklama göndermedi.'), code, 422);
      }
    }
    return result.data ?? [];
  }

  return {
    site,
    credentialsReady,
    async instruments() {
      const data = await call('GET', '/api/v5/public/instruments', { instType: 'SWAP' });
      return data.filter(item => item.instId?.endsWith('-USDT-SWAP') && item.state === 'live')
        .map(item => ({ instId: item.instId, tickSz: item.tickSz, minSz: item.minSz, lotSz: item.lotSz, ctVal: item.ctVal, ctValCcy: item.ctValCcy }))
        .sort((a, b) => a.instId.localeCompare(b.instId));
    },
    async ticker(instId) {
      const data = await call('GET', '/api/v5/market/ticker', { instId });
      if (!data[0]) throw new OkxError('Parite fiyatı alınamadı.', '', 502);
      return { instId, last: data[0].last, bidPx: data[0].bidPx, askPx: data[0].askPx, ts: data[0].ts };
    },
    async accountConfig() {
      const data = await call('GET', '/api/v5/account/config', undefined, true);
      return data[0] || {};
    },
    async positions(instId) {
      return call('GET', '/api/v5/account/positions', { instId }, true);
    },
    async pendingOrders(instId) {
      return call('GET', '/api/v5/trade/orders-pending', { instId, instType: 'SWAP' }, true);
    },
    async setLeverage(instId, leverage, mgnMode = 'cross', posSide) {
      const body = { instId, lever: String(leverage), mgnMode };
      if (mgnMode === 'isolated' && posSide) body.posSide = posSide;
      return call('POST', '/api/v5/account/set-leverage', body, true);
    },
    async placeOrder(order) {
      const data = await call('POST', '/api/v5/trade/order', order, true);
      return data[0] || {};
    },
    async orderDetails(instId, clOrdId) {
      const data = await call('GET', '/api/v5/trade/order', { instId, clOrdId }, true);
      return data[0] || null;
    },
    async cancelOrder(instId, clOrdId) {
      return call('POST', '/api/v5/trade/cancel-order', { instId, clOrdId }, true);
    },
    async gridList(status = 'active') {
      const path = status === 'history'
        ? '/api/v5/tradingBot/grid/orders-algo-history'
        : '/api/v5/tradingBot/grid/orders-algo-pending';
      return call('GET', path, { algoOrdType: 'contract_grid', limit: '100' }, true);
    }
  };
}
