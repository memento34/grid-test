# Grid Control 3 — OKX + Telegram

Tek dosya uygulama: **okx-grid-control-v3.mjs**. Sunucu, emir motoru, OKX istemcisi, Telegram ve arayüz bu dosyanın içinde. Harici npm bağımlılığı gerektirmez. ZIP ayrıca inceleme için modüler kaynakları, otomatik testleri ve değerlendirme raporunu içerir.

Bu sürüm, v2.1'deki dinamik normal emirli grid yaklaşımını korur: USDT sürekli vadeli, cross 10×, en yakın 1–5 açık seviye, geometrik grid. OKX'in hazır grid botunu başlatmaz. Kâr ya da hatasız çalışma garantisi vermez.

## Hızlı kurulum

1. Node.js **22 veya daha yeni** kurun. ZIP'i bir klasöre açın.
2. `.env.example` dosyasını `.env` olarak kopyalayın. OKX anahtarlarını ve güçlü bir `DASHBOARD_PASSWORD` girin.
3. İlk çalıştırmada `OKX_DEMO=true` bırakın ve **OKX demo işlem API anahtarı** kullanın. Gerçek ve demo anahtarlar birbirinin yerine geçmez.
4. `DATA_DIR` için kalıcı bir klasör seçin. Örnek `./data-demo`.
5. Çalıştırın:

```sh
node --env-file=.env okx-grid-control-v3.mjs
```

Alternatif: `npm start` (aynı tek dosyayı çalıştırır). `npm install` gerekmez.

