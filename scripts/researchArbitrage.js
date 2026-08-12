// Mechanical consistency check. No forecasting, no direction.
//   1. Binary complement:  YES + NO must price to exactly 1.
//      A complete set can be minted for $1 and redeems for $1, so
//      yesAsk + noAsk < 1 is free money, and yesBid + noBid > 1 is too.
//   2. Multi-outcome events: mutually exclusive outcomes must sum to 1.
// Both are arithmetic, so any deviation beyond trading cost is an edge
// that does not require being right about anything.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tokens(m) {
  try {
    const t = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : m.tokens || [];
    return t.map(x => (typeof x === "string" ? x : x?.token_id)).filter(Boolean);
  } catch { return []; }
}

async function book(id) {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const raw = await r.json();
    const bids = (raw.bids || []).map(b => ({ p: +b.price, s: +b.size })).sort((a, b) => b.p - a.p);
    const asks = (raw.asks || []).map(a => ({ p: +a.price, s: +a.size })).sort((a, b) => a.p - b.p);
    if (!bids.length || !asks.length) return null;
    return {
      bid: bids[0].p, ask: asks[0].p,
      bidSz: bids[0].s, askSz: asks[0].s,
      mid: (bids[0].p + asks[0].p) / 2,
    };
  } catch { return null; }
}

const res = await fetch(`${GAMMA}/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false`);
const markets = await res.json();
console.log(`${markets.length} aktif market\n`);

const pairs = markets.map(m => ({ m, t: tokens(m) })).filter(x => x.t.length >= 2);
console.log(`YES+NO token çifti olan: ${pairs.length}`);
console.log("kitaplar çekiliyor…");

const rows = [];
for (let i = 0; i < pairs.length; i += 6) {
  const chunk = pairs.slice(i, i + 6);
  const books = await Promise.all(chunk.map(async x => {
    const [y, n] = await Promise.all([book(x.t[0]), book(x.t[1])]);
    return { y, n };
  }));
  chunk.forEach((x, j) => {
    const { y, n } = books[j];
    if (!y || !n) return;
    rows.push({
      q: (x.m.question || "").slice(0, 46),
      vol: +(x.m.volume24hr ?? 0),
      buyCost: y.ask + n.ask,
      sellProceeds: y.bid + n.bid,
      buySize: Math.min(y.askSz, n.askSz),
      sellSize: Math.min(y.bidSz, n.bidSz),
      yesMid: y.mid,
    });
  });
  await sleep(120);
  if (i % 60 === 0) process.stdout.write(".");
}
console.log(`\n${rows.length} markette iki taraflı kitap var\n`);

const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const c = v => (v * 100).toFixed(2);

console.log("── BINARY COMPLEMENT (YES + NO, tam olarak 1 etmeli) ──");
console.log(`  medyan alım maliyeti (yesAsk+noAsk): ${med(rows.map(r => r.buyCost)).toFixed(4)}`);
console.log(`  medyan satış geliri   (yesBid+noBid): ${med(rows.map(r => r.sellProceeds)).toFixed(4)}`);

const buyArb = rows.filter(r => r.buyCost < 0.999).sort((a, b) => a.buyCost - b.buyCost);
const sellArb = rows.filter(r => r.sellProceeds > 1.001).sort((a, b) => b.sellProceeds - a.sellProceeds);

console.log(`\n  set 1'in ALTINA alınabilen market: ${buyArb.length}`);
for (const r of buyArb.slice(0, 12)) {
  console.log(`    maliyet ${r.buyCost.toFixed(4)}  kâr ${c(1 - r.buyCost)}c/set  ` +
    `boyut ${Math.round(r.buySize)}  vol $${Math.round(r.vol)}  ${r.q}`);
}

console.log(`\n  set 1'in ÜSTÜNE satılabilen market: ${sellArb.length}`);
for (const r of sellArb.slice(0, 12)) {
  console.log(`    gelir ${r.sellProceeds.toFixed(4)}  kâr ${c(r.sellProceeds - 1)}c/set  ` +
    `boyut ${Math.round(r.sellSize)}  vol $${Math.round(r.vol)}  ${r.q}`);
}

const totalBuy = buyArb.reduce((s, r) => s + (1 - r.buyCost) * Math.min(r.buySize, 5000), 0);
const totalSell = sellArb.reduce((s, r) => s + (r.sellProceeds - 1) * Math.min(r.sellSize, 5000), 0);
console.log(`\n  görünen toplam (set başına kâr × tepe boyut, 5000 ile sınırlı):`);
console.log(`    alım tarafı  $${totalBuy.toFixed(2)}`);
console.log(`    satım tarafı $${totalSell.toFixed(2)}`);

console.log("\n── ÇOK SONUÇLU EVENTLER (toplam 1 etmeli) ──");
const evRes = await fetch(`${GAMMA}/events?active=true&closed=false&limit=120&order=volume24hr&ascending=false`);
const events = evRes.ok ? await evRes.json() : [];
console.log(`  ${events.length} event çekildi`);

const multi = events.filter(e => Array.isArray(e.markets) && e.markets.length >= 3);
console.log(`  3+ marketli event: ${multi.length}`);

const sums = [];
for (const e of multi.slice(0, 25)) {
  const ids = e.markets.map(m => tokens(m)[0]).filter(Boolean);
  if (ids.length < 3) continue;
  const bs = [];
  for (let i = 0; i < ids.length; i += 6) {
    const part = await Promise.all(ids.slice(i, i + 6).map(book));
    bs.push(...part);
    await sleep(100);
  }
  const ok = bs.filter(Boolean);
  if (ok.length < ids.length * 0.8) continue;
  sums.push({
    title: (e.title || "").slice(0, 46),
    n: ok.length,
    midSum: ok.reduce((s, b) => s + b.mid, 0),
    askSum: ok.reduce((s, b) => s + b.ask, 0),
    bidSum: ok.reduce((s, b) => s + b.bid, 0),
  });
}

for (const s of sums.sort((a, b) => Math.abs(b.midSum - 1) - Math.abs(a.midSum - 1))) {
  const flag = s.askSum < 0.999 ? "  <- hepsini al, 1'in altına"
             : s.bidSum > 1.001 ? "  <- hepsini sat, 1'in üstüne" : "";
  console.log(`  ${s.n} sonuç  mid ${s.midSum.toFixed(4)}  ask ${s.askSum.toFixed(4)}  ` +
    `bid ${s.bidSum.toFixed(4)}  ${s.title}${flag}`);
}

console.log("\nAlım/satım tarafında sistematik sapma varsa, bu yön almadan");
console.log("kazanılan bir edge. Yoksa bu venue kapanır.");
