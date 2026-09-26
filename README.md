# Grid Control 2 — OKX normal limit emirli dinamik grid

Bu sürüm OKX'in hazır grid botunu **başlatmaz**. Railway üzerinde çalışan bu
uygulama, OKX vadeli piyasasına normal `limit` giriş ve çıkış emirlerini kendi
gönderir. Eski sürümde açtığınız OKX yerel botları bu dosyaları yükleyince
kendiliğinden durmaz; OKX hesabınızdan ayrıca yönetmeniz gerekir.

## Kurulum

1. ZIP'i açın; **içindeki dosyaları** GitHub deposunun köküne yükleyin.
2. Railway servisini GitHub deposuna bağlayın. Başlatma komutu `npm start`.
3. Railway servisine kalıcı bir **Volume** bağlayın. Örneğin bağlama yolu
   `/data` ise `DATA_DIR=/data` değişkenini ekleyin. Railway üzerinde bu
   değişken olmadan canlı bot başlatılmaz. Bot ayarları ve emir kimlikleri
   bu volume üzerindeki `manual-grids.json` dosyasında tutulur.
4. Railway Variables bölümüne `OKX_API_KEY`, `OKX_SECRET_KEY`,
   `OKX_PASSPHRASE` ve `DASHBOARD_PASSWORD` ekleyin. Mevcut anahtarlarınız
   kullanılabilir; Read ve Trade yetkileri gerekir. Withdraw vermeyin.
5. Hesabınızın bölgesine göre gerekirse `OKX_SITE=global|eea|us|tr` ayarlayın.
6. Servisi **tek kopya/replica** olarak çalıştırın. Aynı volume üzerinde iki
   kopyanın emir yönetmesi desteklenmez.

`MAX_TRADE_USDT` (varsayılan 100), `MAX_LEVERAGE` (5) ve
`MAX_ACTIVE_BOTS` (5) isteğe bağlı işlem sınırlarıdır. `DATA_DIR` için
volume yolu Railway servisinin kendi dosya sisteminde olmalıdır.

## Grid hesabı ve emir döngüsü

- Alt fiyat, üst fiyat ve grid başına hedef yüzde girilir. Uygulama
  `floor(log(üst/alt) / log(1 + yüzde/100))` formülüyle grid sayısını
  hesaplar. Örneğin 1.884,25–3.485,38 ve %1 için **61 grid** çıkar.
  Fiyatlar OKX fiyat adımına yuvarlanır; son gerçek aralık küçük farklılık
  gösterebilir. %0,1–%25 ve en fazla 500 seviye desteklenir.
- “İşlem başı değer” her giriş için sabit **USDT emir değeridir**. Toplam
  grid sayısına bölünmez. Sözleşme adımına aşağı yuvarlanan gerçek emir
  değeri biraz daha düşük olabilir. Kaldıraç bu değeri çoğaltmaz; seçilen
  kaldıraç OKX isolated hesabına uygulanır.
- Long: piyasanın altındaki en yakın beş girişe alış limiti konur. Giriş
  dolunca bir üst komşu seviyeye satış limitiyle kâr alma konur. Çıkış
  dolunca aynı giriş seviyesi yeniden kullanılabilir.
- Short: piyasanın üstündeki en yakın beş girişe satış limiti konur;
  bir alt komşu seviyede alış limitiyle kapatılır.
- Nötr: fiyat aralığının matematiksel orta noktasının altındaki seviyeler
  long, üstündekiler short yönündedir. Nötr için OKX hesabında
  **long/short (hedge) pozisyon modu** gerekir.
- Fiyat yer değiştirince en yakın beş uygun **dolmamış giriş** açık kalır.
  Uzak kalan girişler iptal edilir; yakın seviyeler açılır. Pozisyona
  dönmüş seviyelerin kâr alma emirleri bu pencere değişiminde iptal edilmez.
- İlk sürümde aynı anda en fazla **beş pozisyon seviyesi** ve beş giriş
  emri bulunur. Bu, toplam açık pozisyon büyüklüğünü sınırlamak içindir.
  Kâr alma dolunca yeniden giriş için yer açılır.
- Durdur düğmesi yeni girişleri keser ve dolmamış girişleri iptal eder.
  Açık pozisyonların kâr alma limitleri izlenmeye devam eder; son çıkış
  tamamlanınca bot durur.

## Canlı işlem davranışı

Başlatmadan önce uygulama aynı paritede başka açık pozisyon, normal emir
veya OKX yerel grid botu bulunmadığını kontrol eder. Bunlar varsa yeni
botu başlatmaz. Bir paritede aynı anda bir Grid Control botu çalışır.

Bot açıkken Railway servisinin sürekli çalışması gerekir. Servis durursa
OKX'te daha önce konmuş limit emirleri durmaya devam eder; **yeni dolan bir
girişin kâr alma emri, servis yeniden başlayana kadar kurulamaz**. Kalıcı
volume sayesinde uygulama yeniden başlayınca kayıtlı emirleri OKX'ten
sorgular ve döngüye devam eder. Volume'u silmeyin veya çalışan bot varken
`DATA_DIR` yolunu değiştirmeyin. Başka uygulamaların ve elle verilen
işlemlerin aynı pariteye müdahale etmesi botun pozisyon hesabını bozabilir;
bu yüzden ayrı bir alt hesap kullanın.

Normal limit emir piyasa fiyatı emir gönderilirken değişirse hemen
dolabilir. Hedef yüzde **brüt fiyat aralığıdır**; işlem ücretleri ve fonlama
çıktıktan sonraki net kârı garanti etmez. İlk denemeyi küçük tutarla yapın
ve emirleri OKX hesabından da gözleyin.

## Test ve kaynaklar

Node.js 20+ ile `npm test` otomatik hesap, giriş/çıkış döngüsü, yeniden
başlatma, iptal ve OKX istek imzasını çevrimdışı test eder.

- [OKX normal emir API belgeleri](https://www.okx.com/docs-v5/en/)
- [OKX normal emir örneği](https://www.okx.com/docs-v5/trick_en/)
- [OKX vadeli grid davranışı](https://www.okx.com/en-gb/help/futures-grid-bot-faq)