Tarayıcıdan [yerel paneli](http://localhost:3000) açın. Panel şifresiyle giriş yapın, **Yeni grid oluştur → Planı hesapla → Gridi başlat** akışını kullanın. API anahtarlarını tarayıcıya girmeyin; yalnızca sunucunun ortam değişkenlerinde tutun.

**Canlıya geçiş:** demo botlarını tamamlayın, süreci düzgün kapatın, canlı anahtarları girin, `OKX_DEMO=false` yapın ve farklı bir kalıcı `DATA_DIR` seçin. Arayüz canlı başlatma sırasında `CANLI` yazmanızı ister. Bu sürümün hazırlanmasında hesabınıza emir gönderilmedi; gerçek hesap veya gerçek Telegram teslimatı sınanmadı.

## Railway / sunucu

- Başlatma: `node okx-grid-control-v3.mjs` veya `npm start`. Railway Variables kullanıyorsanız `.env` gerekmiyor.
- Volume bağlayın; `DATA_DIR` değerini **gerçek mount yoluna** ayarlayın. Değişkenin tanımlı olması tek başına disk kalıcılığını kanıtlamaz.
- HTTPS yayınında `NODE_ENV=production` kullanın; oturum çerezi Secure olur. Yerel HTTP'de development kullanın.
- **Tek replica** çalıştırın. Aynı hesap/pariteyi başka sunucudan da yönetmeyin. Volume kilidi yalnızca aynı klasörü kullanan süreçleri engeller; ayrı sunucuları engellemez.
- Servis uykuya geçmemeli. `/health` süreç/kayıt durumunu, `/ready` son döngünün güncelliğini bildirir.
- `OKX_SITE=global|eea|us|tr` hesabın açıldığı bölgeyle uyuşmalıdır. Bir bölgede vadeli işlem veya ilgili endpoint desteklenmiyorsa uygulama bu kontrolleri atlamaz.
- `MAX_TRADE_USDT` emir başına üst sınırdır (varsayılan 100). `MAX_ACTIVE_BOTS` varsayılan 5; `POLL_MS` varsayılan 3000. Döngü tamamlandıktan sonra bu süre beklenir; çok emir veya API gecikmesi gerçek aralığı uzatır.

## v2.1'den geçiş — önemli

**Açık v2 botları varken eski servisi bu sürümle değiştirmeyin.** v2'nin `manual-grids.json` yapısı bu sürümün dolum ve muhasebe günlüğüne yeterli bilgi sağlamaz.

1. v2 arayüzünde yeni girişleri bitirin; kâr alma emirleri dolup pozisyonlar kapansın. Pozisyonu kendiniz yönetiyorsanız bunu OKX'te ayrıca kontrol edin.
2. OKX'te eski paritenin normal/algo emirleri ve pozisyonlarının sıfır olduğunu doğrulayın.
3. Eski süreci kapatın; dosyalarını yedekleyin. **v3 için yeni veri klasörü** kullanın.
4. v3'te yeni bot oluşturun. Eski kazançlar v3'e otomatik taşınmaz.

Kayıt klasöründe eski `manual-grids.json` bulunursa uygulama başlamayı reddeder. Bu, eski emirleri yanlışlıkla sahipsiz bırakmamak için bilinçli davranıştır.

## Telegram — yalnızca ciddi hatalar

1. Telegram'da resmi **@BotFather** ile `/newbot` oluşturun.
2. Token'ı `TELEGRAM_BOT_TOKEN` olarak sunucuya ekleyin.
3. Yeni botunuzla özel sohbet açıp `/start` gönderin.
4. Yerelde chat ID öğrenmek için:

```sh
node --env-file=.env okx-grid-control-v3.mjs --telegram-chat-id
```

Bu komut gelen güncellemelerden chat ID listesini okur; mesaj göndermez ve işlem motorunu başlatmaz. Çıkan size ait `chatId` değerini `TELEGRAM_CHAT_ID` olarak yazın, servisi yeniden başlatın. Başka bir uygulamanın webhook kullandığı bot yerine bu iş için ayrı bir Telegram botu kullanın. Telegram kişisel `api_id` / `api_hash` bilgileri gerekmiyor.

Bildirimler: belirsiz emir sonucu, reddedilen kâr alma/giriş emri, kalıcı emir/API sorgu sorunu, pozisyon veya sahiplik uyuşmazlığı, karşılanamayan küçük dolum, kalıcı disk sorunu, muhasebe kesintisi, zarar eşiği ve açık risk varken servis kapanması.

- Başarılı dolumlar, her döngü ve olağan durum güncellemeleri **Telegram'a gönderilmez**.
- İlk uygun ciddi olay mesajı hemen hazırlanır. API geçici sorunları için 30 saniye, pozisyon mutabakatı için 15 saniye, muhasebe kesintisi için 90 saniye beklenir.
- Mesajlar **en az 5 dakika arayla** toplu gönderilir. Bu süre içinde yeni bir ciddi hata da bir sonraki toplu mesaja kalabilir.
- Aynı hata varsayılan **60 dakikada en fazla bir** tekrar bildirimidir; `TELEGRAM_COOLDOWN_MINUTES` en az 15 olabilir. Arayüzdeki kısa açıklama varsayılan 60 dakikayı anlatır.
- Tekrar bastırma durumu kalıcı dosyada saklanır. Telegram 429 yanıtında `retry_after` uygulanır; diğer teslimat hatalarında en az 60 saniye beklenir.
- Anahtarlar mesaj metninden temizlenir; HTML/Markdown parse mode kullanılmaz.
- Panelde “Bağlantı ayarlı” olması token/chat ID'nin teslimat testinden geçtiği anlamına gelmez. Gönderim sorunu olursa panelde görünür.

**Sunucu tamamen kapalı, ağ tamamen kesik veya süreç henüz başlatılamıyorsa kendi Telegram bildirimini garanti edemez.** Harici uptime izleme ayrı bir sistem gerektirir. Telegram bot token'ınızı sohbetlerde paylaşmayın.

## Emirlerin çalışma biçimi

- Giriş **post-only**: emir borsaya vardığında piyasa yapıcı olamıyorsa borsa iptal edebilir. Bu normal bir sonuçtur. Çıkış **limit**; gerektiğinde taker dolabilir.
- Gönderimden **önce** benzersiz `clOrdId` ve emir niyeti diske yazılır. Ağ kopması, 50004, 5xx, bozuk yanıt veya kayıp emir kimliğinde sonuç belirsiz sayılır. Aynı emir körlemesine yeniden gönderilmez.
- Kümülatif dolumdaki sadece yeni artış uygulanır. Kısmi girişte kalan giriş iptal istenir; doğrulanan doluma aynı döngüde çıkış kurulabilir. İptal sırasında ek dolum gelirse sadece yeni açık miktar için ek çıkış konur.
- Kısmi çıkışın kalan rezervi korunur. İptal edilen çıkışın yalnızca açık kalan miktarı yeniden gönderilir. İptal kabulü, emir iptal olmuş sayılmaz; terminal durum beklenir.
- Beş seviye sınırı, iptal onayı bekleyen girişleri de içerir. Net moddaki çıkışlar `reduceOnly`; hedge modunda kapama yönü ve `posSide` kullanılır.
- Tek emrin sorgu hatası diğer seviyelerin doğrulanmış kâr alma yönetimini tek başına durdurmaz. Ancak toplam pozisyon uyuşmuyorsa yeni emirler bekler.
- Yeni girişlerden önce pozisyon, emir sahipliği, fiyat güncelliği, kaldıraç ve pozisyon modu kontrol edilir. Harici algo/bot ve sözleşme özellikleri de periyodik kontrol edilir.
- Başlangıçta açık pozisyon, normal emir, ilgili algo veya yerel OKX grid botu varsa yeni bot reddedilir. Ayrı alt hesap ve pariteyi yalnız bu uygulamaya ayırmak PnL ayrımı için gereklidir.

**Duraklat:** girişleri iptal eder; çıkışları yönetmeye devam eder. **Girişleri bitir:** aynı şekilde girişleri keser ve bütün pozisyonlar hedef çıkışlarla kapanınca tamamlanır. **Bu düğmeler piyasa fiyatından anında pozisyon kapatmaz.** Zarar eşiği de giriş durdurma eşiğidir; stop-loss değildir.

Limit çıkışın dolması garanti değildir. Servis kapalıyken yeni giriş dolabilir ve kâr alma emri servis yeniden çalışana kadar kurulamayabilir. Bu sürüm REST ile izler; WebSocket veya borsada duran garantili bir koruma emri eklemez.

## PnL tanımları

| Alan | Hesap |
|---|---|
| Brüt gerçekleşmiş | Bota ait `ordId` kayıtlarının OKX işlem `pnl` toplamı |
| Komisyon / iade | Aynı hareketlerdeki işaretli `fee`; eksi gider, artı rebate |
| Funding | Botun paritesi ve çalışma zamanına ait 173/174 funding hareketlerindeki işaretli `pnl` |
| Net gerçekleşmiş | Brüt PnL + ücret/iade + funding + gösterilen diğer hareketler |
| Gerçekleşmemiş | Pozisyon miktarları mutabık olduğunda OKX `upl` toplamı |
| Toplam net | Veriler doğrulanabiliyorsa net gerçekleşmiş + gerçekleşmemiş |

Muhasebe 30 saniye aralıkla, sayfalama ve `billId` tekrar kontrolüyle okunur. Son 24 saat tekrar sorgulanır; arşiv yerelde korunur. Dolum miktarı ile işlem hareketlerinin miktarı karşılaştırılır. API hatası, eksik ücret alanı, eksik dolum hareketi veya yabancı işlem varsa **kısmi veri** gösterilir; tam net toplam gösterilmez. Son muhasebe zamanı ayrıca görünür. Borsa verisinin sonradan gelmesi veya düzeltilmesi mümkün olduğundan bu bir denetim / kesin kapanış ekstresi değildir.

Funding'de `balChg` yerine ilgili `pnl` kullanılır: bakiye hareketi her durumda ödenen funding ile aynı olmayabilir. Pozisyonun birikimli `fee`/`realizedPnl` alanları kapanınca sıfırlanabildiğinden bunlar ayrı ayrı tekrar toplanmaz.

Grid seviyelerindeki PnL, o seviyenin emirlerine yazılan OKX PnL + ücrettir. OKX aynı yön pozisyonlarını birleştirilmiş maliyetle tuttuğu için bu değer, bağımsız giriş/çıkış fiyat farkıyla hesaplanan grid çifti kârına eşit olmak zorunda değildir. **Funding seviyelere tahmini dağıtılmaz; bot toplamında gösterilir.** Gelecekteki kapanış komisyonu ve henüz tahakkuk etmemiş funding dahil değildir.

Sınıflandırılamayan hareketler, tasfiye veya harici müdahale varsa ilgili tutar ayrıca gösterilir ve kesin toplam bastırılır. Uzun süre çevrimdışı kalınıp 89 günden büyük veri boşluğu oluşursa otomatik muhasebe durur; borsa arşiviyle manuel inceleme gerekir. Uygulama geçmişte bu uygulama tarafından açılmamış botların kazancını kesin olarak ayıramaz.

## Yeniden başlatma ve hata yönetimi

Normal SIGINT/SIGTERM kapanışında girişler duraklatılır, iptaller denenir, açık çıkışlar korunur; yeniden açılışta mutabakat yapılır. Girişleri yeniden etkinleştirmek için panelde **Devam et** kullanın. Beklenmeyen çökmede kayıtlı emirler yeniden sorgulanır.

`grid-v3.lock` ikinci süreci engeller. Sert çökmeden sonra dosya kalırsa önce **başka hiçbir süreç/replica çalışmadığını** doğrulayın; ardından yalnız bu kilit dosyasını kaldırın. `grid-v3.json` dosyasını silmeyin veya elle emir kimliklerini temizlemeyin. Kilit dosyasını otomatik yaşa göre silmek desteklenmez.

“Emir sonucu belirsiz” kaydı uzun süre sürerse OKX emir geçmişini `clOrdId` / `ordId` ile inceleyin. Bulunamayan bir emri güvenli olduğu varsayımıyla silip tekrar başlatmayın. Sahiplik uyuşmazlığı bilinçli olarak kilitlidir; ayrı bir botu aynı pozisyona bağlayarak devam ettirmeyin. Önce açık emir ve pozisyonların borsadaki gerçek durumunu çözün.

## Testler ve içerik

```sh
npm test
```

33 otomatik test; kısmi giriş/çıkış, geç dolum, iptal yarışı, eşzamanlı dolum sınırı, belirsiz POST, kalıcı kayıt, çökme sonrası toparlanma, net/hedge, dış müdahale, PnL işaretleri, funding, sayfalama, Telegram filtreleri, oturum/CSRF ve canlı onayı senaryolarını kapsar. Bunlar yerel taklit OKX/Telegram yanıtlarıyla çalışır; canlı borsa sertifikasyonu değildir.

Masaüstü (1440 px) ve mobil (390 px) tarayıcı kontrollerinde giriş, detay, plan önizleme, değişen planın onayını geçersizleştirme ve duraklatma denendi; JavaScript konsol hatası görülmedi. Modüler kaynaklar `source/`, testler `source/test/` altındadır. `INCELEME.md` eski sürümdeki bulguları ve sınırları açıklar.

Kaynaklar: [OKX emir API'si](https://www.okx.com/docs-v5/en/), [OKX emir yönetimi](https://www.okx.com/docs-v5/trick_en/), [OKX timeout açıklaması](https://www.okx.com/en-eu/help/api-faq), [OKX hesap hareketleri](https://app.okx.com/docs-v5/en), [Telegram Bot API](https://core.telegram.org/bots/api).
