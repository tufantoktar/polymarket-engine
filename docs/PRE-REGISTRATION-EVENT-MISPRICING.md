# Ön-Kayıt — Event Mispricing

**Yazıldığı tarih:** 21 Ağustos 2026
**Yazıldığı an:** sonuç istatistiği hesaplanmadan önce
**Değiştirme kuralı:** aşağıdaki hiçbir madde, veri toplandıktan sonra
sonuçlara bakılarak değiştirilemez. Değiştirilirse bu belge bir kayıt
olmaktan çıkar ve çalışma keşifsel sayılır.

---

## Soru

Polymarket'in 0.60 fiyatladığı olayların kabaca %60'ı gerçekleşiyor mu?

Gerçekleşiyorsa piyasayla aynı fikirde olmamak bir strateji değildir.
Bir market sınıfı, işlem maliyetini aşacak kadar sistematik biçimde
yanlış fiyatlanıyorsa bu hıza da mikroyapıya da ihtiyaç duymayan bir
edge'dir.

## Neden şimdi yazılıyor

Veri birikirken her ay test tekrarlanırsa, er ya da geç umut verici bir
sayı çıkar ve o sayı gerçek sanılır. Zamana yayılmış bu arama kendini
fark ettirmez. Bu yüzden:

- **Saymak serbesttir.** Kaç event biriktiği istediğimiz sıklıkta
  ölçülebilir; sayım hiçbir sonuç istatistiği hesaplamaz.
- **Sonuç istatistiği bir kez hesaplanır.** Eşik aşıldığında, bir defa.
- **Karar kuralı bugün yazılmıştır.** Sonuç görülmeden.

---

## Örneklem

**Kaynak:** `data/pricehistory` arşivi. Saatlik yakalanır, çünkü CLOB
`/prices-history` yaklaşık son 30 günü tutar ve gerisini siler.

**Dahil edilme:**
- Market çözülmüş, `outcomePrices` bir tarafta ≥0.99 diğerinde ≤0.01
- Kaydedilmiş fiyat geçmişi ≥1 gün
- İlgili ufuk için çözümden önce fiyat noktası mevcut

**Hariç:** void marketler, çözülmemişler, geçmişi 1 günden kısa olanlar.

**Hacim eşiği YOKTUR.** Birincil analiz tüm uygun marketleri kullanır.
Hacim eşiği toplama anına değil analiz anına aittir; toplarken
filtrelersek duyarlılık testini bir daha yapamayız.

## Ufuklar

**Birincil: 7 gün.** Yanlış fiyatlamanın oluşması ve üzerine işlem
yapılması için makul süre bırakan, aynı zamanda makul sürede yeterli
güce ulaşan en uzun ufuk.

**İkincil (raporlanır, karar vermez): 1, 3, 14 gün.**

**30 gün tasarımdan düşürülmüştür.** Ölçüldü: 2041 marketin 14'ü 30
günlük geçmişe sahip, en uzun kayıt 30.9 gün. API tavanı bu ufku
yapısal olarak erişilemez kılıyor. Beklemekle gelmez.

## Eşik

**Ufuk başına 500 event.**

İkili sonuçta `gerçekleşen − fiyat` farkının standart sapması ~40 sent,
yani standart hata 40/√n. 500 event, 5 sentlik bir sapmayı yaklaşık %80
güçle yakalar. 3 sent için ~1400 event gerekirdi.

Ölçülen birikim hızıyla 7 günlük ufukta 500 event ≈ **64 gün**.

---

## Ölçülecek istatistikler

Her market ufuk başına **tek bir gözlem** verir: çözümünden H gün
önceki fiyatı. Bir marketin yüzlerce saatlik noktasını kullanmak o
marketi yüzlerce kez saymak ve uzun ömürlü marketlerin kısa olanları
boğması demektir.

**Bağımsızlık:** Polymarket bir olayı her sonuç için ayrı markete
böler; bunlar bağımsız değildir, tanım gereği tam biri YES çözülür.
Bütün aralıklar **event yeniden örneklenerek** hesaplanır, market
değil. Smart Money çalışmasında satır bazlı bootstrap doğru aralıktan
2.6 kat dar çıkmış ve olmayan bir kesinlik üretmişti.

**Sızıntı:** fiyat kesinlikle çözümden önce okunur. Çözüm anındaki ve
sonrasındaki her nokta atılır. Ufukta zaten 0 veya 1'e sabitlenmiş
marketler ayrıca raporlanır, sessizce dahil edilmez.

## İki birincil test

Toplam kalibrasyon hatası sıfıra yakın çıkarken kova bazında ciddi
sapma bulunabilir — favori/uzun-şans yanlılığı tam olarak böyle
görünür ve ortalamada birbirini götürür. Bu yüzden iki test var, ve
ikisi olduğu için her biri Bonferroni ile **%97.5 aralık** kullanır.

