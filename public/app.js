const $ = id => document.getElementById(id);
const state = { csrf: '', configured: false, storageReady: false, limits: null, last: null, botId: null, instruments: [] };
const money = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 8 });
const fmt = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? money.format(Number(value)) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add('hidden'), 6500);
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = state.csrf;
  }
  const response = await fetch(path, {
    credentials: 'same-origin', method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'İstek başarısız (' + response.status + ')');
  return data;
}

const directionName = d => ({ long:'Long', short:'Short', neutral:'Nötr' }[d] || 'Bilinmeyen');
const selectedDirection = () => document.querySelector('input[name="direction"]:checked')?.value || 'long';
const getForm = () => Object.fromEntries(new FormData($('grid-form')).entries());

function updateDirectionHelp() {
  const help = {
    long: 'Fiyat düştükçe long açar; bir üst gridde kapatır.',
    short: 'Fiyat yükseldikçe short açar; bir alt gridde kapatır.',
    neutral: 'Aralığın orta noktasının altı long, üstü short. Yalnızca piyasanın uygun tarafındaki limit girişler açılır.'
  };
  $('direction-help').textContent = help[selectedDirection()];
  preview();
}

function preview() {
  const f = getForm();
  const lower = Number(f.minPx), upper = Number(f.maxPx), targetPct = Number(f.targetPct);
  const grids = lower > 0 && upper > lower && targetPct >= 0.1 && targetPct <= 25
    ? Math.floor(Math.log(upper / lower) / Math.log1p(targetPct / 100)) : 0;
  const valid = Number.isInteger(grids) && grids >= 2 && grids <= 500;
  const effectivePct = valid ? ((upper / lower) ** (1 / grids) - 1) * 100 : 0;
  $('calculated-grids').textContent = valid ? String(grids) + ' seviye · yaklaşık %' + fmt(effectivePct) : '—';
  const estimatedNotional = Number(f.amountPerTrade);
  const instrument = state.instruments.find(item => item.instId === f.instId);
  const base = String(f.instId || '').split('-')[0];
  const minimumNotional = instrument?.ctValCcy === base && lower > 0
    ? Number(instrument.minSz) * Number(instrument.ctVal) * lower : NaN;
  const belowMinimum = estimatedNotional > 0 && Number.isFinite(minimumNotional) && minimumNotional > 0 && estimatedNotional < minimumNotional;
  const budget = $('budget-note');
  budget.classList.toggle('warning', belowMinimum);
  budget.textContent = estimatedNotional > 0
    ? 'Her giriş emrinin hedef değeri: ' + fmt(estimatedNotional) + ' USDT.' +
      (Number.isFinite(minimumNotional) && minimumNotional > 0
        ? ' Bu paritenin alt fiyattaki en küçük sözleşmesi yaklaşık ' + fmt(minimumNotional) + ' USDT.'
        : '') +
      (belowMinimum ? ' İşlem başı değeri artırın.' : ' Gerçek sözleşme miktarı OKX adımına aşağı yuvarlanır.')
    : 'İşlem başı USDT değeri girin.';
  $('preview-pair').textContent = f.instId || '—';
  $('preview-upper').textContent = valid ? fmt(upper) : '—';
  $('preview-lower').textContent = valid ? fmt(lower) : '—';
  $('last-price').textContent = state.last ? fmt(state.last) : '—';
  if (!valid) {
    $('ladder').innerHTML = '<div class="empty-ladder">Fiyat sınırlarını girerek grid seviyelerini görüntüleyin.</div>';
    $('preview-note').textContent = 'Bot, en yakın beş giriş seviyesini normal OKX limit emri olarak yönetir.';
    return;
  }
  const levels = [];
  for (let i = grids; i >= 0; i--) {
    const r = i / grids;
    levels.push(lower * (upper / lower) ** r);
  }
  const chosen = levels.length <= 12 ? levels : levels.filter((_, i) => i === 0 || i === levels.length - 1 || i % Math.ceil(levels.length / 11) === 0);
  const mid = (lower + upper) / 2;
  $('ladder').innerHTML = chosen.map(price => {
    const type = selectedDirection() === 'long' ? 'buy' : selectedDirection() === 'short' ? 'sell' : price < mid ? 'buy' : 'sell';
    const label = selectedDirection() === 'long' ? 'LONG' : selectedDirection() === 'short' ? 'SHORT' : type === 'buy' ? 'LONG' : 'SHORT';
    return '<div class="ladder-row"><span class="ladder-line"></span><strong>' + fmt(price) + '</strong><span class="tag ' + type + '">' + label + '</span></div>';
  }).join('');
  $('preview-note').textContent = selectedDirection() === 'neutral'
    ? 'Yön ayrımı: ' + fmt(mid) + ' USDT. Alt seviyeler long, üst seviyeler short; emirler piyasa fiyatının uygun tarafında açılır.'
    : grids + ' grid · gerçekleşen fiyat aralığı yaklaşık %' + fmt(effectivePct) + '. Aynı anda en fazla beş giriş limiti ve beş açık pozisyon seviyesi.';
}

