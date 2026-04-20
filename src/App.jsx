import { useState, useEffect, useRef } from "react";

// ──────────────────────────────────────────────────────────────────────
// App.jsx — orchestration + UI only. All engine logic lives in src/engine/*
// and src/tests/runTests.js. This file contains NO business logic.
// ──────────────────────────────────────────────────────────────────────
import { CFG } from "./config/config.js";
import { MDEFS } from "./config/marketDefs.js";
import { initState, tick } from "./engine/tick.js";
import { runTests } from "./tests/runTests.js";

// ═══════════════════════════════════════════════════════════════════════
//  UI LAYER — RENDERING ONLY
// ═══════════════════════════════════════════════════════════════════════
const FF = "'JetBrains Mono','Fira Code',monospace", SS = "'DM Sans',sans-serif";
const K = { bg: "#060610", s1: "#0c0c18", s2: "#131322", bd: "#24243a", tx: "#e2e2f0", dm: "#5a5a7c", g: "#00e89a", gd: "#00e89a20", r: "#ff3355", rd: "#ff335520", y: "#ffb830", yd: "#ffb83020", b: "#2d8cf0", b2: "#2d8cf020", p: "#9966ff", pd: "#9966ff20", c: "#00ccee", cd: "#00ccee20", o: "#ff8844", od: "#ff884420" };
const bx = (c, bg) => ({ display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 9, fontFamily: FF, color: c, background: bg, fontWeight: 600 });
const cd2 = { background: K.s1, border: "1px solid " + K.bd, borderRadius: 8, padding: 12, marginBottom: 8 };
const mc2 = { background: K.s2, borderRadius: 6, padding: "7px 10px" };
const ft = t => new Date(t).toLocaleTimeString("en", { hour12: false });
const fp = (v, d = 1) => (v * 100).toFixed(d) + "%";
const f$ = (v, d = 0) => "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: d });
const mq = id => MDEFS.find(m => m.id === id)?.q || id;
function Sp({ data, color = K.g, w = 120, h = 24 }) { if (!data || data.length < 2) return null; const mn = Math.min(...data), mx = Math.max(...data), rn = mx - mn || 1; return <svg width={w} height={h} style={{ display: "block" }}><polyline points={data.map((v, i) => ((i / (data.length - 1)) * w) + "," + (h - ((v - mn) / rn) * h)).join(" ")} fill="none" stroke={color} strokeWidth={1.5} /></svg>; }
function St({ l, v, c = K.tx, s }) { return <div style={mc2}><div style={{ fontSize: 9, color: K.dm, fontFamily: FF }}>{l}</div><div style={{ fontSize: 14, fontWeight: 700, fontFamily: FF, color: c, marginTop: 2 }}>{v}</div>{s && <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginTop: 1 }}>{s}</div>}</div>; }
function RB({ s }) { const m = { pass: { c: K.g, b: K.gd }, adjusted: { c: K.y, b: K.yd }, blocked: { c: K.r, b: K.rd } }; const x = m[s] || m.pass; return <span style={bx(x.c, x.b)}>{(s || "").toUpperCase()}</span>; }
const TABS = ["Dashboard", "LOB", "Alpha", "Execution", "Risk", "Metrics", "System", "Tests"];

