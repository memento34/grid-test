'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=(v,d)=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':Number(v)!==0&&Math.abs(Number(v))<1e-8&&d===undefined?String(v).replace('.',','):Number(v).toLocaleString('tr-TR',{minimumFractionDigits:d??2,maximumFractionDigits:d??8});
const money=v=>v===null||v===undefined?'—':(Number(v)>0?'+':'')+n(v);
const cls=v=>Number(v)>0?'positive':Number(v)<0?'negative':'';
const date=t=>t?new Date(t).toLocaleString('tr-TR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const states={running:'ÇALIŞIYOR',paused:'DURAKLATILDI',stopping:'ÇIKIŞ BEKLİYOR',stopped:'TAMAMLANDI'};
const direction={long:'Long',short:'Short',neutral:'Nötr'};
let config={},state=null,selected='',refreshing=false,previewSignature='',pending=false;
async function api(url,method='GET',body){
  const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(method==='POST'?{'X-CSRF-Token':config.csrf||''}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  const result=await response.json();
  if(!response.ok){if(response.status===401&&url!=='/api/login')showLogin();throw new Error(result.error||'İstek başarısız.');}return result;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;setTimeout(()=>$('toast').hidden=true,6000);}
function showLogin(){$('workspace').hidden=true;$('loginView').hidden=false;}
async function boot(){
  try{config=await api('/api/bootstrap');if(!config.loggedIn){showLogin();return;}
    $('loginView').hidden=true;$('workspace').hidden=false;$('modeBadge').textContent=config.demo?'DEMO':'CANLI';$('modeBadge').className='badge'+(config.demo?'':' live');$('siteLabel').textContent=config.site.toUpperCase()+' · REST v5';$('liveConfirm').hidden=config.demo;await refresh();
  }catch(e){$('loginError').textContent=e.message;}
}
function metric(id,value){$(id).textContent=money(value);$(id).className=cls(value);}
function render(){
  const bots=state.bots,complete=bots.every(b=>b.pnl.complete),hasUpl=bots.every(b=>b.pnl.unrealized!==null);
  const aggregate=key=>bots.reduce((s,b)=>s+Number(b.pnl[key]||0),0);
  metric('totalPnl',bots.every(b=>b.pnl.total!==null)?aggregate('total'):null);metric('realizedPnl',complete?aggregate('realized'):null);metric('unrealizedPnl',hasUpl?aggregate('unrealized'):null);
  $('totalHint').textContent=complete?'Gerçekleşmiş + gerçekleşmemiş':'Muhasebe verisi eksik · detayları kontrol edin';
  $('activityMetric').innerHTML=bots.reduce((s,b)=>s+b.activeOrders.length,0)+' <i>/</i> '+bots.reduce((s,b)=>s+b.levels.reduce((a,l)=>a+l.cycle,0),0);
  $('botCount').textContent=bots.filter(b=>b.status==='running').length+' çalışan · '+bots.filter(b=>['paused','stopping'].includes(b.status)).length+' bekleyen strateji';$('strategyCount').textContent=bots.length;
  const warnings=[!config.storageReady?'Kalıcı DATA_DIR tanımlı değil. Yeni bot başlatılamaz.':'',!config.configured?'OKX API veya panel yapılandırması eksik.':'',state.health.fatal,state.health.ledgerError,bots.some(b=>b.ownershipLost)?'Pozisyon sahipliği uyuşmazlığı var. OKX üzerinden inceleme gerekiyor.':''].filter(Boolean);
  $('globalWarning').hidden=!warnings.length;$('globalWarning').textContent=warnings.join('\n');
  $('botList').innerHTML=bots.length?bots.slice().reverse().map(b=>{
    const p=b.pnl,filled=b.levels.filter(l=>Number(l.remaining)>0).length;
    return '<article class="bot-card"><div class="bot-top"><div class="symbol-wrap"><div class="symbol-icon">'+esc(b.instId.slice(0,1))+'</div><div><div class="symbol">'+esc(b.instId.replace('-SWAP',''))+'</div><p>'+esc(direction[b.direction])+' · Cross 10× · '+b.gridNum+' grid</p></div></div><span class="state-pill '+esc(b.status)+'">'+esc(states[b.status]||b.status)+'</span></div><div class="bot-stats"><div><span class="stat-label">Net PnL · USDT</span><span class="stat-value '+cls(p.total)+'">'+money(p.total)+'</span></div><div><span class="stat-label">Komisyon / iade</span><span class="stat-value '+cls(p.fees)+'">'+money(p.fees)+'</span></div><div><span class="stat-label">Funding · USDT</span><span class="stat-value '+cls(p.funding)+'">'+money(p.funding)+'</span></div></div><div class="bot-sub"><span>'+n(b.minPx)+' — '+n(b.maxPx)+'</span><span>'+filled+'/'+b.maxLevels+' açık seviye · '+b.activeOrders.length+' emir</span></div>'+(!p.complete?'<p class="bot-error">PnL kısmi: '+esc(p.issues.join(' · '))+'</p>':'')+(b.error?'<p class="bot-error">'+esc(b.error)+'</p>':'')+'<div class="bot-actions">'+(b.status==='running'?'<button class="ghost" data-action="pause" data-id="'+b.id+'">Ⅱ Duraklat</button>':b.status==='paused'?'<button class="ghost" data-action="resume" data-id="'+b.id+'">▷ Devam et</button>':'')+(b.status!=='stopped'&&b.status!=='stopping'?'<button class="ghost" data-action="stop" data-id="'+b.id+'">Girişleri bitir</button>':'')+'<button class="ghost detail-button" data-action="detail" data-id="'+b.id+'">Detaylar ↗</button></div></article>';
  }).join(''):'<div class="empty"><div class="empty-icon">▦</div><h3>İlk gridin için hazır</h3><p>Bir fiyat aralığı belirle. Emir dolumları ve gerçek net performans burada görünür.</p><button class="primary" data-action="create">＋ Grid oluştur</button></div>';
  const fresh=state.health.lastTick&&Date.now()-state.health.lastTick<60000;
  $('syncStatus').textContent=fresh?'Senkronize':'Senkronizasyon bekleniyor';$('healthDot').className='dot'+(fresh&&!state.health.fatal?'':' warning');
  const tg=state.health.telegram;
  $('healthRows').innerHTML=[['Emir döngüsü',fresh?'Güncel':'Bekliyor'],['Son döngü süresi',n(state.health.duration/1000,1)+' sn'],['Muhasebe',state.health.ledgerError?'Veri eksik':date(state.health.ledgerThrough)],['Telegram',tg.error?'İletim hatası':tg.enabled?'Bağlantı ayarlı':'Ayarlanmadı'],['Kalıcı kayıt',state.health.fatal?'Yazma hatası':config.storageReady?'Yol tanımlı':'Eksik']].map(([k,v])=>'<div class="health-row"><span>'+k+'</span><b>'+esc(v)+'</b></div>').join('');
  $('telegramInfo').textContent=tg.error||(!tg.enabled?'TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID değişkenlerini ekleyin.':'Aynı hata en fazla saatlik; mesajlar en az 5 dakika arayla birleştirilir.');
  $('lastUpdate').textContent='Panel: '+new Date().toLocaleTimeString('tr-TR');renderEvents();if(selected)renderDetail();
}
function renderEvents(){
  if(!state)return;const filter=$('eventFilter').value,rows=state.events.filter(e=>filter==='all'||e.severity===filter||e.code===filter);
  $('eventRows').innerHTML=rows.length?rows.slice(0,60).map(e=>'<tr><td>'+date(e.at)+'</td><td>'+esc(e.instId.replace('-SWAP','')||'Sistem')+'</td><td><span class="event-label '+esc(e.severity)+'">'+esc(({fill:'DOLUM',order:'EMİR',created:'BAŞLATMA',pause:'DURAKLATMA',stop:'BİTİRME',stopped:'TAMAMLANDI',resume:'DEVAM'})[e.code]||e.code.toUpperCase())+'</span></td><td>'+esc(e.message)+'</td></tr>').join(''):'<tr><td colspan="4">Henüz bu filtreye uygun kayıt yok.</td></tr>';
}
function renderDetail(){
  const b=state.bots.find(b=>b.id===selected);if(!b)return;const p=b.pnl;
  $('detailPanel').hidden=false;$('detailTitle').textContent=b.instId+' · '+direction[b.direction];
  const lo=Number(b.minPx),hi=Number(b.maxPx),price=Number(b.ticker?.last),x=value=>35+Math.max(0,Math.min(1,(value-lo)/(hi-lo)))*630;
  const chart='<div class="chart"><svg viewBox="0 0 700 150" role="img" aria-label="Grid seviyeleri ve son piyasa fiyatı"><line class="grid-line" x1="35" y1="75" x2="665" y2="75"/>'+b.levels.map(l=>'<line class="level-line" x1="'+x(Number(l.entryPx))+'" y1="'+(l.phase==='idle'?65:45)+'" x2="'+x(Number(l.entryPx))+'" y2="85"/>').join('')+(Number.isFinite(price)?'<line class="price-line" x1="'+x(price)+'" y1="27" x2="'+x(price)+'" y2="110"/><text class="market-label" text-anchor="middle" x="'+x(price)+'" y="19">Son: '+n(price)+'</text>':'')+'<text x="35" y="132">'+n(lo)+'</text><text x="665" y="132" text-anchor="end">'+n(hi)+'</text></svg></div>';
  $('detailBody').innerHTML='<div class="pnl-breakdown">'+[['Brüt gerçekleşmiş',p.gross],['Komisyon / iade',p.fees],['Funding',p.funding],['Diğer hareketler',p.other],['Net gerçekleşmiş',p.realized],['Gerçekleşmemiş',p.unrealized],['Toplam net',p.total],['Tamamlanan döngü',b.levels.reduce((s,l)=>s+l.cycle,0)]].map(([k,v])=>'<div><span class="stat-label">'+k+'</span><span class="stat-value '+cls(v)+'">'+money(v)+'</span></div>').join('')+'</div><p class="detail-info">'+(p.complete?'Muhasebe kayıtları dolumlarla eşleşiyor.':'KISMİ VERİ: '+esc(p.issues.join(' · ')))+' · Son muhasebe: '+date(p.asOf)+'<br>Gerçekleşmemiş PnL OKX mark fiyatına dayanır. Funding bot toplamındadır. Seviye PnL’si, ilgili emirlere yazılan OKX kâr/zararı ve komisyonudur; OKX birleşik pozisyon maliyetini kullandığından bağımsız grid çifti kârından farklı olabilir.</p>'+chart+'<h3>Açık emirler</h3><div class="table-scroll"><table><thead><tr><th>Seviye</th><th>İşlem</th><th>Dolum / miktar</th><th>Durum / emir kimliği</th></tr></thead><tbody>'+ (b.activeOrders.length?b.activeOrders.map(o=>'<tr><td>#'+(o.level+1)+'</td><td>'+(o.purpose==='entry'?'Giriş':'Kâr alma')+'</td><td>'+esc(o.fill)+' / '+esc(o.sz)+'</td><td>'+esc(o.state)+' · '+esc(o.ordId||o.clOrdId)+'</td></tr>').join(''):'<tr><td colspan="4">Açık emir yok.</td></tr>')+'</tbody></table></div><h3>Grid seviyeleri</h3><div class="table-scroll"><table><thead><tr><th>Seviye / yön</th><th>Giriş → çıkış</th><th>Açık sözleşme</th><th>Döngü</th><th>Emirlere yazılan net PnL*</th></tr></thead><tbody>'+b.levels.map(l=>'<tr><td>#'+(l.index+1)+' · '+direction[l.direction]+'</td><td>'+esc(l.entryPx)+' → '+esc(l.exitPx)+'</td><td>'+esc(l.remaining)+' <span class="level-status">'+({idle:'bekliyor',entering:'giriş emri',exiting:'çıkış izleniyor'})[l.phase]+'</span></td><td>'+l.cycle+'</td><td class="'+cls(p.grid[l.index])+'">'+money(p.grid[l.index]||'0')+'</td></tr>').join('')+'</tbody></table></div><p class="detail-info">* Funding dahil değildir. Kısmi veri uyarısı varken seviye değerleri de eksik olabilir. Başlangıç: '+date(b.createdAt)+' · Bot: '+esc(b.id)+'</p>';
}
async function refresh(){if(refreshing||$('workspace').hidden)return;refreshing=true;try{state=await api('/api/state');render();}catch(e){$('globalWarning').hidden=false;$('globalWarning').textContent='VERİ GÜNCELLENEMİYOR: '+e.message+' Ekrandaki değerler eski olabilir.';$('syncStatus').textContent='Bağlantı kesildi';}finally{refreshing=false;}}
async function openCreate(){
  $('createError').textContent='';$('previewResult').hidden=true;$('startButton').disabled=true;previewSignature='';$('createDialog').showModal();
  try{const r=await api('/api/instruments');$('instrument').innerHTML=r.instruments.map(i=>'<option>'+esc(i.instId)+'</option>').join('');$('createForm').elements.amountPerTrade.max=config.limits.maxTrade;}catch(e){$('createError').textContent=e.message;}
}
const formData=()=>Object.fromEntries(new FormData($('createForm')));
const signature=data=>JSON.stringify(Object.entries(data).filter(([k])=>k!=='confirm'));
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await api('/api/login','POST',{password:$('password').value});$('password').value='';$('loginError').textContent='';await boot();}catch(error){$('loginError').textContent=error.message;}finally{button.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await api('/api/logout','POST',{});showLogin();}catch(e){toast(e.message);}});
$('refresh').addEventListener('click',refresh);$('eventFilter').addEventListener('change',renderEvents);$('newBot').addEventListener('click',openCreate);$('closeCreate').addEventListener('click',()=>{if(!pending)$('createDialog').close();});$('closeDetail').addEventListener('click',()=>{selected='';$('detailPanel').hidden=true;});
$('botList').addEventListener('click',async e=>{
  const button=e.target.closest('[data-action]');if(!button)return;const {action,id}=button.dataset;
  if(action==='create')return openCreate();if(action==='detail'){selected=id;renderDetail();$('detailPanel').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(action==='stop'&&!confirm('Yeni girişler iptal edilecek. Açık pozisyonlar kâr alma fiyatına ulaşana kadar açık kalacak. Devam edilsin mi?'))return;
  button.disabled=true;try{await api('/api/bots/'+id+'/'+action,'POST',{});toast('Komut kaydedildi. Sonraki emir döngüsünde uygulanacak.');await refresh();}catch(error){toast(error.message);}finally{button.disabled=false;}
});
$('createForm').addEventListener('input',()=>{if(previewSignature!==signature(formData())){$('startButton').disabled=true;$('previewResult').hidden=true;}});
$('previewButton').addEventListener('click',async()=>{
  if(!$('createForm').reportValidity())return;const data=formData();$('previewButton').disabled=true;$('createError').textContent='';
  try{const p=await api('/api/preview','POST',data);if(signature(data)!==signature(formData()))return;previewSignature=signature(data);$('previewResult').innerHTML='<div class="preview-summary"><b>'+p.settings.gridNum+' grid · gerçek aralık %'+n(p.settings.effectivePct,3)+'</b><br>Son fiyat: '+n(p.ticker.last)+' USDT<br>En fazla başlangıç emir değeri: '+n(p.maxEntryNotional)+' USDT<br>Yaklaşık başlangıç marjini: '+n(p.approxInitialMargin)+' USDT (+ komisyon / güvenlik payı)<br>Başlatırken pozisyon, emirler ve bakiye yeniden kontrol edilir.</div>';$('previewResult').hidden=false;$('startButton').disabled=false;}catch(e){$('createError').textContent=e.message;}finally{$('previewButton').disabled=false;}
});
$('createForm').addEventListener('submit',async e=>{
  e.preventDefault();if(pending)return;const data=formData();if(signature(data)!==previewSignature){$('createError').textContent='Önce güncel planı hesaplayın.';return;}if(!config.demo&&data.confirm!=='CANLI'){$('createError').textContent='CANLI yazarak onaylayın.';return;}
  pending=true;$('startButton').disabled=true;$('closeCreate').disabled=true;$('createError').textContent='Hesap ve emir kontrolleri yapılıyor…';
  try{const r=await api('/api/bots','POST',data);selected=r.id;$('createDialog').close();toast('Grid kaydedildi. Emir yönetimi başlıyor.');await refresh();}catch(e){$('createError').textContent=e.message+' Başlatma yanıtı belirsizse tekrar denemeden önce strateji listesini yenileyin.';await refresh();}finally{pending=false;$('closeCreate').disabled=false;previewSignature='';}
});
boot();setInterval(refresh,5000);