async function refreshTicker() {
  const instId = $('pair').value;
  state.last = null;
  preview();
  if (!instId) return;
  try {
    const data = await api('/api/ticker?instId=' + encodeURIComponent(instId));
    if ($('pair').value === instId) { state.last = data.ticker.last; preview(); }
  } catch (error) { toast(error.message, true); }
}

async function loadInstruments() {
  const data = await api('/api/instruments');
  state.instruments = data.instruments;
  const select = $('pair');
  select.innerHTML = '<option value="">Parite seçin</option>' + data.instruments.map(item =>
    '<option value="' + esc(item.instId) + '">' + esc(item.instId.replace('-SWAP', '')) + '</option>'
  ).join('');
  const preferred = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'].find(id => data.instruments.some(item => item.instId === id));
  if (preferred) select.value = preferred;
  await refreshTicker();
}

function botCard(bot) {
  const entries = bot.levels.filter(level => level.phase === 'entering').length;
  const exits = bot.levels.filter(level => level.phase === 'exiting').length;
  return '<div class="bot-card">' +
    '<div><strong>' + esc(bot.instId) + '</strong><small>Bot ' + esc(bot.id) + ' · ' + esc(bot.status) + '</small></div>' +
    '<div><span class="direction-badge ' + esc(bot.direction) + '">' + directionName(bot.direction) + '</span><small>' + fmt(bot.minPx) + ' – ' + fmt(bot.maxPx) + ' USDT</small></div>' +
    '<div class="bot-meta">' + entries + ' giriş · ' + exits + ' kâr alma<small>' + fmt(bot.amountPerTrade) + ' USDT/işlem · ' + esc(bot.leverage) + '×</small></div>' +
    '<div class="bot-actions"><button class="secondary" data-view="' + esc(bot.id) + '">Seviyeler</button>' +
    (['running', 'error'].includes(bot.status) ? '<button class="secondary" data-stop="' + esc(bot.id) + '">Durdur</button>' : '') + '</div>' +
    (bot.error ? '<small class="bot-error">' + esc(bot.error) + '</small>' : '') + '</div>';
}

async function loadBots() {
  try {
    const data = await api('/api/bots');
    $('active-count').textContent = String(data.bots.filter(bot => bot.status === 'running').length);
    $('bots').innerHTML = data.bots.length ? data.bots.map(botCard).join('') : '<div class="empty-state">Bu panelden açılmış aktif grid botu yok.</div>';
  } catch (error) {
    $('bots').innerHTML = '<div class="empty-state">' + esc(error.message) + '</div>';
    toast(error.message, true);
  }
}

function closeModal() { $('modal').classList.add('hidden'); state.botId = null; }