export default function V50() {
  const [state, setState] = useState(() => initState(42));
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Dashboard");
  const [testResults, setTestResults] = useState(null);
  const intRef = useRef(null);
  useEffect(() => { if (running) { intRef.current = setInterval(() => setState(p => tick(p, Date.now())), 2000); return () => clearInterval(intRef.current); } else clearInterval(intRef.current); }, [running]);
  const st = state, mA = Object.values(st.markets), allOrds = [...st.orders, ...st.orderHistory.slice(-20)].sort((a, b) => b.time - a.time);
  const pm = st.perfMetrics || {};
  return (
    <div style={{ background: K.bg, color: K.tx, minHeight: "100vh", fontFamily: SS, padding: 14 }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#00e89a,#2d8cf0,#9966ff)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: K.bg, fontFamily: FF }}>5.2</div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>Polymarket V5.2</div>
            <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>LOB MATCHING · MARKET IMPACT · ORDERFLOW · COINTEGRATION · VOL-TARGET · EVENT LOG</div></div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span style={bx(st.regime.trend === "trending" ? K.g : st.regime.trend === "mean_reverting" ? K.p : K.dm, st.regime.trend === "trending" ? K.gd : st.regime.trend === "mean_reverting" ? K.pd : K.s2)}>{st.regime.trend}</span>
          <span style={bx(st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r, st.cb.state === "closed" ? K.gd : st.cb.state === "half_open" ? K.yd : K.rd)}>CB:{st.cb.state}</span>
          <span style={bx(running ? K.g : K.r, running ? K.gd : K.rd)}>{running ? "\u25cf LIVE" : "\u25cb OFF"}</span>
          <button onClick={() => { setRunning(r => !r); if (st.cb.state === "open") setState(p => ({ ...p, cb: { ...p.cb, state: "closed", failCount: 0, reason: null, recentRejects: [], recentSlipEvents: [], recentPoorFills: [], recentInvalidData: [], halfOpenNotional: 0, halfOpenFills: 0 } })); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", background: running ? K.r : K.g, color: K.bg, fontFamily: FF, fontSize: 10, fontWeight: 700 }}>{running ? "STOP" : "START"}</button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 1, borderBottom: "1px solid " + K.bd, marginBottom: 10, overflowX: "auto" }}>{TABS.map(t => <button key={t} onClick={() => { setTab(t); if (t === "Tests" && !testResults) setTestResults(runTests()); }} style={{ padding: "6px 10px", background: tab === t ? K.s2 : "transparent", color: tab === t ? K.g : K.dm, border: "none", cursor: "pointer", fontFamily: FF, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", borderBottom: tab === t ? "2px solid " + K.g : "2px solid transparent" }}>{t}</button>)}</div>

      {/* DASHBOARD */}
      {tab === "Dashboard" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Equity" v={f$(st.equity)} c={st.equity >= CFG.initialEquity ? K.g : K.r} />
          <St l="Realized" v={(st.realizedPnl >= 0 ? "+" : "") + f$(st.realizedPnl)} c={st.realizedPnl >= 0 ? K.g : K.r} />
          <St l="Unrealized" v={(st.unrealizedPnl >= 0 ? "+" : "") + f$(st.unrealizedPnl)} c={st.unrealizedPnl >= 0 ? K.g : K.r} />
          <St l="Gross exp" v={f$(st.grossExposure)} c={st.grossExposure > 4000 ? K.y : K.tx} s="notional" />
          <St l="Sharpe" v={pm.sharpe || 0} c={pm.sharpe > 0 ? K.g : K.r} />
          <St l="Drawdown" v={fp(st.currentDD)} c={st.currentDD > 0.1 ? K.r : st.currentDD > 0.05 ? K.y : K.g} />
          <St l="Tick" v={st.tickCount} c={K.b} s={"seed:" + st.seed} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EQUITY (deterministic)</div><Sp data={st.equityCurve} w={640} h={50} color={st.equity >= CFG.initialEquity ? K.g : K.r} /></div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 5 }}>MARKETS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {mA.map(m => { const ch = m.yes - m.prevYes; const q = st.quarantined[m.id]; const lob = st.lobs[m.id]; return <div key={m.id} style={{ ...mc2, display: "flex", justifyContent: "space-between", alignItems: "center", opacity: q ? 0.5 : 1 }}>
              <div style={{ fontSize: 10, maxWidth: "45%" }}>{m.q}{q && <span style={{ ...bx(K.r, K.rd), marginLeft: 4 }}>Q</span>}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {lob && <span style={{ fontFamily: FF, fontSize: 7, color: K.dm }}>sp:{(lob.spread * 100).toFixed(1)}{"\u00A2"}</span>}
                <span style={{ fontFamily: FF, fontSize: 8, color: ch > 0 ? K.g : ch < 0 ? K.r : K.dm }}>{ch > 0 ? "+" : ""}{(ch * 100).toFixed(2)}{"\u00A2"}</span>
                <span style={{ fontFamily: FF, fontSize: 12, fontWeight: 700, color: m.yes > 0.5 ? K.g : K.b }}>{(m.yes * 100).toFixed(1)}{"\u00A2"}</span>
              </div></div>; })}
          </div>
        </div>
      </div>}

      {/* LOB */}
      {tab === "LOB" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {mA.slice(0, 4).map(m => { const lob = st.lobs[m.id]; if (!lob) return null;
            return <div key={m.id} style={cd2}>
              <div style={{ fontSize: 9, fontWeight: 600, marginBottom: 4 }}>{m.q}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: K.dm, fontFamily: FF, marginBottom: 2 }}>BIDS (depth: {lob.bidDepth})</div>
                  {lob.bids.slice(0, 5).map((l, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: FF, fontSize: 8, color: K.g, padding: "1px 0" }}>
                    <span>{(l.px * 100).toFixed(1)}{"\u00A2"}</span>
                    <div style={{ width: Math.min(100, l.qty / 3) + "%", height: 4, background: K.gd, borderRadius: 2, alignSelf: "center", marginLeft: 4, flex: 1 }} />
                    <span style={{ marginLeft: 4, minWidth: 30, textAlign: "right" }}>{l.qty}</span>
                  </div>)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 7, color: K.dm, fontFamily: FF, marginBottom: 2 }}>ASKS (depth: {lob.askDepth})</div>
                  {lob.asks.slice(0, 5).map((l, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: FF, fontSize: 8, color: K.r, padding: "1px 0" }}>
                    <span>{(l.px * 100).toFixed(1)}{"\u00A2"}</span>
                    <div style={{ width: Math.min(100, l.qty / 3) + "%", height: 4, background: K.rd, borderRadius: 2, alignSelf: "center", marginLeft: 4, flex: 1 }} />
                    <span style={{ marginLeft: 4, minWidth: 30, textAlign: "right" }}>{l.qty}</span>
                  </div>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 7, color: K.dm, marginTop: 4 }}>
                <span>Spread: {(lob.spread * 100).toFixed(2)}{"\u00A2"}</span>
                <span>Mid: {(lob.midPrice * 100).toFixed(1)}{"\u00A2"}</span>
                <span>Vol: {lob.volumeThisTick}</span>
              </div>
            </div>; })}
        </div>
      </div>}

      {/* ALPHA */}
      {tab === "Alpha" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>META-ALPHA WEIGHTS (regime-aware · vol-targeted)</div>
          {Object.entries(st.alphaWeights).map(([k, v]) => <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 2 }}><span>{k} <span style={{ fontSize: 8, color: K.dm }}>({st.metaPerf[k]?.length || 0})</span></span><span style={{ fontFamily: FF, fontWeight: 700, color: v > 0.4 ? K.g : K.dm }}>{fp(v, 0)}</span></div>
            <div style={{ height: 5, background: K.s2, borderRadius: 3, overflow: "hidden" }}><div style={{ width: v * 100 + "%", height: "100%", background: k === "nlp" ? K.c : k === "momentum" ? K.p : K.b, borderRadius: 3 }} /></div>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>NEWS</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>{st.newsLog.slice(0, 8).map(n => <div key={n.id} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 9, alignItems: "center" }}>
            <span style={{ fontFamily: FF, fontSize: 8, color: K.dm, minWidth: 35 }}>{ft(n.time)}</span>
            <span style={bx(K.tx, K.s2)}>{n.source}</span>
            <span style={{ flex: 1 }}>{n.headline}</span>
            <span style={bx(n.impactClass === "binary_catalyst" ? K.r : K.y, n.impactClass === "binary_catalyst" ? K.rd : K.yd)}>{n.impactClass === "binary_catalyst" ? "CAT" : "SHIFT"}</span>
          </div>)}</div>
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>SIGNALS ({st.signals.length})</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9, fontFamily: FF }}><thead><tr style={{ color: K.dm, textAlign: "left" }}><th style={{ padding: 2 }}>SRC</th><th>MKT</th><th>DIR</th><th>EDGE</th><th>FR</th></tr></thead>
              <tbody>{st.signals.slice(0, 10).map(s2 => <tr key={s2.id}><td style={{ padding: 2 }}><span style={bx(s2.source === "nlp" ? K.c : s2.source === "momentum" ? K.p : K.b, s2.source === "nlp" ? K.cd : s2.source === "momentum" ? K.pd : K.b2)}>{s2.source}</span></td>
                <td style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(s2.cid)}</td>
                <td><span style={bx(s2.dir === "BUY_YES" ? K.g : K.r, s2.dir === "BUY_YES" ? K.gd : K.rd)}>{s2.dir === "BUY_YES" ? "Y" : "N"}</span></td>
                <td style={{ color: K.y }}>{s2.ee ? fp(s2.ee, 2) : fp(s2.edge, 2)}</td>
                <td style={{ color: (s2.fr || 1) > 0.5 ? K.g : K.r }}>{s2.fr ? fp(s2.fr, 0) : "\u2014"}</td></tr>)}</tbody></table>
          </div>
        </div>
      </div>}

      {/* EXECUTION */}
      {tab === "Execution" && <div style={cd2}>
        <div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ORDERS — LOB MATCHING · FIFO FILLS · ADAPTIVE LIMITS</div>
        {allOrds.length === 0 && <div style={{ color: K.dm, fontSize: 10 }}>No orders...</div>}
        <div style={{ maxHeight: 420, overflowY: "auto" }}>{allOrds.slice(0, 12).map(e => <div key={e.id} style={{ ...mc2, marginBottom: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
            <span style={{ fontSize: 9, fontWeight: 600, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mq(e.cid)}</span>
            <div style={{ display: "flex", gap: 2 }}>
              <span style={bx(e.side === "YES" ? K.g : K.r, e.side === "YES" ? K.gd : K.rd)}>{e.side}</span>
              <span style={bx(e.status === "FILLED" ? K.g : e.status === "PARTIALLY_FILLED" ? K.y : e.status === "CANCELLED" || e.status === "REJECTED" ? K.r : e.status === "REPLACED" ? K.o : K.b, e.status === "FILLED" ? K.gd : e.status === "PARTIALLY_FILLED" ? K.yd : e.status === "CANCELLED" || e.status === "REJECTED" ? K.rd : e.status === "REPLACED" ? K.od : K.b2)}>{e.status}</span>
              <span style={bx(K.p, K.pd)}>{e.strat}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 5, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
            <span>Sz:{f$(e.parentSz)}</span><span>Fill:<b style={{ color: K.g }}>{f$(e.totalFilled)}</b>({fp(e.fillRate, 0)})</span>
            {e.slipBps != null && <span>Slip:<b style={{ color: e.slipBps > CFG.maxSlipBps ? K.r : K.g }}>{e.slipBps}bps</b></span>}
          </div>
          <div style={{ display: "flex", gap: 1.5, marginTop: 2 }}>{e.children.slice(0, 20).map(ch => <div key={ch.id} style={{ width: Math.max(8, ch.sz / 8), height: 5, borderRadius: 2, background: ch.st === "FILLED" ? K.g : ch.st === "REJECTED" ? K.r : ch.st === "CANCELLED" ? K.o : K.bd, opacity: 0.7 }} />)}</div>
          {e.partialAction && <div style={{ marginTop: 2, padding: "2px 4px", borderRadius: 3, background: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.rd : K.yd, fontSize: 8, fontFamily: FF }}>
            <span style={{ color: e.partialAction.action === "UNWIND" || e.partialAction.action === "CANCEL" ? K.r : K.y, fontWeight: 600 }}>{e.partialAction.action}</span>
            <span style={{ color: K.dm }}> {e.partialAction.reason}</span>
          </div>}
        </div>)}</div>
      </div>}

      {/* RISK */}
      {tab === "Risk" && <div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>POSITION LEDGER — LOB-priced · notional exposure · correlated exposure check</div>
          {Object.keys(st.positions).length === 0 && <div style={{ color: K.dm, fontSize: 9 }}>No positions</div>}
          {Object.entries(st.positions).map(([id, p]) => { const m = st.markets[id]; const uY = p.yesQty * ((m?.yes || 0) - p.yesAvgPx); const uN = p.noQty * ((1 - (m?.yes || 0)) - p.noAvgPx);
            return <div key={id} style={{ marginBottom: 5 }}>
              <div style={{ fontSize: 8, marginBottom: 1 }}>{mq(id)} <span style={{ color: K.dm }}>({m?.cat})</span></div>
              <div style={{ display: "flex", gap: 6, fontFamily: FF, fontSize: 8, color: K.dm, flexWrap: "wrap" }}>
                <span>YES:{p.yesQty}@{(p.yesAvgPx * 100).toFixed(1)}{"\u00A2"}</span>
                <span>NO:{p.noQty}@{(p.noAvgPx * 100).toFixed(1)}{"\u00A2"}</span>
                <span style={{ color: K.g }}>rPnL:{f$(p.realizedPnl, 2)}</span>
                <span style={{ color: (uY + uN) >= 0 ? K.g : K.r }}>uPnL:{f$(uY + uN, 2)}</span>
              </div>
              <div style={{ height: 4, background: K.s2, borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
                <div style={{ width: Math.min(((p.yesQty + p.noQty) / CFG.maxPos) * 100, 100) + "%", height: "100%", background: (p.yesQty + p.noQty) / CFG.maxPos > 0.8 ? K.r : K.g, borderRadius: 2 }} />
              </div>
            </div>; })}
        </div>
      </div>}

      {/* METRICS */}
      {tab === "Metrics" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Sharpe" v={pm.sharpe || 0} c={pm.sharpe > 0 ? K.g : K.r} />
          <St l="Win Rate" v={(pm.winRate || 0) + "%"} c={pm.winRate > 50 ? K.g : K.r} />
          <St l="Avg Slip" v={(pm.avgSlipBps || 0) + "bps"} c={pm.avgSlipBps < 20 ? K.g : K.r} />
          <St l="Exec Qual" v={pm.execQuality || "—"} c={pm.execQuality === "good" ? K.g : pm.execQuality === "fair" ? K.y : K.r} />
          <St l="Total Fills" v={pm.totalFills || 0} c={K.b} />
          <St l="Events" v={(st.eventLog || []).length} c={K.p} s="append-only" />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>ALPHA CONTRIBUTION (realized PnL by source)</div>
          {pm.alphaContrib && Object.entries(pm.alphaContrib).map(([src, val]) => <div key={src} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid " + K.bd + "10" }}>
            <span style={{ fontSize: 10 }}>{src}</span>
            <span style={{ fontFamily: FF, fontSize: 10, fontWeight: 700, color: val >= 0 ? K.g : K.r }}>{val >= 0 ? "+" : ""}{f$(val, 2)}</span>
          </div>)}
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>EVENT LOG (last 15)</div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {(st.eventLog || []).slice(-15).reverse().map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 8, fontFamily: FF, borderBottom: "1px solid " + K.bd + "08" }}>
              <span style={{ color: K.dm, minWidth: 30 }}>t{e.tick}</span>
              <span style={bx(e.type === "FILL" ? K.g : e.type === "ORDER" ? K.b : K.p, e.type === "FILL" ? K.gd : e.type === "ORDER" ? K.b2 : K.pd)}>{e.type}</span>
              <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 250 }}>{JSON.stringify(e.data).slice(0, 60)}</span>
            </div>)}
          </div>
        </div>
      </div>}

      {/* SYSTEM */}
      {tab === "System" && <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginBottom: 8 }}>
          <St l="Approvals" v={st.monitor.approvals} c={K.g} s={st.monitor.rejections + " rej"} />
          <St l="Fills" v={st.fills.length} c={K.g} s="append-only" />
          <St l="CB state" v={st.cb.state} c={st.cb.state === "closed" ? K.g : st.cb.state === "half_open" ? K.y : K.r} s={"rej:" + (st.cb.recentRejects||[]).length + " slip:" + (st.cb.recentSlipEvents||[]).length} />
          <St l="Spawns" v={(st.spawnStats?.existing||0) + (st.spawnStats?.new||0)} c={K.p} s={"def:" + (st.spawnStats?.deferred||0)} />
        </div>
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 4 }}>RECONCILIATION</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5 }}>
            <St l="Status" v={st.lastRecon.ok ? "OK" : "DRIFT"} c={st.lastRecon.ok ? K.g : K.r} />
            <St l="Issues" v={st.lastRecon.issues} c={st.lastRecon.issues > 0 ? K.r : K.g} />
            <St l="Drifts" v={st.lastRecon.drifts} c={st.lastRecon.drifts > 0 ? K.r : K.g} />
            <St l="Orphans" v={st.lastRecon.orphans} c={st.lastRecon.orphans > 0 ? K.r : K.g} />
          </div>
        </div>
        {st.cb.triggers.length > 0 && <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>CB TRIGGERS</div>
          {st.cb.triggers.slice(-6).map((t2, i) => <div key={i} style={{ fontSize: 8, fontFamily: FF, color: K.r, padding: "1px 0" }}>{ft(t2.t)} {t2.from}{"\u2192"}{t2.to} {t2.r}</div>)}</div>}
        <div style={cd2}><div style={{ fontSize: 8, color: K.dm, fontFamily: FF, marginBottom: 3 }}>EVENTS ({st.events.length})</div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>{st.events.slice().reverse().slice(0, 20).map((e, i) => <div key={i} style={{ display: "flex", gap: 4, padding: "2px 0", fontSize: 8, fontFamily: FF }}>
            <span style={{ color: K.dm, minWidth: 40 }}>{ft(e.ts)}</span>
            <span style={bx(e.evt.includes("reject") || e.evt.includes("partial") ? K.r : e.evt.includes("recon") ? K.c : e.evt.includes("exec") ? K.g : K.dm, e.evt.includes("reject") || e.evt.includes("partial") ? K.rd : e.evt.includes("recon") ? K.cd : e.evt.includes("exec") ? K.gd : K.s2)}>{e.evt}</span>
            <span style={{ color: K.dm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 250 }}>{e.s}</span>
          </div>)}</div>
        </div>
        <div style={{ ...cd2, fontSize: 8, fontFamily: FF, color: K.dm }}>
          <b style={{ color: K.tx }}>V5.0 engine guarantees:</b><br />
          [Phase 1] LOB: FIFO matching, queue position, depth consumption. No random fills.<br />
          [Phase 2] Impact: {"\u221A"}(qty/ADV) model, adverse selection, decaying temp impact.<br />
          [Phase 3] Alpha: orderflow imbalance, cointegrated stat arb, multi-TF momentum.<br />
          [Phase 4] Portfolio: correlation matrix, vol-targeted sizing, Kelly{"\u00D7"}regime cap.<br />
          [Phase 5] Execution: adaptive limits, TWAP schedule, cancel/replace on drift.<br />
          [Phase 6] Event log: append-only, bounded, structured, replayable.<br />
          [Phase 7] Metrics: Sharpe, win rate, avg slip, exec quality, alpha contribution.
        </div>
      </div>}

      {/* TESTS */}
      {tab === "Tests" && <div style={cd2}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 8, color: K.dm, fontFamily: FF }}>V5.0 DETERMINISTIC TEST SUITE</div>
          <button onClick={() => setTestResults(runTests())} style={{ padding: "4px 10px", borderRadius: 4, border: "none", cursor: "pointer", background: K.b, color: K.bg, fontFamily: FF, fontSize: 9, fontWeight: 700 }}>RUN TESTS</button>
        </div>
        {testResults && <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 5, marginBottom: 8 }}>
            <St l="Total" v={testResults.length} c={K.b} />
            <St l="Passed" v={testResults.filter(t => t.pass).length} c={K.g} />
            <St l="Failed" v={testResults.filter(t => !t.pass).length} c={testResults.filter(t => !t.pass).length > 0 ? K.r : K.g} />
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {testResults.map((t, i) => <div key={i} style={{ display: "flex", gap: 6, padding: "3px 0", fontSize: 9, fontFamily: FF, alignItems: "center" }}>
              <span style={bx(t.pass ? K.g : K.r, t.pass ? K.gd : K.rd)}>{t.pass ? "PASS" : "FAIL"}</span>
              <span style={{ color: t.pass ? K.dm : K.r }}>{t.name}</span>
            </div>)}
          </div>
        </div>}
        {!testResults && <div style={{ color: K.dm, fontSize: 10 }}>Click RUN TESTS to execute the test suite.</div>}
      </div>}

      <div style={{ textAlign: "center", padding: "10px 0 4px", fontSize: 7, color: K.dm, fontFamily: FF }}>V5.2 · SEED:{st.seed} · TICK:{st.tickCount} · SHARPE:{pm.sharpe||0} · FILLS:{st.fills.length} · REALIZED:{f$(st.realizedPnl)} · NOT FINANCIAL ADVICE</div>
    </div>
  );
}
