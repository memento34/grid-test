import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOkxClient, OkxError } from '../okx.js';

function fakeResponse(data, code = '0') {
  return { ok: true, status: 200, async json() { return { code, msg: '', data }; } };
}

test('grid create signs the exact OKX request and never opens a base position', async () => {
  const calls = [];
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async (url, options) => {
      calls.push({ url, options });
      return fakeResponse([{ algoId: '42', sCode: '0', sMsg: '' }]);
    }
  );
  const result = await client.createGrid({
    instId: 'BTC-USDT-SWAP', minPx: '90000', maxPx: '110000',
    gridNum: 10, runType: '1', margin: '25', direction: 'neutral',
    leverage: 1, algoClOrdId: 'GC123'
  });
  assert.equal(result[0].algoId, '42');
  const { url, options } = calls[0];
  assert.equal(url, 'https://www.okx.com/api/v5/tradingBot/grid/order-algo');
  const body = JSON.parse(options.body);
  assert.equal(body.algoOrdType, 'contract_grid');
  assert.equal(body.direction, 'neutral');
  assert.equal(body.basePos, false);
  assert.equal(body.sz, '25');
  assert.deepEqual(body.triggerParams, [{ triggerAction: 'start', triggerStrategy: 'instant' }]);
  const signed = options.headers['OK-ACCESS-TIMESTAMP'] + 'POST' +
    '/api/v5/tradingBot/grid/order-algo' + options.body;
  assert.equal(options.headers['OK-ACCESS-SIGN'], createHmac('sha256', 'SECRET').update(signed).digest('base64'));
});

test('nested OKX rejection is surfaced instead of reported as success', async () => {
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async () => fakeResponse([{ algoId: '', sCode: '51121', sMsg: 'Invalid quantity' }])
  );
  await assert.rejects(
    client.createGrid({ instId: 'BTC-USDT-SWAP', minPx: '1', maxPx: '2', gridNum: 2, runType: '1', margin: '1', direction: 'long', leverage: 1, algoClOrdId: 'GC1' }),
    error => error instanceof OkxError && error.code === '51121'
  );
});

test('stop uses the array body required by OKX', async () => {
  let body;
  const client = createOkxClient(
    { site: 'global', apiKey: 'KEY', secretKey: 'SECRET', passphrase: 'PASS' },
    async (_, options) => { body = JSON.parse(options.body); return fakeResponse([{ sCode: '0' }]); }
  );
  await client.stopGrid('42', 'ETH-USDT-SWAP', '2');
  assert.deepEqual(body, [{ algoId: '42', algoOrdType: 'contract_grid', instId: 'ETH-USDT-SWAP', stopType: '2' }]);
});
