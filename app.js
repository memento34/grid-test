const $ = id => document.getElementById(id);
const state = { csrf: '', configured: false, limits: null, last: null, botId: null, instruments: [] };
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
    neutral: 'Anlık fiyatın altındaki seviyeler long, üstündekiler short. Ayırıcı fiyatı OKX başlangıç anında belirler.'
  };
  $('direction-help').textContent = help[selectedDirection()];
  preview();
}

function preview() {
  const f = getForm();
  const lower = Number(f.minPx), upper = Number(f.maxPx), grids = Number(f.gridNum);
  const valid = lower > 0 && upper > lower && Number.isInteger(grids) && grids >= 2 && grids <= 100;
  const margin = Number(f.margin), leverage = Number(f.leverage);
  const estimatedNotional = margin > 0 && leverage > 0 && grids > 0 ? margin * leverage / grids : 0;
  const instrument = state.instruments.find(item => item.instId === f.instId);
  const base = String(f.instId || '').split('-')[0];
  const minimumNotional = instrument?.ctValCcy === base && lower > 0
    ? Number(instrument.minSz) * Number(instrument.ctVal) * lower : NaN;
  const belowMinimum = estimatedNotional > 0 && Number.isFinite(minimumNotional) && minimumNotional > 0 && estimatedNotional < minimumNotional;
  const budget = $('budget-note');
  budget.classList.toggle('warning', belowMinimum);
  budget.textContent = estimatedNotional > 0
    ? 'Yaklaşık emir bütçesi: ' + fmt(estimatedNotional) + ' USDT/grid.' +
      (Number.isFinite(minimumNotional) && minimumNotional > 0
        ? ' Bu paritenin alt fiyattaki en küçük sözleşmesi yaklaşık ' + fmt(minimumNotional) + ' USDT.'
        : '') +
      (belowMinimum ? ' Bu ayar muhtemelen OKX minimumunun altında; grid sayısını azaltın veya marjini artırın.' : ' OKX yedek marjin ayırdığı için kesin asgari tutar daha yüksek olabilir.')
    : 'Grid başına yaklaşık bütçeyi görmek için marjin, kaldıraç ve grid sayısı girin.';
  $('preview-pair').textContent = f.instId || '—';
  $('preview-upper').textContent = valid ? fmt(upper) : '—';
  $('preview-lower').textContent = valid ? fmt(lower) : '—';
  $('last-price').textContent = state.last ? fmt(state.last) : '—';
  if (!valid) {
    $('ladder').innerHTML = '<div class="empty-ladder">Fiyat sınırlarını girerek grid seviyelerini görüntüleyin.</div>';
    $('preview-note').textContent = 'Fiyat seviyeleri yaklaşık gösterilir. Son emirleri OKX oluşturur.';
    return;
  }
  const levels = [];
  for (let i = grids; i >= 0; i--) {
    const r = i / grids;
    levels.push(f.runType === '2' ? lower * (upper / lower) ** r : lower + (upper - lower) * r);
  }
  const chosen = levels.length <= 12 ? levels : levels.filter((_, i) => i === 0 || i === levels.length - 1 || i % Math.ceil(levels.length / 11) === 0);
  const mid = (lower + upper) / 2;
  const last = Number(state.last);
  const pivot = selectedDirection() === 'neutral' && Number.isFinite(last) && last > 0 ? last : mid;
  $('ladder').innerHTML = chosen.map(price => {
    const type = selectedDirection() === 'long' ? 'buy' : selectedDirection() === 'short' ? 'sell' : price < pivot ? 'buy' : 'sell';
    const label = selectedDirection() === 'long' ? 'LONG' : selectedDirection() === 'short' ? 'SHORT' : type === 'buy' ? 'LONG' : 'SHORT';
    return '<div class="ladder-row"><span class="ladder-line"></span><strong>' + fmt(price) + '</strong><span class="tag ' + type + '">' + label + '</span></div>';
  }).join('');
  $('preview-note').textContent = selectedDirection() === 'neutral'
    ? 'Matematiksel orta: ' + fmt(mid) + ' USDT. OKX nötr botu emirleri başlangıçtaki piyasa fiyatına (' + (state.last ? fmt(state.last) : 'yükleniyor') + ') göre ayırır; bu fiyatlar farklı olabilir.'
    : grids + ' grid · ' + (f.runType === '2' ? 'eşit yüzde' : 'eşit fiyat') + ' aralığı. Gösterim yaklaşık; marjin dağılımını ve emirleri OKX hesaplar.';
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
  return '<div class="bot-card">' +
    '<div><strong>' + esc(bot.instId) + '</strong><small>Bot #' + esc(bot.algoId) + ' · ' + esc(bot.state || 'aktif') + '</small></div>' +
    '<div><span class="direction-badge ' + esc(bot.direction) + '">' + directionName(bot.direction) + '</span><small>' + fmt(bot.minPx) + ' – ' + fmt(bot.maxPx) + ' USDT</small></div>' +
    '<div class="bot-meta">' + esc(bot.gridNum) + ' grid · ' + esc(bot.lever) + '×<small>Marjin: ' + fmt(bot.sz) + ' USDT</small></div>' +
    '<div class="bot-actions"><button class="secondary" data-view="' + esc(bot.algoId) + '">Emirler</button><button class="secondary" data-stop="' + esc(bot.algoId) + '">Durdur</button></div></div>';
}

