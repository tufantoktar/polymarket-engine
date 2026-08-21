# Known Issues

Every quarantined stage in `scripts/verify.js` **must** have an entry here
with a root cause and an expiry date. Quarantine is a deliberate, visible,
temporary decision — never a silent skip. If an entry passes its expiry
date without resolution, promote the stage back to `mandatory` and let it
block until it is fixed.

---

## KI-001 — CLOB V2 client is constructed with the wrong call shape

- **Stage:** `v2` — **KAPALI**, karantinadan çıktı, artık zorunlu
- **Opened:** 2026-08-11
- **Closed:** 2026-08-21
- **Severity:** HIGH — blocks live mode entirely

### Düzeltme (21 Ağustos 2026)

Constructor tek options objesi alıyor, ve alan adı `chain` — `chainId`
değil. Pozisyonel çağrı yüzünden `host` undefined geliyordu.

İkinci bir katman daha vardı: kod `createOrDeriveApiCreds` /
`createOrDeriveApiKey` arıyordu, oysa SDK v1.1.0'da bu isimde bir metot
**yok**. Gerçek isimler `deriveApiKey` ve `createApiKey`. Yani
constructor düzeltilse bile kimlik türetme adımı patlardı. Artık önce
`deriveApiKey` deneniyor — cüzdandan deterministik ve idempotent —
başarısız olursa `createApiKey`'e düşülüyor.

`_importV2` enjekte edilebilir hale getirildi. Bu kusurun aylarca
yaşamasının sebebi buydu: SDK doğrudan import edildiği için yolu test
etmek SDK, anahtar ve ağ gerektiriyordu. 12 yeni iddia çağrı şeklini
sahte bir SDK ile, ağa çıkmadan doğruluyor.

`testV2Migration` #18 de düzeltildi. "SDK yokken açık hata ver" diye
yazılmıştı ama paket bir `optionalDependency` ve kurulu olduğu her
ortamda test ölçmediği bir sebepten kırmızı kalıyordu — KI-001'in
kanıtını taşıyan test, kendi öncülü yanlış olduğu için kimsenin
bakmadığı bir kırmızıya dönüşmüştü. Artık öncül açıkça yoklanıyor.
- **Money at risk today:** none (engine runs paper/collect only)

### Symptom

    FAIL: client: error mentions V2 package
          (Cannot read properties of undefined (reading 'endsWith'))

Previously misread as "the V2 SDK is not installed — run `npm run install:live`".
That diagnosis was wrong.

### Actual root cause

`@polymarket/clob-client-v2` **is** installed — it is declared in
`optionalDependencies`, so a plain `npm install` pulls it in. The test's
premise ("live mode without the V2 SDK") therefore cannot hold in a normal
install, and execution proceeds past the import into the SDK constructor.

The installed SDK (v1.1.0) takes a single options object:

    // node_modules/@polymarket/clob-client-v2/dist/client.js:46
    constructor({ host, chain, signer, creds, signatureType, funderAddress, ... }) {
      this.host = host.endsWith("/") ? host.slice(0, -1) : host;

but `src/live/polymarketClient.js` calls it positionally:

    // _getClobClient(), lines ~109 and ~120
    const boot = new ClientCtor(c.host, c.chainId, signer);
    this._clob   = new ClientCtor(c.host, c.chainId, signer, creds,
                                  c.signatureType, c.funderAddress || undefined);

The object destructure yields `host === undefined`, so `host.endsWith(...)`
throws immediately.

### Consequence

**The live order path has never worked against SDK v1.1.0.** Any attempt to
place a real order would crash inside `_getClobClient()` before reaching the
exchange. This fails safe (a crash places no order), but it means live mode
is non-functional, not merely untested.

### Why it is quarantined rather than fixed here

The fix touches `src/live/polymarketClient.js` — the order-submission path,
a protected path. Protected changes require an explicit human decision and a
green safety suite, and the safety suite (Phase 2) does not exist yet.
Quarantining keeps the other 66 V2 assertions running and visible while the
gate is built.

### Resolution plan

1. Phase 2: implement `scripts/testSafetyGates.js`, including a gate that
   asserts the SDK constructor is invoked with the object shape it declares.
2. Fix `_getClobClient()` to pass a single options object.
3. Rewrite `testV2Migration` #18 so its premise is real — simulate SDK
   absence explicitly instead of relying on it being uninstalled.
4. Promote stage `v2` back to `mandatory` in `scripts/verify.js` and delete
   this entry.

Do **not** close this by weakening assertion #18.

---

## KI-002 — LiveRiskEngine does not validate its inputs

**Bulunma:** 21 Ağustos 2026, `scripts/testSafetyGates.js` ilk koşusu
**Durum:** KAPALI — 21 Ağustos 2026, aynı gün düzeltildi
**Düzeltme:** `validateOrderInput`, `checkOrder`'ın ilk adımı olarak
eklendi. Tip ve aralık önce kuruluyor, limitler ondan sonra hesaplanıyor.
`side` artık zorunlu ve varsayılanı yok. Süit karantinadan zorunluya
terfi etti; 27/27.

### Kök neden

`checkOrder` limitleri kontrol ediyor ama **girdinin kendisini** hiç
doğrulamıyor. Sayısal karşılaştırmalar NaN'la sessizce false döndüğü
için bozuk bir emir bütün guard zincirini dokunulmadan geçiyor.

### Kanıt (16 başarısız iddia)

**Fiyat — hiç doğrulanmıyor.** Şunların hepsi `ok:true` dönüyor:
`0`, `-0.5`, `1`, `1.5`, `NaN`, `"0.5"`, `undefined`.

`price=undefined` durumunda `notional` NaN oluyor, `NaN > maxOrderNotional`
false, ve emir geçiyor. Sıfır ya da bir fiyat bir ikili kontratta
tanımsızdır: sıfırda ödeme yok, birde risk yok.

**Boyut — yarım doğrulanıyor.** `0` ve negatif yakalanıyor (`adjSize < 1`
sayesinde), ama `NaN`, `"10"`, `undefined` ve `Infinity` geçiyor.
String olan `adjustedSize: "10"` olarak çıkıp tipi aşağıya sızdırıyor.

**Yön — bozuksa sessizce tersine çevriliyor.**
`order.side === "BUY" ? adjSize : -adjSize` yazıldığı için `"BUY"`
dışındaki her şey SELL sayılıyor: eksik yön, `"buy"`, `null`, `""`.
Küçük harfli bir `"buy"` alım emrini satış emrine dönüştürür.

### Şu anki hafifletme

Paper mode. Ayrıca KI-001 nedeniyle canlı emir yolu hiç çalışmamış
durumda. Yani bugün gerçek para riski yok — ama bu iki kusurdan
birinin düzelmesi diğerini tek başına tehlikeli hale getirir.

### Neden test önce yazıldı

Düzeltmeden sonra yazılan bir test, düzeltmenin neyi değiştirdiğini
kanıtlamaz. Bu iddialar kusur açıkken commit'lendi.
