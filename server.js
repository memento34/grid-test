import http from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOkxClient, OkxError } from './okx.js';
import { ManualGridEngine } from './manual-engine.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const sessionKey = randomBytes(32);
const sessions = new Map();
const loginAttempts = new Map();

function intEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const config = {
  apiKey: process.env.OKX_API_KEY,
  secretKey: process.env.OKX_SECRET_KEY,
  passphrase: process.env.OKX_PASSPHRASE,
  site: process.env.OKX_SITE || 'global',
  password: process.env.DASHBOARD_PASSWORD || '',
  maxLeverage: intEnv(process.env.MAX_LEVERAGE, 5),
  maxActiveBots: intEnv(process.env.MAX_ACTIVE_BOTS, 5)
};
const okx = createOkxClient(config);
const storageReady = Boolean(process.env.DATA_DIR);
const engine = new ManualGridEngine(okx, process.env.DATA_DIR || path.join(root, 'data'), {
  maxTrade: intEnv(process.env.MAX_TRADE_USDT, 100),
  maxLeverage: config.maxLeverage,
  maxBots: config.maxActiveBots
});

function send(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function errorResponse(res, error) {
  const status = error instanceof OkxError ? error.status : (error.status || 500);
  const message = status === 500 ? 'Sunucu hatası. Railway kayıtlarını kontrol edin.' : error.message;
  if (status === 500) console.error(error);
  else if (error instanceof OkxError) console.warn('OKX isteği başarısız:', { code: error.code, message: error.message });
  send(res, status, { error: message, code: error.code || '' });
}

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function safeEqual(a, b) {
  const ah = createHash('sha256').update(String(a)).digest();
  const bh = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ah, bh);
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : '';
}

function sessionFor(req) {
  const token = cookieValue(req, 'grid_session');
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) return null;
  return { token, session };
}

function csrfFor(token) {
  return createHmac('sha256', sessionKey).update(`csrf:${token}`).digest('hex');
}

function requireAuth(req) {
  const record = sessionFor(req);
  if (!record) fail('Oturum açmanız gerekiyor.', 401);
  return record;
}

function requireWrite(req) {
  const record = requireAuth(req);
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) fail('İstek kaynağı doğrulanamadı.', 403);
  if (!safeEqual(req.headers['x-csrf-token'] || '', csrfFor(record.token))) fail('Oturum doğrulaması başarısız.', 403);
  return record;
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (text.length > 12000) fail('İstek çok büyük.', 413);
  }
  try { return JSON.parse(text || '{}'); }
  catch { fail('Geçersiz JSON.', 400); }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (req.method === 'GET' && publicFiles.has(pathname)) {
      const [file, type] = publicFiles.get(pathname);
      const content = await readFile(path.join(root, 'public', file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(content);
    }
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      const loggedIn = Boolean(sessionFor(req));
      return send(res, 200, {
        loggedIn,
        configured: Boolean(config.password && okx.credentialsReady),
        site: okx.site,
        csrf: loggedIn ? csrfFor(sessionFor(req).token) : null,
        limits: loggedIn ? { maxTrade: engine.maxTrade, maxLeverage: config.maxLeverage, maxActiveBots: config.maxActiveBots } : null,
        storageReady
      });
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!config.password) fail('DASHBOARD_PASSWORD Railway Variables içinde eksik.', 503);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const attempt = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 600000 };
      if (Date.now() > attempt.resetAt) { attempt.count = 0; attempt.resetAt = Date.now() + 600000; }
      if (attempt.count >= 8) fail('Çok fazla deneme. 10 dakika sonra tekrar deneyin.', 429);
      const body = await readJson(req);
      if (!safeEqual(body.password || '', config.password)) {
        attempt.count++;
        loginAttempts.set(ip, attempt);
        fail('Şifre yanlış.', 401);
      }
      loginAttempts.delete(ip);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { expires: Date.now() + 12 * 60 * 60 * 1000 });
      const secure = process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `grid_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const record = requireWrite(req);
      sessions.delete(record.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'grid_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Sayfa bulunamadı.' });
    requireAuth(req);
    if (req.method === 'GET' && pathname === '/api/instruments') return send(res, 200, { instruments: await okx.instruments() });
    if (req.method === 'GET' && pathname === '/api/ticker') {
      const instId = url.searchParams.get('instId') || '';
      if (!/^[A-Z0-9]+-USDT-SWAP$/.test(instId)) fail('Parite geçersiz.');
      return send(res, 200, { ticker: await okx.ticker(instId) });
    }
    if (req.method === 'GET' && pathname === '/api/bots') {
      return send(res, 200, { bots: engine.summaries() });
    }
    const detailMatch = pathname.match(/^\/api\/bots\/([a-f0-9]{12})$/);
    if (req.method === 'GET' && detailMatch) {
      const bot = engine.summaries().find(item => item.id === detailMatch[1]);
      if (!bot) fail('Bot bulunamadı.', 404);
      return send(res, 200, { bot });
    }
    if (req.method === 'POST' && pathname === '/api/bots') {
      requireWrite(req);
      if (!okx.credentialsReady) fail('OKX API bilgileri eksik.', 503);
      if (!storageReady) fail('Canlı bot için Railway Volume bağlayıp DATA_DIR değişkenini volume yoluna ayarlayın.', 503);
      const body = await readJson(req);
      return send(res, 201, { bot: await engine.create(body) });
    }
    const stopMatch = pathname.match(/^\/api\/bots\/([a-f0-9]{12})\/stop$/);
    if (req.method === 'POST' && stopMatch) {
      requireWrite(req);
      engine.stop(stopMatch[1]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'İstek bulunamadı.' });
  } catch (error) {
    errorResponse(res, error);
  }
}

export function createServer() {
  const server = http.createServer(route);
  const timer = setInterval(() => engine.tick().catch(error => console.error('Grid döngüsü durdu:', error)), 3000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => console.log(`Grid Control listening on ${port}`));
}
