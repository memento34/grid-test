import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOkxClient, OkxError } from '../okx.js';

function response(data, code = '0') {
  return { ok: true, status: 200, async json() { return { code, msg: '', data }; } };
}

test('normal futures limit order is signed and sent to the standard trade endpoint', async () => {
  let request;
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async (url, options) => { request = { url, options }; return response([{ ordId: '42', sCode: '0' }]); }
  );
  const body = {
    instId: 'BTC-USDT-SWAP', tdMode: 'isolated', clOrdId: 'MG123',
    side: 'buy', posSide: 'long', ordType: 'limit', px: '90000', sz: '1'
  };
  const result = await client.placeOrder(body);
  assert.equal(result.ordId, '42');
  assert.equal(request.url, 'https://www.okx.com/api/v5/trade/order');
  assert.deepEqual(JSON.parse(request.options.body), body);
  const signed = request.options.headers['OK-ACCESS-TIMESTAMP'] + 'POST' +
    '/api/v5/trade/order' + request.options.body;
  assert.equal(request.options.headers['OK-ACCESS-SIGN'], createHmac('sha256', 'SECRET').update(signed).digest('base64'));
});

test('OKX nested rejection and top-level HTTP 200 rejection retain their codes', async () => {
  const credentials = { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' };
  const nested = createOkxClient(credentials, async () => response([{ sCode: '51121', sMsg: 'Invalid quantity' }]));
  await assert.rejects(nested.placeOrder({}), error => error instanceof OkxError && error.code === '51121');
  const top = createOkxClient(credentials, async () => response([], '58012'));
  await assert.rejects(top.placeOrder({}), error => error instanceof OkxError && error.message.includes('kod 58012'));
});

test('order lookup uses client ID and cancellation sends the same ID', async () => {
  const calls = [];
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async (url, options) => { calls.push({ url, options }); return response([{ clOrdId: 'MG123', state: 'live', sCode: '0' }]); }
  );
  await client.orderDetails('BTC-USDT-SWAP', 'MG123');
  await client.cancelOrder('BTC-USDT-SWAP', 'MG123');
  assert(calls[0].url.includes('clOrdId=MG123'));
  assert.deepEqual(JSON.parse(calls[1].options.body), { instId: 'BTC-USDT-SWAP', clOrdId: 'MG123' });
});

test('cross 10x leverage request omits position side even in hedge mode', async () => {
  let body;
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async (_, options) => { body = JSON.parse(options.body); return response([{ lever: '10', mgnMode: 'cross', sCode: '0' }]); }
  );
  await client.setLeverage('BTC-USDT-SWAP', 10, 'cross');
  assert.deepEqual(body, { instId: 'BTC-USDT-SWAP', lever: '10', mgnMode: 'cross' });
});
