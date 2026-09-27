# Grid Control 3.2 — OKX limit grid

Nötr grid düzeltmesi, net hesap desteği ve iptal/dolum yarışlarının yönetimi. Sunucu, emir motoru ve arayüz `okx-grid-control-v3.2-live.mjs` dosyasındadır. Node.js 22+, harici npm bağımlılığı yoktur. ZIP içindeki `source/` modüler kaynak kodu ve testleri içerir.

## Mevcut Railway kurulumunu güncelleme

Bu paket **v3.0 / v3.0.1 / v3.1** kayıtlarını aynı `grid-v3.json` dosyasından okuyabilir. v2'nin `manual-grids.json` kayıtlarını dönüştürmez.

1. Panelde yeni girişleri duraklatın. Eski servisi normal şekilde durdurun ve veri klasörünün yedeğini alın. OKX'teki açık limit emirleri ve pozisyonlar borsada kalır; kesinti sırasında yeni doluma yeni kâr alma emri kurulamaz.
2. ZIP'i açın ve içeriğini GitHub deposunun köküne yükleyin. ZIP dosyasının kendisini repoya koymak uygulamayı çalıştırmaz.
3. Railway **Start Command**: `npm start`. Alternatif: `node okx-grid-control-v3.2-live.mjs`. Önceki dosya adına bağlı özel komut varsa güncelleyin.
4. Aynı Volume, **`DATA_DIR=/data`**, aynı OKX anahtarı ve demo/canlı ortamını koruyun. **`grid-v3.json` dosyasını silmeyin; yeni boş veri klasörü açmayın.** Tek replica kullanın; eski ve yeni uygulamayı aynı hesaba birlikte bağlamayın.
5. Başlangıçta eski emir kimlikleri, dolumlar ve açık pozisyonlar tekrar okunur. Duraklatılmış botlarda veriler eşleşince **Devam et** kullanın. Bir bot uyuşmazlık nedeniyle bekliyorsa yeni bot açarak onu atlamayın; paneldeki kayıtları kontrol edin.

Yeni sabit merkez kuralı bu sürümde oluşturulan nötr botlara uygulanır. Çalışan eski nötr botun fiyatları, yönleri, kapasitesi ve emir kimlikleri yeniden yazılmaz. Kartta eski politika belirtilir. Long/short botların giriş stratejisi korunur; iptal ve pozisyon okuma düzeltmeleri tüm botlarda çalışır.

## Nötr grid nasıl çalışır?

Başlatılırken OKX'ten alınan fiyat, fiyat adımına yuvarlanarak **sabit merkez** olarak kaydedilir. Aralığın matematiksel ortası kullanılmaz. Önizleme ile başlatma arasında fiyat değişebilir; başlangıçta kaydedilen merkez kartta görünür ve daha sonra kaymaz.

- Merkezin altındaki gridler **long**: giriş alış, bir üst komşu seviyede satışla kapanış.
- Merkezin üstündeki gridler **short**: giriş satış, bir alt komşu seviyede alışla kapanış.
- Merkezde yeni pozisyon açılmaz. Merkez, merkeze en yakın long ve short işlemlerinin kapanış hedefidir.
- Her yöndeki seviyeler merkezden seçilen yüzdeyle geometrik olarak hesaplanır. Örneğin 100 ve %1 için short seviyeleri 101, 102,01, 103,0301…; long seviyeleri 99,0099…, 98,0296… olur. Borsanın fiyat adımı bunları yuvarlar. Sınırlara sığmayan son eksik aralık kullanılmaz; grid sayısı otomatik hesaplanır.
- Her çalışan yönde en fazla seçilen **1–5 bekleyen giriş** vardır. Dolan pozisyonlar bu pencerenin dışında, o yöndeki toplam grid sayısına kadar birikebilir. Aynı seviyede açık işlem varken ikinci giriş oluşturulmaz.
- Sabit USDT değeri her yeni grid girişinin nominal tutarıdır. Cross 10× uygulanır; tutar ayrıca 10 ile çarpılmaz.

