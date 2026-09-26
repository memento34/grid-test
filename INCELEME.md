# v2.1 kod incelemesi ve v3 değişiklikleri

İncelenen kaynak: kullanıcının verdiği `okx-manual-grid-cross10-v2.1.zip`. Kodun README açıklamaları uygulamanın davranışını anlamak için okundu; canlı işlem açılması için talimat kabul edilmedi. İnceleme sırasında canlı emir veya gerçek Telegram mesajı gönderilmedi.

## Önemli bulgular

| Önem | v2.1 bulgusu | Etki | v3 yaklaşımı |
|---|---|---|---|
| Kritik | `place()` yalnızca `NETWORK` hatasında emir kimliğini koruyordu. | 50004, bozuk yanıt veya 5xx kabul edilmiş bir emrin kayıttan düşmesine ve sonraki denemede ikinci emir riskine yol açabilirdi. | Belirsiz sonuçlar korunur, `clOrdId` üzerinden sorgulanır, otomatik yeniden gönderilmez. |
| Kritik | `tickBot()` içindeki ilk emir sorgu istisnası döngüyü kesiyordu. | Diğer seviyelerdeki dolumların kâr alma emirleri kurulmayabilirdi. | Emir başına hata izolasyonu; doğrulanmış diğer seviyelerin çıkışları işlenir. Pozisyon toplamı uyuşmazsa güvenli duraklama. |
| Yüksek | Kısmi giriş dolumu yalnız terminal durumda `remaining` içine yazılıyordu. | İptal gecikmesinde dolan miktar çıkışsız kalabiliyordu. | Dolum artışı anında kaydedilir; açık giriş ve birden fazla parçalı çıkış ayrı kayıtlarla izlenir. |
| Yüksek | Giriş ve çıkış aynı tek `level.order` alanını kullanıyordu. | Bir girişin iptali beklenirken kısmi dolumu ayrı çıkışla korumak mümkün değildi. | Kalıcı emir günlüğü; aktif çıkış rezervleri düşülerek yalnız açıkta kalan miktara emir. |
| Yüksek | Bot çalışırken borsadaki gerçek pozisyon ile yerel miktar karşılaştırılmıyordu. | Manuel kapama, başka bot, tasfiye veya geç veri yerel miktarı bozabilirdi. | Pozisyon miktarı ve yönü, bekleyen emir sahipliği ve muhasebedeki harici işlemler kontrol edilir. Uyuşmazlıkta girişler iptal edilir. |
| Yüksek | Başlangıçta normal emirler kontrol ediliyor, bekleyen algo emirleri kontrol edilmiyordu. | Sonradan tetiklenen başka algo, gridin pozisyonuna müdahale edebilirdi. | Başlangıçta ve periyodik olarak conditional/OCO/trigger/trailing/iceberg/TWAP ile yerel grid kontrolü. Bu, her olası harici işlem kaynağını ortadan kaldırmaz. |
| Yüksek | Demo işlem seçeneği yoktu. | İlk deneme gerçek emir gönderebilirdi. | Demo varsayılan; canlı ayrı ortam ve arayüz onayıyla açılır. |
| Yüksek | PnL, ücret ve funding muhasebesi yoktu. | Net performans görülemiyordu. | OKX bill arşivi, sayfalama, kimlik tekilleştirmesi, dolum miktarı mutabakatı ve pozisyon UPL. Eksik veri açıkça işaretlenir. |
| Yüksek | Süreçler arası tek-yazıcı kilidi yoktu. | Aynı dosyayı kullanan iki süreç çift emir oluşturabilirdi. | Kalıcı klasörde özel kilit; ayrı sunucu/ayrı volume için yine tek replica şartı. |
| Orta | Ondalık basamak hesabı bilimsel gösterimi doğru desteklemiyordu; miktarlar kayan noktalıydı. | Küçük fiyat/lot adımında sıfırlanma veya yanlış adım hesabı oluşabilirdi. | 18 basamaklı BigInt miktar ve muhasebe işlemleri. Geometrik fiyat hesabı tick'e aşağı yuvarlanır; çakışan seviyeler reddedilir. |
| Orta | API saat farkı yönetimi ve gönderim son zamanı yoktu. | Saat uyuşmazlığı, geciken emir iletimi ve muhasebe aralığı kaymaları riski. | OKX saat eşitleme, imzalı zaman, emir `expTime`, borsa zamanıyla muhasebe sınırları. |
| Orta | Kayıt dosyası hesap veya demo/canlı kimliğine bağlı değildi. | Yanlış ortamda eski emirleri yönetmeye çalışma riski. | Ortam ve API anahtarı parmak izi doğrulaması; gizli anahtar dosyaya yazılmaz. Anahtar değiştirmek kontrollü geçiş gerektirir. |
| Orta | API hız sınırı/sayfalama yönetimi sınırlıydı. | Yoğunlukta kesilen sorgular ve eksik listeler. | Endpoint bazında istek aralığı; sayfalama ilerlemezse açık hata; limitte sessiz veri kesme yok. |
| Orta | Telegram veya ciddi hata birleştirme yoktu. | Kullanıcı paneli izlemiyorsa işlem hatasını fark etmeyebilirdi. | Süre eşikleri, kalıcı tekrar bastırma, toplu ciddi hata bildirimleri, teslimat geri çekilmesi. |

