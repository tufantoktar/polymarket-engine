# Research Decision Gate

Each hypothesis was given a fair test and an explicit kill criterion
before the result was known. Negative results are kept here because the
main cost of research is repeating a question that has already been
answered.

| Hypothesis | Verdict | Evidence | Power |
|---|---|---|---|
| Data integrity | **PASS** | 39.3x feed duplication found and fixed | 376,808 rows to 9,594 distinct |
| Short-horizon microstructure | **KILL** | signal edge about 0 against a 240 bps round trip | 122h, event-controlled |
| Maker / spread capture | **KILL** | adverse selection exceeds the spread at 1-5 min | 789 real passive fills |
| Mechanical arbitrage | **KILL** | YES+NO priced to exactly one tick either side | whole venue sample |
| Event mispricing | **INSUFFICIENT DATA** | hint of -5pt in Politics, but 11 events | 60 usable events |
| Long-horizon drift | **INSUFFICIENT DATA** | not run, same data ceiling as above | - |
| Smart money | **KILL** | past performance anti-predicts future | 2,033 wallets, 244 events, 441k trades |

---

## Smart money — the decisive one

Question, deliberately narrow: do wallets that showed good probability
judgement in the past make later trades that beat the price they traded
at, out of sample?

A trade is a probability claim, so profit per contract held to
resolution is exactly how far that claim beat the market. The market
baseline is therefore zero by construction.

Wallets were ranked using only markets resolved before a cutoff, then
measured on markets resolved after it.

        past      future            95% CI
  D10 +14.54c    -1.40c    [-3.29c, +0.69c]
  D9   +6.03c    +1.54c    [+0.42c, +2.82c]
  D8   +3.54c    -0.95c    [-3.22c, +1.11c]
  D5   +0.13c    +1.05c    [+0.31c, +1.70c]
  D2   -5.48c    +1.27c    [-0.37c, +2.52c]
  D1  -13.40c    -0.92c    [-2.70c, +0.64c]

Three things kill it.

The top decile turns negative. Wallets averaging +14.54c historically
returned -1.40c afterwards. Their record was luck, and ranking on luck
buys its reversal.

Ranking on past performance did worse than not ranking at all. The top
decile beat only 1% of randomly drawn groups from the same pool. This is
the winner's curse in its clearest form.

No monotone relationship survives. 56% of decile steps move the right
way, which is a coin flip. D5, D6 and D9 have intervals above zero, but
testing ten deciles and finding two or three nominally positive is what
chance produces, and they form no pattern.

Independence is also weaker than the headcount suggests: 774 pairs in the
top decile share five or more identical positions, six pairs overlap above
50%. Two hundred wallets are not two hundred opinions.

Sanity check that makes the rest trustworthy: the mean across all 1.1M
trades is 0.02c. Every trade has a counterparty, so a population that
could beat itself would indicate a broken sample.

This is a well-powered no, not a shrug. More data would not change it.

---

## Event mispricing — why it stopped

Not a negative result. A data ceiling.

  resolved markets reachable via API   2,100
  with any CLOB price history            324  (15%)
  median market lifespan            11.4 days   -> the 30d horizon is empty
  usable independent events               60
  events in the Politics bucket           11

Prices for the other 85% are absent, not mis-requested: the endpoint
returns 200 with zero points for every parameter combination tried, while
returning 193 points for a market that did trade. Those markets simply
never traded enough to have a price.

There is a hint worth recording: calibration error was -2 to -4 points
across the 7d, 3d and 1d horizons, and -5 to -7 in Politics at every
horizon, with an ECE interval of [0.053, 0.112] that excludes zero. But
eleven events cannot support that claim, and the walk-forward split shows
the direction does not persist.

Long-horizon drift depends on the same price history and was not run for
the same reason.

---

## What would reopen these

Event mispricing and long-horizon drift need forward collection: record
resolved markets and their price paths as they happen, for months. The
API will not supply the history retrospectively.

Smart money does not reopen. The question was answered with adequate
power.

---

## Smart Money — KILL (13 Ağustos 2026)

**Soru:** Geçmişte iyi probability judgement göstermiş cüzdanların sonraki
işlemleri, işlem anındaki Polymarket fiyatından out-of-sample olarak daha
iyi sonuç tahmin ediyor mu?

**Cevap: Hayır.**

Kesim 2026-03-20 (tam veriden bir kez hesaplandı, iki koşuda da aynı).
Cüzdan eşikleri 10+ işlem / 3+ event, test 5+ işlem. Skorlama yalnızca
kesim öncesi veriyi görüyor; gelecek performans skora hiç girmiyor.