### Net hesap (hedge modu gerektirmez)

Net hesap aynı paritede tek bir net pozisyon tutar. Bot hesap modunu değiştirmez.

Fiyat merkezin üstündeyken short girişleri, altındayken long girişleri hazırlanır. Fiyat tam merkezdeyse önce hangi tarafa hareket edeceği beklenir. Diğer taraftaki açık pozisyon, kısmi dolum, çıkış veya iptali henüz doğrulanmamış giriş bitmeden ters yönde yeni giriş gönderilmez. Çıkışlar `reduceOnly` kullanır; yanlışlıkla ters pozisyon açamaz.

Örnek: merkez 100. Yukarıda short limitleri dolunca bir alt gridde kâr alma emri kurulur. Fiyat geri düşerken shortlar kapanır. Merkezin altına geçildiğinde son shortun ve eski emirlerin bittiği doğrulandıktan sonra long girişleri açılır. Düşüş sürerse bu longlar açık kalır; tekrar yükseldiğinde komşu üst hedeflerde kapanabilir.

**Sınır:** Net modda aynı anda iki tarafın girişleri borsada tutulmaz. Yön seçimi ve yön geçişi REST kontrollerini bekler. Çok hızlı fiyat atlamasında bazı seviyeler kaçabilir; geçmişte dokunulmuş seviyelerde sonradan dolum olmuş gibi kayıt tutulmaz. Post-only giriş, gönderildiği anda piyasadan gerçekleşecekse borsa tarafından iptal edilebilir.

### Long/short hesabı

Hesap zaten long/short modundaysa merkezin iki tarafındaki girişler birlikte bekleyebilir. Her emrin `posSide` alanı doğru yöndür. Bu mod için başlangıçta hedge pozisyonu açılmaz. Yeni nötr bot artık bu hesap modunu zorunlu tutmaz.

## Görülen hatalarda ne düzeldi?

**51400 / 51401 / 51402 iptal yanıtları:** Bu yanıt tek başına başarılı iptal sayılmaz. Motor aynı emir kimliğiyle son durumu okur. Emir dolmuşsa yeni dolumu bir kez kaydeder ve gerekli kâr alma emrini kurar; iptal olmuşsa varsa kısmi dolumu korur. Durumu doğrulanamayan emir kapasitede kalır, körlemesine yenisi gönderilmez. Doğrulanan yarış olayı kırmızı hata yerine bilgi kaydı olur.

**Pozisyon / dolum uyuşmazlığı:** OKX emir ve pozisyon istekleri aynı ana ait atomik bir görüntü değildir. İki okuma arasında dolum gelirse motor açık emirleri yeniden okuyup pozisyonu en fazla iki ek turda karşılaştırır. Eşleşme sağlanırsa gereksiz hata üretmeden devam eder. Gerçek veya devam eden uyuşmazlıkta yeni girişler bekler; kayıtlı miktarlar borsadaki değere zorla eşitlenmez. 15 saniyeyi aşan uyuşmazlık girişleri duraklatır.

Ekran görüntüsündeki geçici olaylar bu yarışlarla uyumludur. Gerçek hesabın API geçmişi bu çalışmada okunmadığı için oradaki her olayın kaynağı kesin olarak doğrulanmış değildir.

## İlk kurulum ve ortam değişkenleri

Yerelde `.env.example` dosyasını `.env` olarak kopyalayın ve doldurun. Railway'de Variables kullanın.

```text
OKX_API_KEY=...
OKX_SECRET_KEY=...
OKX_PASSPHRASE=...
DASHBOARD_PASSWORD=...
OKX_SITE=global
OKX_DEMO=false
DATA_DIR=/data
NODE_ENV=production
```