## Korunan ve açıklığa kavuşturulan davranışlar

- v2 normal limit giriş kullanıyordu. v3 girişleri post-only yapar; ani fiyat hareketinde taker giriş yerine borsa iptali görülebilir. Çıkışlar normal limit olarak kalır.
- İşlem başı USDT nominal emir değeridir. Cross 10× bunu yeniden onla çarpmaz. En çok beş seviyenin başlangıç nominali sınırlanır; fiyat değiştikçe açık pozisyonun mark nominali değişebilir.
- Pencere rotasyonunda iptal istenen girişler terminal onay gelene kadar kapasite kullanır.
- Durdurma, zarar eşiği ve pause işlemleri pozisyonu piyasa emriyle kapatmaz. Hedef kâr fiyatına dönmeyen bir pozisyon süresiz açık kalabilir.
- Kâr alma da yazılımın gönderdiği normal emirdir. Süreç durursa daha önce gönderilmiş emirler kalır; yeni dolan girişler için çıkış kurulamaz. WebSocket veya bağımsız borsa stop-loss'u uygulanmamıştır.
- Hedge pozisyonlarında OKX kapama yönü kullanılır; net modda reduce-only çıkış vardır. Nötr strateji hedge gerektirir.

## PnL doğruluğunun sınırları

Komisyon ve funding tahmini oranlarla hesaplanmaz; gerçek OKX hareketleri kullanılır. Açık pozisyon UPL'si mark fiyatına göre borsadan alınır. Normal akışta botun toplamı, bilinen emirlerin gerçekleşmiş kâr/zararı + işaretli ücretler + ilgili funding ile oluşur.

Bu ayrım için aynı paritede yalnız bu botun işlem yapması gerekir. Başka bir işlem kaynağı, manuel emir, kapama, tasfiye, hesap düzeltmesi veya API kayıt gecikmesi varsa uygulama bunu elindeki kanıtla tespit ettiği ölçüde kısmi veri/uyuşmazlık gösterir. Ayrı alt hesap kullanılmadığında funding'i farklı uygulamalara kesin olarak ayırmak mümkün değildir. Sonradan gelen veya son 24 saatlik tekrar taraması dışında değiştirilen borsa kayıtları ayrıca inceleme gerektirebilir. Özellikle bot kapandıktan sonra gecikmeli posting oluşursa borsa ekstresiyle kapanış mutabakatı yapılmalıdır.

Tek tek grid seviyelerindeki OKX PnL'si borsanın birleştirilmiş pozisyon maliyetinden etkilenir. Bu nedenle arayüz “emirlere yazılan net PnL” der; funding'i seviyelere sahte kesinlikle paylaştırmaz. Henüz oluşmamış kapanış ücretleri ve gelecekteki funding net sonuca dahil değildir.

## Test sonucu

33 otomatik test başarıyla geçti. Finansal tutarlar ve emir senaryoları taklit borsa yanıtlarıyla denendi. Kabul edildikten hemen sonra disk yazma hatası olan emir, yeniden başlatmada aynı kimlikle bulundu; yeniden gönderilmedi. Beş girişin aynı anda dolması, çıkışların kısmi dolup iptal olması, regrese dolum verisi, dış işlem ve pozisyon uyuşmazlıkları test edildi.

Telegram testleri gerçek mesaj göndermeden 429 geri çekilmesini, geçici hataların çözülmesini, tekrar sınırlarını, birleştirmeyi ve gizli alan temizliğini doğruladı. HTTP testleri oturum, CSRF, Origin ve dışa aktarma korumasını kapsadı. 1440 px masaüstü ve 390 px mobil tarayıcıda görsel/etkileşim kontrolü yapıldı.

İlk geliştirme testlerinden birinde aralıklı çıkış yenileme başarısızlığı görüldü; ardışık tekrar koşularında yeniden üretilemedi. Kalıcı dosya değiştirmesinde Windows'un geçici EPERM/EACCES/EBUSY hataları için sınırlı tekrar koruması eklendi. Nihai testler geçti; bu gözlem gerçek borsa davranışına ilişkin bir kanıt değildir.

**Sınanmayanlar:** gerçek OKX hesap izinleri/bölge uçları, borsanın gerçek dolum ve rate-limit davranışı, gerçek funding tahakkuku, demo hesapta uçtan uca emir akışı, gerçek Telegram chat ID teslimatı, internet/hosting kesintisi altında uçtan uca canlı pozisyon. Bu sürüm canlı hesabınızda doğrulanmış veya bağımsız finansal yazılım denetiminden geçmiş değildir.

## Önerilen kabul denemesi

OKX demo hesabında bir girişin dolması, aynı miktarda çıkış kurulması ve çıkışın dolmasından sonra yeniden giriş kurulmasını izleyin. Panelin emir kimliklerini, toplam pozisyonunu, ücretlerini ve PnL'sini OKX geçmişiyle karşılaştırın. Duraklatmayı, hedef çıkış bekleyerek bitirmeyi ve normal yeniden başlatmayı deneyin. Canlı işlem kararını bu gözlemlerden sonra verin; test sonuçları piyasa ve altyapı riskini ortadan kaldırmaz.
