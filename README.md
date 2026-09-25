# Grid Control — OKX vadeli grid paneli

Bu proje, OKX hesabınızda long, short ve nötr vadeli grid botu oluşturmak ve
izlemek için bir web panelidir. Emir döngüsünü OKX'in yerel grid botu yürütür.
Railway yeniden başlasa bile açık bot OKX tarafında çalışmaya devam eder.

## GitHub ve Railway kurulumu

1. ZIP dosyasını bilgisayarınızda açın. ZIP dosyasını doğrudan GitHub'a
   yüklemeyin; içindeki dosyaları yeni bir GitHub deposunun köküne yükleyin.
2. Railway'de yeni proje açıp bu GitHub deposunu bağlayın. Railway npm start
   komutuyla Node uygulamasını başlatır. Servise bir public domain verin.
3. Railway Service → Variables bölümüne şu dört değeri ekleyin:

   | Değişken | Değer |
   | --- | --- |
   | OKX_API_KEY | OKX API anahtarınız |
   | OKX_SECRET_KEY | OKX gizli anahtarınız |
   | OKX_PASSPHRASE | Anahtarı oluştururken seçtiğiniz parola |
   | DASHBOARD_PASSWORD | Panel girişinde kullanacağınız güçlü, ayrı parola |

4. OKX hesabınızın bölgesine göre gerekirse OKX_SITE ekleyin:
   global (varsayılan), eea, us veya tr. Yanlış bölge API kimlik
   doğrulamasının başarısız olmasına yol açabilir.
5. Railway servisini yeniden dağıtın; verilen HTTPS adrese gidip panel
   şifresiyle giriş yapın. Parite ve aralığı seçerek botu açabilirsiniz.

OKX API anahtarında Read + Trade yetkileri yeterlidir. Withdraw yetkisi
vermeyin. Anahtarları dosyaya, GitHub'a veya tarayıcıya yazmayın.
IP beyaz listesi kullanacaksanız Railway'in sabit çıkış IP özelliği ve
uygun planı gerekir.

## Çalışma mantığı

- Long: OKX alış gridini, dolumdan sonra üst seviyedeki çıkışı yönetir.
- Short: OKX satış gridini, dolumdan sonra alt seviyedeki çıkışı yönetir.
- Nötr: OKX başlangıçtaki piyasa fiyatı altına long, üstüne short
  yerleştirir. Bu ayırıcı fiyat, verdiğiniz alt ve üst sınırın matematiksel
  orta noktasıyla aynı olmak zorunda değildir. Panel iki fiyatı da gösterir.
- İlk pozisyon açma (basePos) kapalıdır. Bot yine de fiyat değişiminde
  gerçek emirler verir. OKX bazı limit emirlerini piyasa koşullarına göre
  hemen doldurabilir; limit emri her zaman maker işlem anlamına gelmez.
- Girdiğiniz Toplam marjin, işlem başına tutar değildir. OKX bunu
  kendi grid emirlerine dağıtır. WunderTrading'deki işlem başına sabit
  USDT tutarının birebir karşılığı yoktur.
- Durdur / 1 botu durdurur ve kalan pozisyonu piyasa emriyle kapatabilir.
  Durdur / 2 botu durdurur ve pozisyonu açık bırakır. Açık pozisyonu
  OKX hesabından yönetmeniz gerekir.

## Sınırlar ve ayarlar

İlk deneme için sunucu bir botta en fazla 100 USDT marjin, en fazla 5×
kaldıraç ve en fazla 5 aktif bot kabul eder. Bu değerleri Railway
Variables bölümünde MAX_MARGIN_USDT, MAX_LEVERAGE ve MAX_ACTIVE_BOTS
ile değiştirebilirsiniz. OKX'in kendi minimumları ayrıca geçerlidir.

Panel yalnızca kendisinin oluşturduğu ve GC ile başlayan kimliği taşıyan
aktif botları listeler. Botlar OKX hesabınızda kalır; uygulamayı silmek
botları durdurmaz. OKX demo hesabı, yerel grid botu API'sini desteklemez.
Bu nedenle bot oluşturma işlemi canlı hesapta gerçekleşir.

Bot oluşturma isteği ağda zaman aşımına uğrarsa bot yine de açılmış olabilir.
Bu durumda yeniden Başlat'a basmadan önce OKX bot listesini kontrol edin.

## Yerelde çalışma

Node.js 20 veya yenisi gerekir. Değişkenleri terminal ortamınızda tanımlayıp
npm start çalıştırın. http://localhost:3000 adresini açın.
npm test OKX isteğinin imzalanmasını ve grid isteği alanlarını test eder.

## Kaynaklar

- [OKX Agent Trade Kit grid kodu](https://github.com/okx/agent-trade-kit/blob/github-main/packages/core/src/tools/bot/grid.ts)
- [OKX Agent Trade Kit grid belgeleri](https://github.com/okx/agent-trade-kit/blob/github-main/docs/modules/bot.md)
- [OKX vadeli grid açıklaması](https://www.okx.com/en-ae/help/futures-grid-bot-faq)
- [OKX API belgeleri](https://www.okx.com/docs-v5/en/)

Uygulama, Agent Trade Kit'in doğruladığı OKX REST grid uç noktalarını
doğrudan kullanır. Railway'de ayrıca AI/MCP işlemi çalıştırmanız gerekmez.