Yerel HTTP kullanırken `NODE_ENV=development` ve kalıcı yerel DATA_DIR seçin. Sunucu varsayılan olarak port 3000'i, Railway'de `PORT` değerini kullanır. `OKX_SITE=global|eea|us|tr` hesabın bölgesine uygun olmalı. `OKX_DEMO=false` veya değişkenin olmaması gerçek hesaptır; demo için `true` ve demo anahtarları gerekir. API anahtarları sunucuda kalır, GitHub'a yüklenmez.

Başlatma: `npm start`. Paket `.env` varsa okur; yoksa Railway değişkenlerini kullanır. `npm install` gerekmez. Yeni bot oluşturulmadan önce pozisyon/emir sahipliği, kullanılabilir bakiye, sözleşme adımları ve cross 10× doğrulanır. Paritede başka pozisyon/emir/bot varsa yeni bot reddedilir.

`MAX_TRADE_USDT` varsayılan 100, `MAX_ACTIVE_BOTS` 5, `POLL_MS` 3000. Çok sayıda emir ve API gecikmesi gerçek kontrol aralığını uzatır. `/health` süreç durumunu, `/ready` son döngünün güncelliğini gösterir. Servis uyumamalı.

## Kayıtlar, duraklatma ve muhasebe

**Duraklat** yeni girişleri iptal eder ve mevcut çıkışları yönetir. **Girişleri bitir** aynı şekilde yeni girişleri keser; tüm işlemler kapanınca bot tamamlanır. Bunlar pozisyonu piyasa fiyatından kapatmaz. Zarar eşiği de yeni giriş durdurma eşiğidir.

Emir niyeti gönderimden önce diske yazılır. Belirsiz POST yanıtı yeniden emir gönderilerek aşılmaz. Kümülatif dolumlar artış kadar işlenir; kısmi dolumlar ve çıkış rezervleri korunur. Tek süreç kilidi aynı klasörü kullanan iki motoru engeller. Sert çökmeden kalan `grid-v3.lock` ancak başka süreç/replica çalışmadığı doğrulandıktan sonra kaldırılır; `grid-v3.json` silinmez.

Panelde gerçekleşmiş PnL, emirlere ait OKX hareketlerindeki PnL + ücret/iade + funding ve varsa diğer hareketleri içerir. Gerçekleşmemiş PnL, pozisyonlar eşleştiğinde OKX'ten alınır. Eksik muhasebe varsa toplam kesin sonuç olarak gösterilmez. Funding grid seviyelerine tahmini dağıtılmaz. Aynı yöndeki pozisyonların borsadaki ortak maliyeti, tek bir grid çiftinin görünen kârından farklı olabilir.

Telegram için `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` kullanılır. İlk sağlıklı başlangıçtan sonra ciddi ve devam eden hatalar bildirilir. Normal dolumlar ve doğrulanmış iptal yarışları mesaj göndermez. Bildirimler en az 5 dakika arayla gruplanır; aynı hata varsayılan saatlik tekrar sınırına tabidir. Önceki Telegram değişkenlerini koruyun. Tamamen kapanan sunucu kendi bildirimini gönderemez.

## Doğrulama

```sh
npm test
```

Testler gerçek API anahtarı kullanmadan taklit OKX yanıtlarıyla çalışır. Sabit merkez, net hesapta shorttan longa geçiş, kısmi kapanış, geç iptal dolumu, 51400/51401, emir sorgusu ile pozisyon sorgusu arasındaki dolum, gerçek uyuşmazlıkta durma, kalıcı kayıt ve eski v3 botlarının korunması sınanır. `TEST-SONUCLARI.txt` bu paketin çalıştırma sonucudur. Canlı hesaba emir gönderilerek doğrulama yapılmamıştır.

OKX kaynakları: [pozisyon modları ve iptal onayı](https://www.okx.com/docs-v5/trick_en/), [emir API'si ve reduceOnly](https://www.okx.com/docs-v5/en/).
