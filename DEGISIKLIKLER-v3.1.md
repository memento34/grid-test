# Grid Control 3.1.0 — değişiklikler

## 51000 / Parameter expTime error

Önceki v3 istemcisinde OKX saat farkı `server - (başlangıç + bitiş) / 2` ile hesaplanıyordu. İstek süresi tek sayıda milisaniye olduğunda `.5` oluşabiliyor; emir başlığı `1700000010000.5` gibi kesirli Unix milisaniyesi içeriyordu. OKX'in beklediği tam sayı biçimine uymayan bu değer hem short girişini hem kâr alma emrini reddettirebiliyordu. Ekran görüntüsündeki hatayı üreten kod yolu yerel testte yeniden oluşturuldu; gerçek isteğin ham sunucu kaydı mevcut değil.

Saat farkı ve emir zaman damgası artık tam sayı; imza ve expTime aynı zaman örneğini kullanıyor. Hatalı biçim kaynağı giderildi. Ağ kesintisi, gerçek borsa reddi veya zaman aşımı gibi başka hataların hiç oluşmayacağı garanti edilemez. Belirsiz POST hâlâ körlemesine tekrarlanmıyor.

## “Gridler kapandı” durumu

Emir reddi motoru `paused` durumuna alıyor, yeni girişler iptal ediliyor. Pozisyonları piyasa emriyle kapatan bir işlem yapılmıyor. Doğrulanmış dolumların kâr alma yönetimi devam ediyor; kesin reddedilmiş çıkış, bekleme sonrası tekrar kurulabiliyor. Görselde reddedilen çıkışın yaklaşık 33 saniye sonra kurulması bu davranışla uyumlu. Olay kaydı artık bu ayrımı açıkça söylüyor. Ciddi hatalarda duraklatma korunuyor; mutabakat sonrasında panelden Devam et kullanılabiliyor.

## İstenen varsayılanlar

- Kurulum formu OKX fiyatından %1 adımla 50 aşağı, 50 yukarı geometrik aralık doldurur. Elle değiştirilebilir ve tek düğmeyle yenilenebilir.
- Yeni nötr bot, anlık fiyatın altında 5 long ve üstünde 5 short bekleyen giriş hedefler. Dolumdan sonra pencere yenilenir; mevcut kâr alma emirleri korunur.
- Dolan pozisyonlar grid sayısına kadar birikebilir. Varsayılan merkezde kapasite 50 long + 50 short; açık pozisyon ve bekleyen girişler bu sınırı birlikte kullanır. Kapasite dolunca yeni giriş kesilir, çıkışlar devam eder.
- Telegram ilk doğrulanmış sağlıklı kurulumda bir defa SİSTEM HAZIR gönderir. Sonrasında ciddi hata filtresi ve tekrar bastırma uygulanır. Güncelliğini yitiren sağlık kontrolüyle mesaj gönderilmez.
- Küçük fiyatlı sözleşmelerde geometrik hesapların 18 basamaktan fazla ondalık üretmesi düzeltildi. Miktar/ücret muhasebesi kesin ondalık işlemlerini korur.

## Uyumluluk ve kullanım

Gerçek hesap varsayılanı korunuyor. Anahtarlar, DATA_DIR ve panel şifresiyle çalıştırıp Planı hesapla → Gridi başlat kullanılır. Ek CANLI yazma adımı yoktur. Nötr için OKX hesabı long/short (hedge) modunda olmalıdır; uygulama hesap modunu kendiliğinden değiştirmez.

**v3 güncellemesinde mevcut DATA_DIR ve grid-v3.json korunmalı; boş veri klasörüyle başlatılmamalı.** Eski ve yeni süreç aynı anda çalışmamalı. README'deki v3 geçişini izleyin. Eski nötr botların kayıtları/yön politikası geriye dönük değiştirilmez; yeni nötr davranış yeni oluşturulan botlar içindir.

## Doğrulama

49 otomatik test geçti. Tek dosyalık paket yerel taklit OKX ile tarayıcıda CANLI ayarı, otomatik 100 aralık, nötr 5+5 başlatma, önizleme ve mobil görünüm açısından kontrol edildi. Gerçek OKX hesabına emir veya gerçek Telegram mesajı gönderilmedi; canlı dolum/komisyon/funding uçtan uca sınanmadı.

Kaynaklar: [OKX REST API — expTime ve emirler](https://www.okx.com/docs-v5/en/), [Telegram Bot API](https://core.telegram.org/bots/api).