async function loadBots() {
  try {
    const data = await api('/api/bots');
    $('active-count').textContent = String(data.bots.length);
    $('bots').innerHTML = data.bots.length ? data.bots.map(botCard).join('') : '<div class="empty-state">Bu panelden açılmış aktif grid botu yok.</div>';
  } catch (error) {
    $('bots').innerHTML = '<div class="empty-state">' + esc(error.message) + '</div>';
    toast(error.message, true);
  }
}

function closeModal() { $('modal').classList.add('hidden'); state.botId = null; }

async function showBot(algoId, type = 'live') {
  state.botId = algoId;
  $('modal').classList.remove('hidden');
  $('modal-body').innerHTML = '<p>Emirler yükleniyor...</p>';
  try {
    const data = await api('/api/bots/' + encodeURIComponent(algoId) + '?type=' + type);
    if (state.botId !== algoId) return;
    const bot = data.bot;
    const rows = data.orders.length ? data.orders.map(order =>
      '<div class="order-row"><span>' + esc(order.side || order.posSide || '—') + '</span><span>' + fmt(order.px || order.avgPx || order.fillPx) + '</span><span>' + fmt(order.sz || order.fillSz || order.accFillSz) + '</span></div>'
    ).join('') : '<div class="empty-state">Bu bölümde henüz emir yok.</div>';
    $('modal-body').innerHTML =
      '<p class="eyebrow">OKX GRID BOTU</p><h2>' + esc(bot.instId) + ' · ' + directionName(bot.direction) + '</h2>' +
      '<p>Bot #' + esc(bot.algoId) + ' · ' + esc(bot.state || 'aktif') + '</p>' +
      '<div class="modal-grid"><div><small>ALT / ÜST FİYAT</small><strong>' + fmt(bot.minPx) + ' – ' + fmt(bot.maxPx) + '</strong></div>' +
      '<div><small>GRID / KALDIRAÇ</small><strong>' + esc(bot.gridNum) + ' / ' + esc(bot.lever) + '×</strong></div>' +
      '<div><small>MARJİN</small><strong>' + fmt(bot.sz) + ' USDT</strong></div>' +
      '<div><small>TOPLAM P/L</small><strong>' + fmt(bot.totalPnl) + ' USDT</strong></div></div>' +
      '<div class="modal-actions"><button class="secondary" data-type="live">Açık emirler</button><button class="secondary" data-type="filled">Dolan emirler</button></div>' +
      '<div class="orders"><p>' + (type === 'filled' ? 'Son dolan emirler' : 'Son açık emirler') + ' · OKX en fazla 100 kayıt döndürür.</p>' + rows + '</div>';
  } catch (error) { $('modal-body').innerHTML = '<p>' + esc(error.message) + '</p>'; }
}

