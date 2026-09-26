import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveGrid, ManualGridEngine } from '../manual-engine.js';

function exchange() {
  const orders = new Map();
  const placed = [];
  let price = 100;
  const client = {
    instruments: async () => [{ instId: 'TEST-USDT-SWAP', state: 'live', tickSz: '0.01', lotSz: '1', minSz: '1', ctVal: '0.01', ctValCcy: 'TEST' }],
    ticker: async () => ({ last: String(price), bidPx: String(price - 0.01), askPx: String(price + 0.01) }),
    accountConfig: async () => ({ posMode: 'long_short_mode' }),
    positions: async () => [], pendingOrders: async () => [], gridList: async () => [],
    setLeverage: async () => [{ lever: '1' }],
    placeOrder: async body => {
      placed.push(body);
      orders.set(body.clOrdId, { ...body, state: 'live', accFillSz: '0' });
      return { ordId: String(placed.length) };
    },
    orderDetails: async (_, id) => orders.get(id) || null,
    cancelOrder: async (_, id) => { orders.get(id).state = 'canceled'; return [{ sCode: '0' }]; }
  };
  return { client, orders, placed, setPrice: value => { price = value; } };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'manual-grid-test-'));
  const fake = exchange();
  const engine = new ManualGridEngine(fake.client, dir);
  return { dir, fake, engine, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const input = {
  instId: 'TEST-USDT-SWAP', direction: 'long', minPx: '70', maxPx: '110',
  targetPct: '3', amountPerTrade: '20', leverage: '1'
};

test('Wunderbit example produces 61 levels from bounds and 1% target', () => {
  assert.equal(deriveGrid(1884.25, 3485.38, 1).gridNum, 61);
});

test('five normal entry limits, adjacent TP, rearm, and restart recovery', async () => {
  const { dir, fake, engine, cleanup } = setup();
  try {
    const bot = await engine.create(input);
    assert.equal(bot.gridNum, deriveGrid(70, 110, 3).gridNum);
    await engine.tick();
    assert.equal(fake.placed.length, 5);
    assert(fake.placed.every(order => order.ordType === 'limit' && order.side === 'buy' && order.tdMode === 'isolated'));
    const first = fake.placed[0];
    const firstDetail = fake.orders.get(first.clOrdId);
    firstDetail.state = 'filled';
    firstDetail.accFillSz = first.sz;
    await engine.tick();
    const tp = fake.placed.find(order => order.side === 'sell');
    assert(tp);
    assert.equal(tp.posSide, 'long');
    assert(Number(tp.px) > Number(first.px));
    assert.equal(tp.sz, first.sz);
    fake.orders.get(tp.clOrdId).state = 'filled';
    fake.orders.get(tp.clOrdId).accFillSz = tp.sz;
    await engine.tick();
    assert(fake.placed.filter(order => order.side === 'buy' && order.px === first.px).length >= 2,
      JSON.stringify({ first, orders: fake.placed, level: engine.summaries()[0].levels.find(level => level.entryPx === first.px) }));
    const count = fake.placed.length;
    const resumed = new ManualGridEngine(fake.client, dir);
    await resumed.tick();
    assert.equal(fake.placed.length, count);
  } finally { cleanup(); }
});

test('price movement cancels stale unfilled entries and rotates the window', async () => {
  const { fake, engine, cleanup } = setup();
  try {
    await engine.create(input);
    await engine.tick();
    const old = fake.placed.map(order => order.clOrdId);
    fake.setPrice(85);
    await engine.tick();
    assert(old.some(id => fake.orders.get(id).state === 'canceled'));
    await engine.tick();
    assert(fake.placed.some(order => Number(order.px) < 85 && !old.includes(order.clOrdId)));
  } finally { cleanup(); }
});

test('stop cancels new entries but keeps an existing limit exit', async () => {
  const { fake, engine, cleanup } = setup();
  try {
    const bot = await engine.create(input);
    await engine.tick();
    const entry = fake.placed[0];
    fake.orders.get(entry.clOrdId).state = 'filled';
    fake.orders.get(entry.clOrdId).accFillSz = entry.sz;
    await engine.tick();
    const exit = fake.placed.find(order => order.side === 'sell');
    assert(exit);
    engine.stop(bot.id);
    await engine.tick();
    assert.equal(fake.orders.get(exit.clOrdId).state, 'live');
    assert(fake.placed.filter(order => order.side === 'buy').some(order => fake.orders.get(order.clOrdId).state === 'canceled'));
    assert.equal(engine.summaries()[0].status, 'stopping');
  } finally { cleanup(); }
});

test('partial entry is canceled before a limit exit covers its filled quantity', async () => {
  const { fake, engine, cleanup } = setup();
  try {
    await engine.create(input);
    await engine.tick();
    const entry = fake.placed[0];
    const filled = String(Math.max(1, Math.floor(Number(entry.sz) / 2)));
    fake.orders.get(entry.clOrdId).state = 'partially_filled';
    fake.orders.get(entry.clOrdId).accFillSz = filled;
    await engine.tick();
    assert.equal(fake.orders.get(entry.clOrdId).state, 'canceled');
    await engine.tick();
    const exit = fake.placed.find(order => order.side === 'sell');
    assert.equal(exit.sz, filled);
  } finally { cleanup(); }
});

test('neutral requires hedge mode and net-mode exits are reduce-only', async () => {
  const { fake, engine, cleanup } = setup();
  try {
    fake.client.accountConfig = async () => ({ posMode: 'net_mode' });
    await assert.rejects(engine.create({ ...input, direction: 'neutral' }), /hedge/);
    await engine.create(input);
    await engine.tick();
    const entry = fake.placed[0];
    fake.orders.get(entry.clOrdId).state = 'filled';
    fake.orders.get(entry.clOrdId).accFillSz = entry.sz;
    await engine.tick();
    const exit = fake.placed.find(order => order.side === 'sell');
    assert.equal(exit.reduceOnly, true);
    assert.equal(exit.posSide, undefined);
  } finally { cleanup(); }
});
