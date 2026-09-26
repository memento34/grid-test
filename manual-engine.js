import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ACTIVE = new Set(['running', 'stopping', 'error']);
const TERMINAL = new Set(['filled', 'canceled', 'mmp_canceled']);

function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) problem(name + ' pozitif bir sayı olmalı.');
  return number;
}

function decimals(value) {
  const text = String(value);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function formatStep(value, step, mode = 'round') {
  const digits = Math.min(10, Math.max(decimals(step), 0));
  const scale = 10 ** digits;
  const units = value / Number(step);
  const whole = mode === 'floor' ? Math.floor(units + 1e-9) : Math.round(units);
  return (Math.round(whole * Number(step) * scale) / scale).toFixed(digits);
}

export function buildLevels(config, instrument) {
  const lower = positive(config.minPx, 'Alt fiyat');
  const upper = positive(config.maxPx, 'Üst fiyat');
  if (upper <= lower) problem('Üst fiyat alt fiyattan büyük olmalı.');
  const n = Number(config.gridNum);
  if (!Number.isInteger(n) || n < 2 || n > 500) problem('Hesaplanan grid sayısı 2–500 aralığında olmalı.');
  if (!['1', '2'].includes(String(config.runType))) problem('Aralık türü geçersiz.');
  const ctVal = positive(instrument.ctVal, 'Sözleşme değeri');
  const lot = positive(instrument.lotSz, 'Sözleşme adımı');
  const minSz = positive(instrument.minSz, 'Minimum sözleşme miktarı');
  const tick = positive(instrument.tickSz, 'Fiyat adımı');
  const perTrade = positive(config.amountPerTrade, 'İşlem başı değer');
  const prices = [];
  for (let i = 0; i <= n; i++) {
    const fraction = i / n;
    const raw = String(config.runType) === '2'
      ? lower * (upper / lower) ** fraction : lower + (upper - lower) * fraction;
    prices.push(formatStep(raw, tick));
  }
  for (let i = 1; i < prices.length; i++) {
    if (Number(prices[i]) <= Number(prices[i - 1])) problem('Grid aralığı bu paritenin fiyat adımına göre çok dar. Grid sayısını azaltın.');
  }
  const middle = (lower + upper) / 2;
  const levels = [];
  for (let i = 0; i < n; i++) {
    const long = config.direction === 'long' || (config.direction === 'neutral' && Number(prices[i]) < middle);
    if (config.direction === 'short' || config.direction === 'neutral') {
      if (!long) {
        const entry = Number(prices[i + 1]);
        const quantity = formatStep(perTrade / (entry * ctVal), lot, 'floor');
        if (Number(quantity) < minSz) problem('İşlem başı USDT, ' + config.instId + ' minimum sözleşme miktarına yetmiyor. En az yaklaşık ' + (minSz * ctVal * entry).toFixed(2) + ' USDT gerekir.');
        levels.push({ index: i, direction: 'short', entryPx: prices[i + 1], exitPx: prices[i], sz: quantity, phase: 'idle', remaining: 0, cycle: 0, order: null });
        continue;
      }
    }
    if (long) {
      const entry = Number(prices[i]);
      const quantity = formatStep(perTrade / (entry * ctVal), lot, 'floor');
      if (Number(quantity) < minSz) problem('İşlem başı USDT, ' + config.instId + ' minimum sözleşme miktarına yetmiyor. En az yaklaşık ' + (minSz * ctVal * entry).toFixed(2) + ' USDT gerekir.');
      levels.push({ index: i, direction: 'long', entryPx: prices[i], exitPx: prices[i + 1], sz: quantity, phase: 'idle', remaining: 0, cycle: 0, order: null });
    }
  }
  if (!levels.length) problem('Bu ayarlar için kullanılabilir grid seviyesi yok.');
  return levels;
}

export function deriveGrid(minPx, maxPx, targetPct) {
  const lower = positive(minPx, 'Alt fiyat');
  const upper = positive(maxPx, 'Üst fiyat');
  const percentage = positive(targetPct, 'Grid yüzdesi');
  if (upper <= lower) problem('Üst fiyat alt fiyattan büyük olmalı.');
  if (percentage < 0.1 || percentage > 25) problem('Grid yüzdesi %0,1–%25 aralığında olmalı.');
  const gridNum = Math.floor(Math.log(upper / lower) / Math.log1p(percentage / 100));
  if (gridNum < 2) problem('Bu aralık ve yüzde en az iki grid oluşturmuyor. Daha küçük yüzde seçin.');
  if (gridNum > 500) problem('Bu ayarlar 500 gridden fazla oluşturuyor. Yüzdeyi artırın.');
  return { gridNum, effectivePct: ((upper / lower) ** (1 / gridNum) - 1) * 100 };
}

export class ManualGridEngine {
  constructor(okx, dataDir, limits = {}) {
    this.okx = okx;
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'manual-grids.json');
    this.maxTrade = limits.maxTrade || 100;
    this.maxLeverage = limits.maxLeverage || 5;
    this.maxBots = limits.maxBots || 5;
    this.busy = false;
    this.creating = false;
    mkdirSync(dataDir, { recursive: true });
    this.bots = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')).bots : [];
    if (!Array.isArray(this.bots)) throw new Error('Grid kayıt dosyası geçersiz. Canlı emir yönetimi başlatılmadı.');
  }

  save() {
    const temp = this.file + '.tmp-' + process.pid;
    writeFileSync(temp, JSON.stringify({ version: 1, bots: this.bots }, null, 2), { mode: 0o600 });
    for (let attempt = 0; attempt < 6; attempt++) {
      try { renameSync(temp, this.file); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  }

  summaries() {
    return this.bots.map(bot => ({
      id: bot.id, instId: bot.instId, direction: bot.direction, status: bot.status,
      minPx: bot.minPx, maxPx: bot.maxPx, gridNum: bot.gridNum, runType: bot.runType,
      amountPerTrade: bot.amountPerTrade, leverage: bot.leverage,
      targetPct: bot.targetPct, effectivePct: bot.effectivePct,
      error: bot.error || '', levels: bot.levels.map(level => ({
        index: level.index, direction: level.direction, entryPx: level.entryPx,
        exitPx: level.exitPx, phase: level.phase, remaining: level.remaining,
        cycle: level.cycle, orderId: level.order?.clOrdId || ''
      }))
    }));
  }

  async create(input) {
    if (this.creating) problem('Başka bir bot oluşturma isteği sürüyor. Birkaç saniye sonra yeniden deneyin.', 409);
    this.creating = true;
    try {
    const instId = String(input.instId || '');
    if (!/^[A-Z0-9]+-USDT-SWAP$/.test(instId)) problem('Yalnızca USDT sürekli vadeli pariteleri desteklenir.');
    const direction = String(input.direction || '');
    if (!['long', 'short', 'neutral'].includes(direction)) problem('Yön long, short veya nötr olmalı.');
    const amountPerTrade = positive(input.amountPerTrade, 'İşlem başı değer');
    if (amountPerTrade > this.maxTrade) problem('İşlem başı değer en fazla ' + this.maxTrade + ' USDT olabilir.');
    const leverage = Number(input.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > this.maxLeverage) problem('Kaldıraç 1–' + this.maxLeverage + ' aralığında olmalı.');
    if (this.bots.filter(bot => ACTIVE.has(bot.status)).length >= this.maxBots) problem('Aktif bot sınırına ulaşıldı.', 409);
    if (this.bots.some(bot => bot.instId === instId && ACTIVE.has(bot.status))) problem('Bu paritede zaten bu panelin çalışan bir botu var.', 409);

    const instruments = await this.okx.instruments();
    const instrument = instruments.find(item => item.instId === instId);
    if (!instrument) problem('Parite OKX üzerinde işlem için açık değil.');
    if (instrument.ctValCcy !== instId.split('-')[0]) problem('Bu sözleşmenin miktar birimi henüz desteklenmiyor.');
    const plan = deriveGrid(input.minPx, input.maxPx, input.targetPct);
    const settings = {
      instId, direction, amountPerTrade, leverage,
      minPx: String(input.minPx), maxPx: String(input.maxPx),
      targetPct: Number(input.targetPct), effectivePct: plan.effectivePct,
      gridNum: plan.gridNum, runType: '2'
    };
    const levels = buildLevels(settings, instrument);
    const ticker = await this.okx.ticker(instId);
    const last = positive(ticker.last, 'Anlık fiyat');
    if (last <= Number(settings.minPx) || last >= Number(settings.maxPx)) problem('Anlık fiyat grid aralığında olmalı.');
    const account = await this.okx.accountConfig();
    const posMode = account.posMode;
    if (!['net_mode', 'long_short_mode'].includes(posMode)) problem('OKX pozisyon modu tanınmadı: ' + String(posMode));
    if (direction === 'neutral' && posMode !== 'long_short_mode') problem('Nötr grid için OKX hesabında long/short (hedge) pozisyon modu gerekir.');
    const [positions, orders, nativeBots] = await Promise.all([
      this.okx.positions(instId), this.okx.pendingOrders(instId), this.okx.gridList('active')
    ]);
    if (positions.some(p => Math.abs(Number(p.pos)) > 0)) problem('Bu paritede açık pozisyon var. Ayrı bir parite veya alt hesap kullanın.');
    if (orders.length) problem('Bu paritede açık normal emir var. Karışmaması için önce bu emirleri yönetin.');
    if (nativeBots.some(bot => bot.instId === instId)) problem('Bu paritede OKX yerel grid botu var. Aynı paritede ikinci bot başlatılmadı.');

    const sides = posMode === 'long_short_mode'
      ? [...new Set(levels.map(level => level.direction))] : [null];
    for (const side of sides) await this.okx.setLeverage(instId, leverage, side);
    const bot = {
      id: randomBytes(6).toString('hex'), ...settings, posMode,
      status: 'running', error: '', seq: 0, createdAt: Date.now(), levels
    };
    this.bots.push(bot);
    this.save();
    return this.summaries().find(item => item.id === bot.id);
    } finally { this.creating = false; }
  }

  stop(id) {
    const bot = this.bots.find(item => item.id === id);
    if (!bot) problem('Bot bulunamadı.', 404);
    if (bot.status === 'stopped') return;
    bot.status = 'stopping';
    bot.error = '';
    this.save();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const bot of this.bots.filter(item => ACTIVE.has(item.status))) {
        try { await this.tickBot(bot); }
        catch (error) {
          if (bot.status === 'running') bot.status = 'error';
          bot.error = error.message;
          this.save();
          console.warn('Manual grid ' + bot.id + ': ' + error.message);
        }
      }
    } finally { this.busy = false; }
  }

  async requestCancel(bot, level) {
    const order = level.order;
    if (!order || (order.cancelAt && Date.now() - order.cancelAt < 10000)) return;
    order.cancelAt = Date.now();
    this.save();
    try { await this.okx.cancelOrder(bot.instId, order.clOrdId); }
    catch (error) { console.warn('İptal tekrar denenecek: ' + error.message); }
  }

  async place(bot, level, purpose, quantity) {
    const isEntry = purpose === 'entry';
    const isLong = level.direction === 'long';
    const side = isEntry ? (isLong ? 'buy' : 'sell') : (isLong ? 'sell' : 'buy');
    bot.seq++;
    const clOrdId = 'MG' + bot.id + bot.seq.toString(36).padStart(8, '0');
    const order = {
      clOrdId, purpose, sz: String(quantity), createdAt: Date.now(),
      cancelAt: 0, lastFill: 0
    };
    level.order = order;
    level.phase = isEntry ? 'entering' : 'exiting';
    this.save();
    const body = {
      instId: bot.instId, tdMode: 'isolated', clOrdId, side,
      ordType: 'limit', px: isEntry ? level.entryPx : level.exitPx,
      sz: String(quantity)
    };
    if (bot.posMode === 'long_short_mode') body.posSide = level.direction;
    else if (!isEntry) body.reduceOnly = true;
    try {
      const result = await this.okx.placeOrder(body);
      order.ordId = result.ordId || '';
      this.save();
    } catch (error) {
      if (error.code === 'NETWORK') return;
      level.order = null;
      level.phase = isEntry ? 'idle' : 'exiting';
      bot.status = 'error';
      bot.error = error.message;
      this.save();
      throw error;
    }
  }

  async reconcileOrder(bot, level) {
    const order = level.order;
    if (!order) return;
    let detail;
    try { detail = await this.okx.orderDetails(bot.instId, order.clOrdId); }
    catch (error) {
      if (order.ordId && Date.now() - order.createdAt < 10000) return;
      if (Date.now() - order.createdAt < 30000) return;
      throw new Error('Emir durumu doğrulanamadı (' + order.clOrdId + '): ' + error.message);
    }
    if (!detail) {
      if (Date.now() - order.createdAt > 30000) throw new Error('Emir OKX üzerinde bulunamadı: ' + order.clOrdId);
      return;
    }
    const filled = Math.max(0, Number(detail.accFillSz || 0));
    if (!Number.isFinite(filled)) throw new Error('OKX geçersiz dolum miktarı gönderdi.');
    order.lastFill = filled;
    const state = detail.state;
    this.save();
    if (state === 'partially_filled' && order.purpose === 'entry') {
      await this.requestCancel(bot, level);
      return;
    }
    if (!TERMINAL.has(state)) return;
    level.order = null;
    if (order.purpose === 'entry') {
      if (filled > 0) {
        level.remaining = filled;
        level.phase = 'exiting';
      } else level.phase = 'idle';
    } else {
      level.remaining = Math.max(0, Number(level.remaining) - filled);
      if (level.remaining <= Number(order.sz) * 1e-8) {
        level.remaining = 0;
        level.phase = 'idle';
        level.cycle++;
      } else level.phase = 'exiting';
    }
    this.save();
  }

  async tickBot(bot) {
    for (const level of bot.levels) await this.reconcileOrder(bot, level);
    for (const level of bot.levels) {
      if (level.phase === 'exiting' && !level.order && level.remaining > 0) {
        try { await this.place(bot, level, 'exit', level.remaining); }
        catch (error) {
          bot.status = 'error';
          bot.error = 'Kâr alma emri kurulamadı: ' + error.message;
          this.save();
        }
      }
    }
    const ticker = await this.okx.ticker(bot.instId);
    const bid = positive(ticker.bidPx || ticker.last, 'Alış fiyatı');
    const ask = positive(ticker.askPx || ticker.last, 'Satış fiyatı');
    const occupied = bot.levels.filter(level => level.phase === 'exiting' || (level.phase === 'entering' && level.order?.lastFill > 0)).length;
    const capacity = Math.max(0, 5 - occupied);
    const candidates = bot.status === 'running'
      ? bot.levels.filter(level => level.phase === 'idle' || level.phase === 'entering')
        .filter(level => level.direction === 'long' ? Number(level.entryPx) < bid : Number(level.entryPx) > ask)
        .sort((a, b) => Math.abs(Number(a.entryPx) - Number(ticker.last)) - Math.abs(Number(b.entryPx) - Number(ticker.last)))
        .slice(0, capacity)
      : [];
    const wanted = new Set(candidates.map(level => level.index));
    for (const level of bot.levels) {
      if (level.phase === 'entering' && level.order && !wanted.has(level.index)) await this.requestCancel(bot, level);
    }
    const pending = bot.levels.filter(level => level.phase === 'entering').length;
    if (bot.status === 'running' && pending <= capacity) {
      for (const level of candidates) {
        if (level.phase !== 'idle') continue;
        if (bot.levels.filter(item => item.phase === 'entering').length >= capacity) break;
        await this.place(bot, level, 'entry', level.sz);
      }
    }
    if (bot.status === 'stopping' && bot.levels.every(level => level.phase === 'idle')) {
      bot.status = 'stopped';
      this.save();
    }
  }
}