async function stopBot(algoId) {
  const choice = window.prompt('Botu durdurma şekli:\n1 = Botu durdur ve pozisyonu piyasa emriyle kapat\n2 = Botu durdur, açık pozisyonu bırak\n\n1 veya 2 yazın:', '2');
  if (choice === null) return;
  if (!['1', '2'].includes(choice.trim())) return toast('Durdurma için 1 veya 2 seçin.', true);
  const stopType = choice.trim();
  const note = stopType === '1' ? 'Açık pozisyon piyasa emriyle kapanabilir.' : 'Açık pozisyon OKX hesabında kalır; kendiniz yönetmeniz gerekir.';
  if (!window.confirm('Bot #' + algoId + ' durdurulacak. ' + note + ' Devam edilsin mi?')) return;
  try {
    await api('/api/bots/' + encodeURIComponent(algoId) + '/stop', { method:'POST', body:{ stopType } });
    toast('Bot durdurma isteği OKX tarafından kabul edildi.');
    await loadBots();
  } catch (error) { toast(error.message, true); }
}

async function startBot(event) {
  event.preventDefault();
  if (!state.configured) return toast('Önce Railway değişkenlerine OKX API bilgilerini girin.', true);
  const f = getForm();
  $('create-error').classList.add('hidden');
  $('create-error').textContent = '';
  const lower = Number(f.minPx), upper = Number(f.maxPx), margin = Number(f.margin);
  const leverage = Number(f.leverage), count = Number(f.gridNum), last = Number(state.last);
  if (!f.instId || !['long', 'short', 'neutral'].includes(f.direction)) return toast('Parite ve yön seçin.', true);
  if (!(lower > 0 && upper > lower && last > lower && last < upper)) return toast('Anlık fiyat alt ve üst fiyatın içinde olmalı.', true);
  if (!(margin > 0 && margin <= state.limits.maxMargin && leverage >= 1 && leverage <= state.limits.maxLeverage && count >= 2 && count <= 100))
    return toast('Marjin, kaldıraç veya grid sayısı izin verilen aralığın dışında.', true);
  let message = f.instId + ' için ' + directionName(f.direction) + ' grid başlatılacak.\nAralık: ' + fmt(lower) + '–' + fmt(upper) + ' USDT\n' + count + ' grid · ' + fmt(margin) + ' USDT toplam marjin · ' + leverage + '× kaldıraç.\n\nBu gerçek işlemdir.';
  if ($('budget-note').classList.contains('warning')) message += '\n\nUyarı: emir başına tahmini bütçe paritenin en küçük sözleşme değerinin altında. OKX botu reddedebilir.';
  if (f.direction === 'neutral') message += '\n\nNötr ayrımı OKX tarafından anlık fiyata (' + fmt(last) + ') göre yapılır. Aralığın matematiksel ortası ' + fmt((lower + upper) / 2) + '.';
  if (!window.confirm(message)) return;
  const button = $('create-button');
  button.disabled = true;
  button.textContent = 'Bot oluşturuluyor...';
  try {
    const result = await api('/api/bots', { method:'POST', body:f, headers:{ 'Idempotency-Key': crypto.randomUUID() } });
    toast('Grid botu OKX üzerinde oluşturuldu: #' + (result.algoId || result.bot?.algoId || '—'));
    await loadBots();
  } catch (error) {
    $('create-error').textContent = error.message;
    $('create-error').classList.remove('hidden');
    $('create-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(error.message, true);
  }
  finally { button.disabled = false; button.innerHTML = 'Canlı grid botunu başlat <span>↗</span>'; }
}

async function initialize() {
  try {
    const boot = await api('/api/bootstrap');
    state.configured = boot.configured;
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
    $('margin-limit').textContent = fmt(boot.limits.maxMargin) + ' USDT';
    $('leverage').max = String(boot.limits.maxLeverage);
    $('margin').max = String(boot.limits.maxMargin);
    $('connection-pill').textContent = boot.configured ? 'CANLI İŞLEM HAZIR' : 'API EKSİK';
    $('connection-pill').classList.toggle('error', !boot.configured);
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
$('modal-body').addEventListener('click', event => {
  const tab = event.target.closest('[data-type]');
  if (tab && state.botId) showBot(state.botId, tab.dataset.type);
});
$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
setInterval(() => { if (!$('app').classList.contains('hidden') && !document.hidden && state.configured) loadBots(); }, 30000);
initialize();