async function showBot(botId) {
  state.botId = botId;
  $('modal').classList.remove('hidden');
  $('modal-body').innerHTML = '<p>Seviyeler yükleniyor...</p>';
  try {
    const data = await api('/api/bots/' + encodeURIComponent(botId));
    if (state.botId !== botId) return;
    const bot = data.bot;
    const active = bot.levels.filter(level => level.phase !== 'idle');
    const rows = active.length ? active.map(level =>
      '<div class="order-row"><span>' + directionName(level.direction) + ' · ' + esc(level.phase === 'entering' ? 'Giriş' : 'Kâr alma') + '</span><span>' + fmt(level.phase === 'entering' ? level.entryPx : level.exitPx) + '</span><span>' + esc(level.orderId || 'bekliyor') + '</span></div>'
    ).join('') : '<div class="empty-state">Şu anda açık seviye yok.</div>';
    $('modal-body').innerHTML =
      '<p class="eyebrow">NORMAL OKX LİMİT EMİRLERİ</p><h2>' + esc(bot.instId) + ' · ' + directionName(bot.direction) + '</h2>' +
      '<p>Bot ' + esc(bot.id) + ' · ' + esc(bot.status) + '</p>' +
      '<div class="modal-grid"><div><small>ALT / ÜST FİYAT</small><strong>' + fmt(bot.minPx) + ' – ' + fmt(bot.maxPx) + '</strong></div>' +
      '<div><small>GRID / HEDEF</small><strong>' + esc(bot.gridNum) + ' / %' + fmt(bot.effectivePct) + '</strong></div>' +
      '<div><small>İŞLEM BAŞI</small><strong>' + fmt(bot.amountPerTrade) + ' USDT</strong></div>' +
      '<div><small>KALDIRAÇ</small><strong>' + esc(bot.leverage) + '×</strong></div></div>' +
      (bot.error ? '<p class="bot-error">' + esc(bot.error) + '</p>' : '') +
      '<div class="orders"><p>Açık seviyeler · emir kimliği</p>' + rows + '</div>';
  } catch (error) { $('modal-body').innerHTML = '<p>' + esc(error.message) + '</p>'; }
}

async function stopBot(botId) {
  if (!window.confirm('Bot ' + botId + ' için yeni girişler durdurulsun mu? Açık girişler iptal edilecek; mevcut pozisyonların limit kâr alma emirleri çalışmaya devam edecek.')) return;
  try {
    await api('/api/bots/' + encodeURIComponent(botId) + '/stop', { method:'POST', body:{} });
    toast('Yeni girişler durduruldu; açık işlemlerin çıkışları izleniyor.');
    await loadBots();
  } catch (error) { toast(error.message, true); }
}