| | ORİJİNAL | COMPLETE ONLY |
|---|---|---|
| D10 geçmiş edge | +14.54c | — |
| D10 gelecek edge | −1.40c | +0.24c |
| %95 (event-kümeli) | [−3.52c, 1.06c] | [−2.44c, 2.95c] |
| event | 161 | 122 |
| rastgele yüzdelik | %1 | %20 |
| decile sıralaması | %56 | %56 |

Giriş maliyeti eşiği 1.00c. İki koşuda da aralık sıfırı içeriyor ve nokta
tahmini maliyetin altında.

### En anlamlı bulgu

Complete-only koşuda D10 +0.24c, aynı havuzdan rastgele seçilen cüzdan
gruplarının medyanı +0.89c. Yani "geçmişte iyi yargı göstermiş" diye
seçtiğimiz cüzdanlar rastgele seçilenlerden daha kötü performans veriyor.
Seçim kriteri bilgi taşımıyor. Kazananın laneti tam olarak böyle görünür:
geçmiş +14.54c'lik ayrışma, becerinin değil örneklem gürültüsünün üst
kuyruğunu seçmiş.

### Cüzdan bağımsızlığı

D10'da 203 cüzdan, 5+ ortak pozisyonlu 774 çift, en yüksek benzerlik %59.
%50 üstü örtüşen 8 çift tek aktör sayıldığında (203 -> 195 cüzdan)
D10 −1.40c'den −1.41c'ye gitti. Sonuç birkaç bağlantılı cüzdanın eseri
değil.

### Yöntem notu — kayda değer

Satır bazlı bootstrap, aynı eventteki işlemleri bağımsız sayıyor ve bu
veride yanlış. Doğru aralıktan 2.6x (orijinal) ve 2.0x (complete) dar
çıkıyor. O yanlış yöntemle orijinal koşu kabaca [−2.29c, −0.52c] verirdi:
sıfırı dışlayan, istatistiksel olarak anlamlı NEGATİF bir sonuç. Yanlış
bağımsızlık varsayımı olmayan bir kesinlik üretiyor — her iki yönde de.

Hız için `fastClusterMeanCI` eklendi: ortalama için küme başına (toplam,
adet) önceden hesaplanıyor, her iterasyonda satır kopyalanmıyor. Aynı
seed ile paylaşılan `clusterBootstrapCI` ile 8 hanede birebir aynı
sonucu verdiği doğrulandı. Koşu süresi ~40dk'dan 15 saniyeye indi.

### Karar

**SmartMoneyCopyStrategy → DISABLED / EXPERIMENTAL.**
Üretime uygun değil. `SMART_MONEY_ENABLED` opt-in kalır ve varsayılan
KAPALI. Canlı ya da paper üretim koşusunda açılmaz.

**WalletIntelligenceEngine → KEEP (araştırma altyapısı).**
Skorlama, decile ve örtüşme araçları doğru çalışıyor; hipotezi çürüten
ölçüm bunlarla yapıldı. Silinmez, ama sinyal üretmez.

**Korunan altyapı:** `src/research/walletScoring.js`,
`src/research/calibration.js`, `scripts/researchSmartMoney.js`,
`scripts/researchSmartMoneyRobustness.js`, `src/data/tradeDedup.js`.

### Bu araştırmanın SONUÇLANDIRMADIĞI şeyler

- Negatif D10 bir "ters yönde kopyalama stratejisi" DEĞİLDİR. Bu ayrı bir
  hipotezdir, kendi ön-kayıtlı deneyini gerektirir ve burada test
  edilmemiştir. Aynı veriden okunması aynı gürültüyü ikinci kez
  kullanmak olur.
- Eşik ayarı, skor formülü değişikliği veya alternatif decile tanımı
  denenmedi. Kasıtlı: hipotez reddedildikten sonra yapılan arama,
  arama değil kurtarma girişimidir.

### Kapanan hipotezler (kümülatif)

| hipotez | karar | dayanak |
|---|---|---|
| Kısa ufuk momentum/orderflow | KILL | sinyal−kontrol ~0 vs 2.00c maliyet |
| Maker spread yakalama | KILL | ters seçim −0.52c/−1.83c vs 0.72c |
| Venue mikroyapı | KILL | medyan spread = tick, 84 markette 1 kote |
| Mekanik arbitraj | KILL | YES+NO 1.0100/0.9900, tam bir tick |
| Event mispricing | YETERSİZ VERİ | 60 kullanılabilir event |
| Smart money kopyalama | KILL | D10 gelecek −1.40c / +0.24c, ikisi de sıfırı içeriyor |