**Test A — toplam işaretli hata.**
`ortalama(gerçekleşen − fiyat)`, 7 günlük ufukta, event-kümeli
bootstrap (≥5000 iterasyon, seed kayda geçer).

**Test B — kova bazında kalibrasyon.**
Fiyat kovalarında (0.0-0.1 ... 0.9-1.0) gerçekleşme oranı ile fiyat
farkı; küme ağırlıklı beklenen kalibrasyon hatası (ECE) ve aynı
bootstrap ile aralık.

Yardımcı olarak raporlanır ama karar vermez: Brier skoru, taban oranın
Brier'i, log loss, kategori kırılımı.

## Ekonomik eşik

**1.5 sent.** Giriş maliyeti 1.0 sent (medyan spread bir tick) artı 0.5
sent emniyet payı. İstatistiksel anlamlılık tek başına yeterli değildir;
maliyetin altındaki bir sapma ölçülebilir ama alınamaz.

## Karar kuralı

**PASS** — Test A veya Test B'de %97.5 aralık sıfırı dışlıyor **ve**
aralığın sıfıra yakın ucu 1.5 senti aşıyor.

**WEAK** — aralık sıfırı dışlıyor ama 1.5 senti aşmıyor. Gerçek ama
alınamaz. Strateji kurulmaz; sonuç kaydedilir.

**KILL** — aralık sıfırı içeriyor.

**YETERSİZ VERİ** — 500 event eşiğine ulaşılmadan sonuca varılmaz.

Karar birincil ufuktan (7 gün) verilir. İkincil ufuklar raporlanır ve
sonucun onlarda da ayakta kalıp kalmadığı yazılır, ama birincil KILL
iken bir ikincil PASS'e bakarak karar değiştirilmez.

---

## Önceden belirlenmiş duyarlılık testleri

Bunlar **sonuca bakılmadan** seçilmiştir ve hepsi raporlanır — hangisi
iyi görünürse o değil.

1. **Hacim eşiği:** filtresiz (birincil), ≥1.000, ≥10.000. Sonuç üçünde
   de aynı yöne gitmiyorsa bu bir edge değil, bir alt küme bulgusudur.
2. **Kategori:** Politics / Crypto / Sports / Economics / Tech / Other
   kırılımı. Tek bir kategoriden geliyorsa ayrıca söylenir.
3. **Zaman:** örneklem ikiye bölünür, ilk yarı ile ikinci yarı
   karşılaştırılır. Sadece bir dönemde varsa rejim etkisidir.
4. **Küme anahtarı:** event id bulunamayan marketler tek başına küme
   sayılır. Bunların oranı raporlanır — yüksekse bağımsızlık varsayımı
   arka kapıdan geri gelmiş demektir.

## Yasaklar

Bu çalışma sırasında yapılmayacaklar:

- Eşik, ufuk, kova sınırı veya hacim kesimi **sonuçlara bakılarak**
  ayarlanamaz
- Birincil ufuk sonradan değiştirilemez
- 500 event'e ulaşmadan sonuç istatistiği hesaplanamaz
- KILL çıkarsa "şu alt kümede çalışıyor" diye kurtarma aranmaz
- Negatif bir bulgu ters yönde strateji olarak yeniden yorumlanamaz;
  o ayrı bir hipotezdir ve kendi ön-kaydını gerektirir

Bir hata bulunursa: **dur, hatayı ayrıca raporla, sonra devam et.**
Hata düzeltmesi sonuç yorumuyla aynı adımda yapılmaz.

## Bu ön-kaydı geçersiz kılacak şeyler

- Arşivde saatlerce süren boşluklar (snapshot job alarmı bunu yakalar)
- Toplama kurallarının değişmesi (hacim filtresi eklenmesi gibi)
- API'nin geçmiş penceresini daraltması

Bunlardan biri olursa örneklem homojen değildir ve ön-kayıt yeniden
yazılır.

## Takvim

Ölçülen birikim hızıyla (10 günde 79 event, 7g ufkunda):

| aşama | tarih |
|---|---|
| ön-kayıt yazıldı | 21 Ağustos 2026 |
| sayım kontrolü serbest | her zaman |
| beklenen 500 event | ~24 Ekim 2026 |
| test | eşik aşıldığında, bir kez |

Sayım için: `node scripts/countEventSupply.js` benzeri bir sayım,
arşiv üzerinde çalışacak şekilde eşik geldiğinde güncellenir. Sayım
hiçbir sonuç istatistiği hesaplamaz.

---

## İmza

Bu belge, `data/pricehistory` arşivi 654 market içerirken ve hiçbir
kalibrasyon istatistiği hesaplanmamışken yazılmıştır.

Kapanmış hipotezler: kısa ufuk momentum/orderflow (KILL), maker spread
(KILL), venue mikroyapı (KILL), mekanik arbitraj (KILL), smart money
kopyalama (KILL). Event mispricing, açık kalan tek hipotezdir.