async function startBot(event) {
  event.preventDefault();
  if (!state.configured) return toast('Önce Railway değişkenlerine OKX API bilgilerini girin.', true);
  if (!state.storageReady) return toast('Önce Railway Volume bağlayın ve DATA_DIR ayarlayın.', true);
  const f = getForm();
  $('create-error').classList.add('hidden');
  $('create-error').textContent = '';
  const lower = Number(f.minPx), upper = Number(f.maxPx), amount = Number(f.amountPerTrade);
  const leverage = Number(f.leverage), pct = Number(f.targetPct), last = Number(state.last);
  const count = lower > 0 && upper > lower && pct > 0 ? Math.floor(Math.log(upper / lower) / Math.log1p(pct / 100)) : 0;
  if (!f.instId || !['long', 'short', 'neutral'].includes(f.direction)) return toast('Parite ve yön seçin.', true);
  if (!(lower > 0 && upper > lower && last > lower && last < upper)) return toast('Anlık fiyat alt ve üst fiyatın içinde olmalı.', true);
  if (!(amount > 0 && amount <= state.limits.maxTrade && leverage >= 1 && leverage <= state.limits.maxLeverage && pct >= 0.1 && pct <= 25 && count >= 2 && count <= 500))
    return toast('İşlem değeri, kaldıraç veya yüzde izin verilen aralığın dışında.', true);
  let message = f.instId + ' için ' + directionName(f.direction) + ' limit gridi başlatılacak.\nAralık: ' + fmt(lower) + '–' + fmt(upper) + ' USDT\n' + count + ' grid · yaklaşık %' + fmt(((upper / lower) ** (1 / count) - 1) * 100) + ' aralık · ' + fmt(amount) + ' USDT/işlem · ' + leverage + '× kaldıraç.\n\nEn fazla beş giriş limiti açılır. Bu gerçek işlemdir.';
  if ($('budget-note').classList.contains('warning')) message += '\n\nUyarı: işlem başı tutar paritenin en küçük sözleşme değerinin altında olabilir.';
  if (f.direction === 'neutral') message += '\n\nNötr yön ayrımı aralığın matematiksel ortasında yapılır: ' + fmt((lower + upper) / 2) + ' USDT.';
  if (!window.confirm(message)) return;
  const button = $('create-button');
  button.disabled = true;
  button.textContent = 'Bot oluşturuluyor...';
  try {
    const result = await api('/api/bots', { method:'POST', body:f, headers:{ 'Idempotency-Key': crypto.randomUUID() } });
    toast('Limit grid başlatıldı: ' + (result.bot?.id || '—') + '. İlk emirler birkaç saniye içinde yerleşir.');
    await loadBots();
  } catch (error) {
    $('create-error').textContent = error.message;
    $('create-error').classList.remove('hidden');
    $('create-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(error.message, true);
  }
  finally { button.disabled = false; button.innerHTML = 'Canlı limit gridini başlat <span>↗</span>'; }
}

async function initialize() {
  try {
    const boot = await api('/api/bootstrap');
    state.configured = boot.configured;
    state.storageReady = boot.storageReady;
    state.csrf = boot.csrf || '';
    state.limits = boot.limits;
    if (!boot.loggedIn) {
      $('login-screen').classList.remove('hidden');
      $('app').classList.add('hidden');
      if (!boot.configured) $('login-error').textContent = 'Railway değişkenlerini girin: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE ve DASHBOARD_PASSWORD.';
      return;
    }
    $('login-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('site-name').textContent = boot.site;
    $('account-site').textContent = boot.site.toUpperCase() + ' API';
    $('account-state').textContent = boot.configured ? 'Hazır' : 'Eksik';
    document.querySelector('.connection strong').textContent = boot.configured ? 'Canlı OKX bağlantısı' : 'OKX API eksik';
    $('margin-limit').textContent = fmt(boot.limits.maxTrade) + ' USDT';
    $('leverage').max = String(boot.limits.maxLeverage);
    $('amount').max = String(boot.limits.maxTrade);
    $('connection-pill').textContent = !boot.configured ? 'API EKSİK' : !boot.storageReady ? 'VOLUME EKSİK' : 'CANLI İŞLEM HAZIR';
    $('connection-pill').classList.toggle('error', !boot.configured || !boot.storageReady);
    await Promise.all([
      loadInstruments(),
      boot.configured ? loadBots() : Promise.resolve($('bots').innerHTML = '<div class="empty-state">OKX API bilgileri Railway değişkenlerinde eksik.</div>')
    ]);
  } catch (error) { toast(error.message, true); }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method:'POST', body:{ password: $('password').value } });
    $('password').value = '';
    await initialize();
  } catch (error) { $('login-error').textContent = error.message; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST', body:{} }); } catch { /* Oturum bitmiş olabilir. */ }
  location.reload();
});
$('grid-form').addEventListener('input', preview);
$('grid-form').addEventListener('change', preview);
$('grid-form').addEventListener('submit', startBot);
$('pair').addEventListener('change', refreshTicker);
document.querySelectorAll('input[name="direction"]').forEach(input => input.addEventListener('change', updateDirectionHelp));
$('refresh').addEventListener('click', loadBots);
$('bots').addEventListener('click', event => {
  const view = event.target.closest('[data-view]');
  const stop = event.target.closest('[data-stop]');
  if (view) showBot(view.dataset.view);
  if (stop) stopBot(stop.dataset.stop);
});
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
setInterval(() => { if (!$('app').classList.contains('hidden') && !document.hidden && state.configured) loadBots(); }, 5000);
initialize();
