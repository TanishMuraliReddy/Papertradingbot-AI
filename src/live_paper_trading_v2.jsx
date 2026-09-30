import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, ReferenceLine } from "recharts";

// ─────────────────────────────────────────────────────────────
// INDICATOR MATH
// ─────────────────────────────────────────────────────────────
const calcEMA = (arr, period) => {
  const k = 2 / (period + 1), out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) { out.push(arr.slice(0, period).reduce((s, v) => s + v, 0) / period); continue; }
    out.push(out[i - 1] * (1 - k) + arr[i] * k);
  }
  return out;
};
const calcRSI = (closes, period = 14) => {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; gains += Math.max(0, d); losses += Math.max(0, -d); }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (period - 1) + Math.max(0, d)) / period; al = (al * (period - 1) + Math.max(0, -d)) / period; }
  return al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
};
const calcATR = (candles, period = 14) => {
  if (candles.length < period) return null;
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
};
const calcMACD = (closes) => {
  if (closes.length < 35) return null;
  const fast = calcEMA(closes, 12), slow = calcEMA(closes, 26);
  const macdLine = fast.map((v, i) => v !== null && slow[i] !== null ? v - slow[i] : null);
  const validMacd = macdLine.filter(v => v !== null);
  const signal = calcEMA(validMacd, 9);
  const mVal = macdLine[macdLine.length - 1], sVal = signal[signal.length - 1];
  const mPrev = macdLine[macdLine.length - 2], sPrev = signal[signal.length - 2];
  if (mVal == null || sVal == null) return null;
  return { macd: mVal, signal: sVal, histogram: mVal - sVal, bullCross: mVal > sVal && mPrev <= sPrev, bearCross: mVal < sVal && mPrev >= sPrev };
};
const calcBB = (closes, period = 20, mult = 2) => {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean };
};
const calcUTBot = (candles, sensitivity = 1.5) => {
  if (candles.length < 16) return null;
  const atr = calcATR(candles, 14);
  if (!atr) return null;
  const nLoss = sensitivity * atr;
  const curr = candles[candles.length - 1].close, prev = candles[candles.length - 2].close;
  const trail = prev;
  let newTrail, dir;
  if (curr > trail) { newTrail = Math.max(trail, curr - nLoss); dir = 1; }
  else { newTrail = Math.min(trail, curr + nLoss); dir = -1; }
  const prevDir = prev > trail ? 1 : -1;
  return { trail: newTrail, dir, flip: dir !== prevDir };
};
// PHANTOM-specific
const calcADX = (candles, period = 14) => {
  if (candles.length < period * 2) return null;
  const slice = candles.slice(-period * 2);
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const sTR = tr.slice(-period).reduce((s, v) => s + v, 0);
  if (sTR === 0) return null;
  const diP = plusDM.slice(-period).reduce((s, v) => s + v, 0) / sTR * 100;
  const diM = minusDM.slice(-period).reduce((s, v) => s + v, 0) / sTR * 100;
  const adx = (diP + diM) === 0 ? 0 : (Math.abs(diP - diM) / (diP + diM)) * 100;
  return { adx: +adx.toFixed(2), diPlus: diP, diMinus: diM };
};
const calcROC = (closes, p) => closes.length < p + 1 ? null : +((closes[closes.length - 1] - closes[closes.length - 1 - p]) / closes[closes.length - 1 - p] * 100).toFixed(4);
const calcOFI = (candles) => {
  if (candles.length < 5) return 0;
  let buy = 0, sell = 0;
  for (const c of candles.slice(-5)) {
    const range = c.high - c.low || 0.0001;
    const body = Math.abs(c.close - c.open) / range;
    const wick = (Math.min(c.open, c.close) - c.low - (c.high - Math.max(c.open, c.close))) / range;
    const vol = c.volume || 1;
    if (c.close > c.open) buy += body * vol * (1 + wick); else sell += body * vol * (1 - wick);
  }
  const t = buy + sell;
  return t === 0 ? 0 : +((buy - sell) / t).toFixed(4);
};
const classifyRegime = (candles, closes) => {
  const adx = calcADX(candles);
  if (!adx) return "unknown";
  if (candles.length < 31) return "unknown";
  const rets = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const std = (arr) => { const m = arr.reduce((s, v) => s + v, 0) / arr.length; return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); };
  const vr = std(rets.slice(-10)) / (std(rets.slice(-30)) || 0.0001);
  if (vr > 1.8) return "volatile";
  if (adx.adx > 25 && adx.diPlus > adx.diMinus) return "trending_up";
  if (adx.adx > 25 && adx.diMinus > adx.diPlus) return "trending_down";
  if (adx.adx < 20) return "ranging";
  return "neutral";
};
const calcMomentumScore = (closes) => {
  const r5 = calcROC(closes, 5), r10 = calcROC(closes, 10), r20 = calcROC(closes, 20), rsi = calcRSI(closes);
  if (r5 == null || r10 == null || r20 == null || rsi == null) return null;
  const n = (v, mn, mx) => Math.max(0, Math.min(1, (v - mn) / (mx - mn)));
  return +((n(r5, -5, 5) * 0.4 + n(r10, -8, 8) * 0.3 + n(r20, -12, 12) * 0.2 + n(rsi, 0, 100) * 0.1) * 100).toFixed(1);
};

// ─────────────────────────────────────────────────────────────
// STRATEGIES
// ─────────────────────────────────────────────────────────────
const STRATEGIES = {
  "UT+MACD+RSI": {
    name: "UT Bot + MACD + RSI", color: "#00d4ff", tag: "MOMENTUM",
    desc: "ATR trailing stop · MACD crossover · RSI filter",
    signal: (candles) => {
      if (candles.length < 40) return { signal: 0 };
      const closes = candles.map(c => c.close);
      const ut = calcUTBot(candles);
      const macd = calcMACD(closes);
      const rsi = calcRSI(closes);
      if (!ut || !macd || !rsi) return { signal: 0 };
      if (ut.flip && ut.dir === 1 && macd.bullCross && rsi < 70) return { signal: 1 };
      if (ut.flip && ut.dir === -1 && macd.bearCross && rsi > 30) return { signal: -1 };
      return { signal: 0 };
    }
  },
  "MACD+BB": {
    name: "MACD + Bollinger", color: "#ff9500", tag: "CROSSOVER",
    desc: "MACD crossover confirmed by Bollinger Band position",
    signal: (candles) => {
      if (candles.length < 30) return { signal: 0 };
      const closes = candles.map(c => c.close);
      const macd = calcMACD(closes);
      const bb = calcBB(closes);
      if (!macd || !bb) return { signal: 0 };
      const price = closes[closes.length - 1];
      if (macd.bullCross && price < bb.mid) return { signal: 1 };
      if (macd.bearCross && price > bb.mid) return { signal: -1 };
      return { signal: 0 };
    }
  },
  "PHANTOM": {
    name: "PHANTOM", color: "#b044ff", tag: "REGIME·AI", isPhantom: true,
    desc: "Regime-aware · Order flow · Adaptive momentum · Smart exits",
    signal: (candles) => {
      if (candles.length < 50) return { signal: 0, regime: "warming up", score: null };
      const closes = candles.map(c => c.close);
      const regime = classifyRegime(candles, closes);
      const ofi = calcOFI(candles);
      const score = calcMomentumScore(closes);
      const adx = calcADX(candles);
      const bb = calcBB(closes);
      const macd = calcMACD(closes);
      const rsi = calcRSI(closes);
      const atr = calcATR(candles);
      if (!score || !adx || !bb || !macd || !rsi || !atr) return { signal: 0, regime, score };
      const price = closes[closes.length - 1];
      let signal = 0;
      if (regime === "volatile") return { signal: 0, regime, score, ofi, adx: adx.adx };
      if ((regime === "trending_up" || regime === "neutral") && score > 62 && ofi > 0.1 && macd.macd > macd.signal && rsi > 40 && rsi < 75 && price > bb.mid && adx.adx > 15) signal = 1;
      if ((regime === "ranging" || regime === "neutral") && price < bb.lower * 1.008 && ofi > -0.05 && rsi < 38 && (macd.histogram > 0 || macd.bullCross)) signal = 1;
      if (regime === "trending_down" && score < 38 && ofi < -0.1) signal = -1;
      if (score < 30 && ofi < -0.2) signal = -1;
      return { signal, regime, score, ofi: +ofi.toFixed(3), adx: +adx.adx.toFixed(1), rsi };
    }
  }
};

// ─────────────────────────────────────────────────────────────
// TIMEFRAMES
// ─────────────────────────────────────────────────────────────
const TIMEFRAMES = [
  { key: "1m",  label: "1 MIN",  secs: 60,   color: "#ff4488" },
  { key: "5m",  label: "5 MIN",  secs: 300,  color: "#ff9500" },
  { key: "15m", label: "15 MIN", secs: 900,  color: "#00d4ff" },
  { key: "1h",  label: "1 HOUR", secs: 3600, color: "#00ff88" },
];
const CAPITAL = 10000;

// ─────────────────────────────────────────────────────────────
// PER-TIMEFRAME ENGINE
// ─────────────────────────────────────────────────────────────
const mkEngine = (tfKey) => ({
  tfKey, capital: CAPITAL, cash: CAPITAL,
  position: null, trades: [], equity: [{ t: Date.now(), v: CAPITAL }],
  candles: [], currentCandle: null,
  lastSignal: 0, lastMeta: {}, status: "warming up",
  wins: 0, losses: 0, totalReturn: 0, winRate: 0, maxDrawdown: 0, peakEquity: CAPITAL,
});

const tickEngine = (eng, strat, price, ts) => {
  const e = { ...eng };
  const tfMs = TIMEFRAMES.find(t => t.key === e.tfKey).secs * 1000;
  const candleTime = Math.floor(ts / tfMs) * tfMs;
  let cc = e.currentCandle;
  if (!cc || cc.time !== candleTime) {
    if (cc) e.candles = [...e.candles.slice(-100), cc];
    cc = { time: candleTime, open: price, high: price, low: price, close: price, volume: 0 };
  }
  cc = { ...cc, high: Math.max(cc.high, price), low: Math.min(cc.low, price), close: price, volume: cc.volume + 50 + Math.random() * 150 };
  e.currentCandle = cc;
  const evalC = [...e.candles, cc];
  const res = strat.signal(evalC);
  const sig = res.signal ?? 0;
  e.lastSignal = sig; e.lastMeta = res;

  // Exit
  if (e.position) {
    const { entry, size, stopLoss, takeProfit, highWater } = e.position;
    const newHW = Math.max(highWater, price);
    let sl = stopLoss;
    if (strat.isPhantom && (price - entry) / entry > 0.02) {
      const atr = calcATR(evalC) || entry * 0.02;
      sl = Math.max(stopLoss, newHW - atr * Math.max(0.5, 1.5 - ((price - entry) / entry) * 5));
    }
    e.position = { ...e.position, highWater: newHW, stopLoss: sl };
    let ep = null, reason = null;
    if (price <= sl) { ep = price; reason = (price - entry) / entry > 0.01 ? "Trail Lock 🔒" : "Stop Loss 🔴"; }
    else if (price >= takeProfit) { ep = price; reason = "Take Profit 🟢"; }
    else if (sig === -1) { ep = price; reason = "Signal Exit ⚡"; }
    if (ep !== null) {
      const pnl = (ep - entry) * size;
      e.cash += ep * size;
      e.wins += pnl > 0 ? 1 : 0; e.losses += pnl <= 0 ? 1 : 0;
      e.trades = [...e.trades.slice(-50), { entry: +entry.toFixed(3), exit: +ep.toFixed(3), size: +size.toFixed(4), pnl: +pnl.toFixed(2), pnlPct: +((ep - entry) / entry * 100).toFixed(2), reason, time: new Date(ts).toLocaleTimeString(), regime: res.regime || "—" }];
      e.position = null; e.status = "watching";
    }
  }
  // Entry
  if (!e.position && sig === 1 && e.cash > 0) {
    const atr = calcATR(evalC) || price * 0.02;
    let size, sl, tp;
    if (strat.isPhantom) {
      const volS = Math.max(0.5, Math.min(2, 0.015 / Math.max(atr / price, 0.001)));
      const stopD = atr * 1.5;
      size = (e.cash * 0.02 * volS) / stopD;
      sl = price - stopD; tp = price + stopD * 2.5;
    } else {
      sl = price * 0.97; tp = price * 1.05;
      size = (e.cash * 0.02) / (price - sl);
    }
    const cost = size * price;
    if (cost > 0 && cost <= e.cash * 0.95) {
      e.cash -= cost;
      e.position = { entry: price, size, stopLoss: sl, takeProfit: tp, highWater: price };
      e.status = "in trade 🟡";
    }
  }
  const eq = e.cash + (e.position ? e.position.size * price : 0);
  e.peakEquity = Math.max(e.peakEquity, eq);
  e.maxDrawdown = Math.max(e.maxDrawdown, (e.peakEquity - eq) / e.peakEquity * 100);
  e.totalReturn = +((eq - CAPITAL) / CAPITAL * 100).toFixed(2);
  e.winRate = e.trades.length > 0 ? +((e.wins / e.trades.length) * 100).toFixed(1) : 0;
  e.equity = [...e.equity.slice(-100), { t: ts, v: +eq.toFixed(2) }];
  if (evalC.length >= 50 && e.status === "warming up") e.status = "watching";
  return e;
};

// ─────────────────────────────────────────────────────────────
// KRAKEN WS
// ─────────────────────────────────────────────────────────────
const KS = { ws: null, lastPrice: null, change24h: 0 };
const connectKraken = (onTick) => {
  if (KS.ws?.readyState === WebSocket.OPEN) return;
  try {
    KS.ws = new WebSocket("wss://ws.kraken.com/v2");
    KS.ws.onopen = () => KS.ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: ["SOL/USD"] } }));
    KS.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.channel === "ticker" && msg.data) {
          msg.data.forEach(d => { if (d.symbol === "SOL/USD" && d.last) { KS.lastPrice = d.last; if (d.change_pct != null) KS.change24h = +d.change_pct.toFixed(2); onTick(d.last); } });
        }
      } catch {}
    };
    KS.ws.onclose = () => setTimeout(() => connectKraken(onTick), 3000);
    KS.ws.onerror = () => {};
  } catch {}
};
const disconnectKraken = () => {
  if (KS.ws) { KS.ws.onclose = null; KS.ws.close(); KS.ws = null; }
};

// ─────────────────────────────────────────────────────────────
// SIM FALLBACK
// ─────────────────────────────────────────────────────────────
const SS = { price: 85.65, tick: 0 };
const gaussRand = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const nextSim = () => {
  const rb = SS.tick % 97 === 0 ? (Math.random() > 0.5 ? 1.008 : 0.993) : 1;
  const sh = SS.tick % 43 === 0 ? (Math.random() > 0.5 ? 1.015 : 0.986) : 1;
  SS.price = Math.max(40, Math.min(300, SS.price * (1 + 0.00008 + 0.007 * gaussRand()) * rb * sh));
  SS.tick++;
  return SS.price;
};

// ─────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────
const TF_INTERVALS = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };
const BOT_KEYS = ["UT+MACD+RSI", "MACD+BB", "PHANTOM"];
const initState = () => BOT_KEYS.map(k => ({ stratKey: k, strat: STRATEGIES[k], engines: Object.fromEntries(TIMEFRAMES.map(tf => [tf.key, mkEngine(tf.key)])) }));
const RC = { trending_up: "#00ff88", trending_down: "#ff4466", ranging: "#ffd700", volatile: "#ff6600", neutral: "#00d4ff", "warming up": "#5a7090", unknown: "#5a7090" };

const loadBots = () => {
  try {
    const saved = localStorage.getItem("paperbot_bots");
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed.map(b => ({
        ...b,
        strat: STRATEGIES[b.stratKey],
        engines: Object.fromEntries(
          Object.entries(b.engines).map(([k, e]) => [k, {
            ...mkEngine(k),
            cash: e.cash,
            position: e.position,
            trades: (e.trades || []).slice(-50),
            equity: (e.equity || []).slice(-100),
            wins: e.wins,
            losses: e.losses,
            totalReturn: e.totalReturn,
            winRate: e.winRate,
            maxDrawdown: e.maxDrawdown,
            peakEquity: e.peakEquity,
          }])
        ),
      }));
    }
  } catch {}
  return initState();
};

export default function PaperBot() {
  const [bots, setBots] = useState(loadBots);
  const [solPrice, setSolPrice] = useState(null);
  const [solChange, setSolChange] = useState(0);
  const [priceHist, setPriceHist] = useState([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lastUpd, setLastUpd] = useState(null);
  const [selBot, setSelBot] = useState(0);
  const [selTF, setSelTF] = useState("1m");
  const [dTab, setDTab] = useState("chart");
  const runRef = useRef(false);
  const fbRef = useRef(null);
  const saveRef = useRef(null);
  const startingRef = useRef(false);
  const botsRef = useRef(bots);

  useEffect(() => {
    botsRef.current = bots;
    clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => {
      try { localStorage.setItem("paperbot_bots", JSON.stringify(bots)); } catch {}
    }, 1000);
  }, [bots]);

  const handleTick = useCallback((price) => {
    if (!runRef.current) return;
    const now = Date.now(), p = +price.toFixed(3);
    setSolPrice(p); setSolChange(KS.change24h);
    setLastUpd(new Date().toLocaleTimeString());
    setStatus("live");
    setPriceHist(prev => [...prev.slice(-150), { t: now, p }]);
    setBots(prev => prev.map(bot => ({ ...bot, engines: Object.fromEntries(Object.entries(bot.engines).map(([k, e]) => [k, tickEngine({ ...e }, bot.strat, p, now)])) })));
  }, []);

  const start = async () => {
    if (startingRef.current || runRef.current) return;
    startingRef.current = true;
    runRef.current = true; setRunning(true); setStatus("connecting");
    clearInterval(fbRef.current);
    try {
      const results = await Promise.all(
        TIMEFRAMES.map(async tf => {
          const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=${TF_INTERVALS[tf.key]}`);
          const json = await res.json();
          const raw = (json.result?.SOLUSD || []).slice(0, -1);
          return {
            tfKey: tf.key,
            candles: raw.slice(-100).map(c => ({
              time: c[0] * 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[6],
            })),
          };
        })
      );
      const candleMap = Object.fromEntries(results.map(r => [r.tfKey, r.candles]));
      setBots(prev => prev.map(bot => ({
        ...bot,
        engines: Object.fromEntries(Object.entries(bot.engines).map(([k, e]) => [k, {
          ...e,
          candles: candleMap[k] || e.candles,
          status: (candleMap[k]?.length || 0) >= 50 ? "watching" : "warming up",
        }])),
      })));
    } catch {}
    connectKraken(handleTick);
    fbRef.current = setInterval(() => { if (!KS.lastPrice) handleTick(nextSim()); }, 2000);
    startingRef.current = false;
  };
  const stop = () => {
    runRef.current = false; setRunning(false); setStatus("idle"); disconnectKraken(); clearInterval(fbRef.current);
    try { localStorage.setItem("paperbot_bots", JSON.stringify(botsRef.current)); } catch {}
  };
  const resetBot = (i) => {
    if (!window.confirm("Reset this bot? All trades and P&L will be permanently erased.")) return;
    setBots(prev => prev.map((b, idx) => idx !== i ? b : { ...b, engines: Object.fromEntries(TIMEFRAMES.map(tf => [tf.key, mkEngine(tf.key)])) }));
  };
  useEffect(() => () => { disconnectKraken(); clearInterval(fbRef.current); }, []);

  const bot = bots[selBot];
  const eng = bot.engines[selTF];
  const tf = TIMEFRAMES.find(t => t.key === selTF);
  const meta = eng.lastMeta || {};

  return (
    <div style={{ background: "#05080f", minHeight: "100vh", fontFamily: "'Space Mono', monospace", color: "#c0cce0", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; height: 3px; } ::-webkit-scrollbar-thumb { background: #111e30; }
        .btn { cursor: pointer; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: 1px; border: none; transition: all 0.15s; }
        .blink { animation: blink 1s step-end infinite; } @keyframes blink { 50% { opacity: 0; } }
        .card { transition: all 0.15s; cursor: pointer; } .card:hover { filter: brightness(1.07); }
        .tftab { cursor: pointer; padding: 5px 13px; border-radius: 3px; font-size: 9px; font-family: 'Space Mono'; letter-spacing: 1.5px; text-transform: uppercase; transition: all 0.12s; border: 1px solid transparent; }
        .dtab { cursor: pointer; padding: 5px 13px; border-radius: 3px; font-size: 9px; font-family: 'Space Mono'; letter-spacing: 1px; text-transform: uppercase; transition: all 0.12s; border: 1px solid transparent; color: #2a4060; background: transparent; }
        .dtab.on { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.08); color: #c0cce0; }
        .scanline { background: repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(176,68,255,0.01) 3px,rgba(176,68,255,0.01) 4px); pointer-events:none; position:fixed; inset:0; z-index:0; }
      `}</style>
      <div className="scanline" />

      {/* TOP BAR */}
      <div style={{ height: 50, borderBottom: "1px solid #0d1a2e", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "#06101a", position: "relative", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 17, fontWeight: 900, letterSpacing: 4 }}>PAPER<span style={{ color: "#b044ff" }}>BOT</span></span>
          <span style={{ fontSize: 8, color: "#1a3050", letterSpacing: 2 }}>SOL/USD · 3 BOTS · 4 TIMEFRAMES EACH</span>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          {solPrice && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: "#9945ff", fontWeight: 700, fontSize: 10 }}>SOL/USD</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>${solPrice.toFixed(3)}</span>
            <span style={{ fontSize: 9, color: solChange >= 0 ? "#00ff88" : "#ff4466" }}>{solChange >= 0 ? "▲" : "▼"}{Math.abs(solChange).toFixed(2)}%</span>
          </div>}
          <div style={{ display: "flex", gap: 5 }}>
            {TIMEFRAMES.map(t => <div key={t.key} style={{ fontSize: 7, padding: "2px 6px", border: `1px solid ${t.color}40`, borderRadius: 2, color: t.color, letterSpacing: 1 }}>{t.label}</div>)}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 9, color: status === "live" ? "#00ff88" : status === "connecting" ? "#ffd700" : "#2a4060" }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} className={running ? "blink" : ""} />
            {status === "live" ? `LIVE · ${lastUpd}` : status === "connecting" ? "CONNECTING..." : "IDLE"}
          </div>
          {!running
            ? <button className="btn" onClick={start} style={{ background: "#b044ff18", border: "1px solid #b044ff50", color: "#b044ff", padding: "7px 18px", borderRadius: 3, fontSize: 11 }}>▶ START</button>
            : <button className="btn" onClick={stop} style={{ background: "#ff446618", border: "1px solid #ff446650", color: "#ff4466", padding: "7px 18px", borderRadius: 3, fontSize: 11 }}>■ STOP</button>}
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 50px)", position: "relative", zIndex: 1 }}>

        {/* LEFT — Bot cards */}
        <div style={{ width: 248, borderRight: "1px solid #0d1a2e", background: "#06101a", overflowY: "auto" }}>
          <div style={{ fontSize: 8, letterSpacing: 2, color: "#1a3050", padding: "10px 14px 8px", borderBottom: "1px solid #0d1a2e" }}>3 BOTS · SELECT TO VIEW</div>
          {bots.map((b, idx) => {
            const best = TIMEFRAMES.reduce((bst, t) => b.engines[t.key].totalReturn > b.engines[bst.key].totalReturn ? t : bst, TIMEFRAMES[0]);
            const totalTrades = TIMEFRAMES.reduce((s, t) => s + b.engines[t.key].trades.length, 0);
            const isSel = selBot === idx;
            return (
              <div key={b.stratKey} className="card" onClick={() => setSelBot(idx)}
                style={{ padding: 14, borderBottom: "1px solid #0d1a2e", background: isSel ? `${b.strat.color}08` : "transparent", borderLeft: `3px solid ${isSel ? b.strat.color : "transparent"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: b.strat.color, boxShadow: `0 0 8px ${b.strat.color}` }} className={running ? "blink" : ""} />
                  <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 12, fontWeight: 900, color: b.strat.color, letterSpacing: 1 }}>{b.strat.name}</span>
                </div>
                <div style={{ fontSize: 8, color: "#2a4060", marginBottom: 10 }}>{b.strat.desc}</div>

                {/* 4 TF mini cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, marginBottom: 8 }}>
                  {TIMEFRAMES.map(t => {
                    const e = b.engines[t.key];
                    const isSelTF = isSel && selTF === t.key;
                    return (
                      <div key={t.key} onClick={ev => { ev.stopPropagation(); setSelBot(idx); setSelTF(t.key); setDTab("chart"); }}
                        style={{ background: isSelTF ? `${t.color}18` : "#08121e", border: `1px solid ${isSelTF ? t.color + "70" : "#0d1a2e"}`, borderRadius: 3, padding: "5px 3px", cursor: "pointer", textAlign: "center", transition: "all 0.12s" }}>
                        <div style={{ fontSize: 7, color: t.color, letterSpacing: 0.5, marginBottom: 1, fontWeight: 700 }}>{t.label}</div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: e.totalReturn >= 0 ? "#00ff88" : "#ff4466" }}>{e.totalReturn >= 0 ? "+" : ""}{e.totalReturn}%</div>
                        <div style={{ fontSize: 7, color: "#1a3050", marginTop: 1 }}>{e.trades.length}T · {e.winRate}%</div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 9 }}>
                  <span style={{ color: "#1a3050" }}>Best: <span style={{ color: best.color, fontWeight: 700 }}>{best.label}</span></span>
                  <span style={{ color: b.engines[best.key].totalReturn >= 0 ? "#00ff88" : "#ff4466", fontWeight: 700 }}>
                    {b.engines[best.key].totalReturn >= 0 ? "+" : ""}{b.engines[best.key].totalReturn}%
                  </span>
                </div>
                <div style={{ fontSize: 7, color: "#1a3050", marginTop: 2 }}>{totalTrades} total trades across all TFs</div>
                <button className="btn" onClick={e => { e.stopPropagation(); resetBot(idx); }}
                  style={{ marginTop: 8, width: "100%", background: "#05080f", border: "1px solid #0d1a2e", color: "#2a4060", padding: "4px", borderRadius: 3, fontSize: 7 }}>↺ RESET</button>
              </div>
            );
          })}
        </div>

        {/* MAIN PANEL */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Header: bot name + all TF returns */}
          <div style={{ borderBottom: "1px solid #0d1a2e", background: "#06101a" }}>
            <div style={{ padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #0d1a2e10" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: bot.strat.color, boxShadow: `0 0 10px ${bot.strat.color}` }} />
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 900, color: bot.strat.color, letterSpacing: 2 }}>{bot.strat.name}</span>
              <span style={{ fontSize: 7, padding: "2px 6px", border: `1px solid ${bot.strat.color}30`, borderRadius: 2, color: bot.strat.color }}>{bot.strat.tag}</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 18 }}>
                {TIMEFRAMES.map(t => {
                  const e = bot.engines[t.key];
                  return (
                    <div key={t.key} onClick={() => setSelTF(t.key)} style={{ textAlign: "center", cursor: "pointer", opacity: selTF === t.key ? 1 : 0.5, transition: "opacity 0.15s" }}>
                      <div style={{ fontSize: 7, color: t.color, letterSpacing: 1, marginBottom: 1 }}>{t.label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: e.totalReturn >= 0 ? "#00ff88" : "#ff4466" }}>{e.totalReturn >= 0 ? "+" : ""}{e.totalReturn}%</div>
                      <div style={{ fontSize: 7, color: "#1a3050" }}>{e.trades.length}T</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* TF tabs + detail tabs */}
            <div style={{ display: "flex", gap: 3, padding: "6px 16px", alignItems: "center", flexWrap: "wrap" }}>
              {TIMEFRAMES.map(t => (
                <button key={t.key} className="tftab" onClick={() => setSelTF(t.key)}
                  style={{ color: selTF === t.key ? t.color : "#2a4060", borderColor: selTF === t.key ? t.color + "60" : "transparent", background: selTF === t.key ? `${t.color}12` : "transparent" }}>
                  {t.label}
                </button>
              ))}
              <div style={{ width: 1, height: 16, background: "#0d1a2e", margin: "0 6px" }} />
              {["chart", "equity", "trades", ...(bot.strat.isPhantom ? ["intel"] : [])].map(tab => (
                <button key={tab} className={`dtab ${dTab === tab ? "on" : ""}`} onClick={() => setDTab(tab)}>
                  {tab === "chart" ? "📈 Price" : tab === "equity" ? "💹 Equity" : tab === "trades" ? "📋 Trades" : "🧠 Phantom Intel"}
                </button>
              ))}
              <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 9 }}>
                {[["TF", tf.label], ["CANDLES", eng.candles.length], ["TRADES", eng.trades.length], ["WIN%", `${eng.winRate}%`], ["MAX DD", `-${eng.maxDrawdown.toFixed(1)}%`]].map(([l, v]) => (
                  <div key={l} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 7, color: "#1a3050", letterSpacing: 1 }}>{l}</div>
                    <div style={{ fontWeight: 700, color: l === "TF" ? tf.color : "#c0cce0", fontSize: l === "TF" ? 10 : 10 }}>{v}</div>
                  </div>
                ))}
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 7, color: "#1a3050", letterSpacing: 1 }}>STATUS</div>
                  <div style={{ fontWeight: 700, fontSize: 9, color: eng.status === "in trade 🟡" ? "#ffd700" : eng.status === "watching" ? "#00ff88" : "#5a7090" }}>{eng.status}</div>
                </div>
              </div>
            </div>
          </div>

          {/* CONTENT */}
          <div style={{ flex: 1, overflow: "auto", padding: 14 }}>

            {dTab === "chart" && (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ flex: 2, background: "#08121e", border: `1px solid ${tf.color}20`, borderRadius: 6, padding: "10px 8px" }}>
                  <div style={{ fontSize: 8, color: "#1a3050", marginBottom: 4, paddingLeft: 6, letterSpacing: 2, display: "flex", justifyContent: "space-between" }}>
                    <span>SOL/USD LIVE · {tf.label} CANDLES · {eng.candles.length} CLOSED</span>
                    <span style={{ color: tf.color }}>{running ? (KS.lastPrice ? "● KRAKEN LIVE" : "● SIM (fallback)") : "STOPPED"}</span>
                  </div>
                  {priceHist.length > 1 ? (
                    <ResponsiveContainer width="100%" height="92%">
                      <AreaChart data={priceHist.slice(-150)} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={tf.color} stopOpacity={0.2}/><stop offset="95%" stopColor={tf.color} stopOpacity={0}/></linearGradient></defs>
                        <XAxis dataKey="t" hide /><YAxis domain={["auto","auto"]} tick={{ fill:"#1a3050", fontSize:9 }} tickFormatter={v=>`$${v.toFixed(2)}`} width={55}/>
                        <Tooltip contentStyle={{ background:"#08121e", border:"1px solid #0d1a2e", borderRadius:3, fontSize:10 }} formatter={v=>[`$${Number(v).toFixed(3)}`,"SOL"]} labelFormatter={()=>""}/>
                        <Area type="monotone" dataKey="p" stroke={tf.color} strokeWidth={2} fill="url(#pg)" dot={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <div style={{ height:"80%", display:"flex", alignItems:"center", justifyContent:"center", color:"#1a3050", fontSize:11 }}>{running ? "⏳ Waiting for price data..." : "Press START to begin"}</div>}
                </div>
                {/* Warmup progress bars */}
                <div style={{ background:"#08121e", border:"1px solid #0d1a2e", borderRadius:6, padding:"10px 14px" }}>
                  <div style={{ fontSize:8, color:"#1a3050", marginBottom:8, letterSpacing:2 }}>CANDLE WARMUP · {bot.strat.name} · {running && bot.engines["1m"].status !== "warming up" ? "READY ✓" : "50 CANDLES NEEDED PER TF"}</div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                    {TIMEFRAMES.map(t => {
                      const e = bot.engines[t.key];
                      const pct = Math.min(100, e.candles.length / 50 * 100);
                      return (
                        <div key={t.key}>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, marginBottom:3 }}>
                            <span style={{ color:t.color, fontWeight:700 }}>{t.label}</span>
                            <span style={{ color:"#2a4060" }}>{Math.min(e.candles.length, 50)}/50</span>
                          </div>
                          <div style={{ height:4, background:"#0d1a2e", borderRadius:2 }}>
                            <div style={{ height:"100%", width:`${pct}%`, background:t.color, borderRadius:2, transition:"width 1s" }}/>
                          </div>
                          <div style={{ fontSize:7, color: e.status === "warming up" ? "#ff9500" : e.status === "in trade 🟡" ? "#ffd700" : "#00ff88", marginTop:2 }}>{e.status}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {dTab === "equity" && (
              <div style={{ height:"100%", display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ flex:1, background:"#08121e", border:`1px solid ${tf.color}20`, borderRadius:6, padding:"10px 8px" }}>
                  <div style={{ fontSize:8, color:"#1a3050", marginBottom:4, paddingLeft:6, letterSpacing:2 }}>{tf.label} EQUITY · ${CAPITAL.toLocaleString()} START · {bot.strat.name}</div>
                  {eng.equity.length > 2 ? (
                    <ResponsiveContainer width="100%" height="92%">
                      <AreaChart data={eng.equity} margin={{ top:4, right:8, left:0, bottom:0 }}>
                        <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={tf.color} stopOpacity={0.25}/><stop offset="95%" stopColor={tf.color} stopOpacity={0}/></linearGradient></defs>
                        <XAxis dataKey="t" hide/><YAxis domain={["auto","auto"]} tick={{ fill:"#1a3050", fontSize:9 }} tickFormatter={v=>`$${v.toFixed(0)}`} width={60}/>
                        <ReferenceLine y={CAPITAL} stroke="#1a3050" strokeDasharray="4 4"/>
                        <Tooltip contentStyle={{ background:"#08121e", border:"1px solid #0d1a2e", borderRadius:3, fontSize:10 }} formatter={v=>[`$${Number(v).toFixed(2)}`,"Equity"]} labelFormatter={()=>""}/>
                        <Area type="monotone" dataKey="v" stroke={tf.color} strokeWidth={2} fill="url(#eg)" dot={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <div style={{ height:"80%", display:"flex", alignItems:"center", justifyContent:"center", color:"#1a3050" }}>No equity data yet</div>}
                </div>
                <div style={{ background:"#08121e", border:"1px solid #0d1a2e", borderRadius:6, padding:"10px 8px", height:150 }}>
                  <div style={{ fontSize:8, color:"#1a3050", marginBottom:4, paddingLeft:6, letterSpacing:2 }}>ALL 4 TIMEFRAMES EQUITY RACE · {bot.strat.name}</div>
                  <ResponsiveContainer width="100%" height="82%">
                    <LineChart margin={{ top:4, right:8, left:0, bottom:0 }}>
                      <YAxis domain={["auto","auto"]} hide/>
                      <Tooltip contentStyle={{ background:"#08121e", border:"1px solid #0d1a2e", borderRadius:3, fontSize:9 }} formatter={(v,n)=>[`$${Number(v).toFixed(2)}`,n]} labelFormatter={()=>""}/>
                      {TIMEFRAMES.map(t => bot.engines[t.key].equity.length > 2 && (
                        <Line key={t.key} data={bot.engines[t.key].equity} type="monotone" dataKey="v" stroke={t.color} strokeWidth={t.key===selTF?2.5:1.5} dot={false} name={t.label} strokeOpacity={t.key===selTF?1:0.55}/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {dTab === "trades" && (
              <div style={{ background:"#08121e", border:`1px solid ${tf.color}20`, borderRadius:6, overflow:"auto", height:"100%" }}>
                <div style={{ padding:"8px 14px", borderBottom:"1px solid #0d1a2e", fontSize:8, letterSpacing:2, color:tf.color, background:"#06101a", position:"sticky", top:0, display:"flex", justifyContent:"space-between" }}>
                  <span>{tf.label} · {bot.strat.name} · {eng.trades.length} TRADES</span>
                  <span style={{ color:"#1a3050" }}>W:{eng.wins} L:{eng.losses} WR:{eng.winRate}%</span>
                </div>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #0d1a2e", background:"#06101a", position:"sticky", top:35 }}>
                      {["TIME","ENTRY","EXIT","SIZE","P&L $","P&L %","REASON"].map(h=>(
                        <th key={h} style={{ padding:"7px 14px", textAlign:"left", fontSize:7, letterSpacing:1.5, color:"#1a3050", fontWeight:700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {eng.trades.length === 0 ? (
                      <tr><td colSpan={7} style={{ padding:40, textAlign:"center", color:"#1a3050", fontSize:11 }}>
                        {running ? `⏳ ${eng.status} — waiting for a ${tf.label} signal on ${bot.strat.name}...` : "Press START to begin paper trading"}
                      </td></tr>
                    ) : [...eng.trades].reverse().map((t, i) => (
                      <tr key={i} style={{ borderBottom:"1px solid #0d1a2e14" }}>
                        <td style={{ padding:"7px 14px", color:"#1a3050", fontSize:9 }}>{t.time}</td>
                        <td style={{ padding:"7px 14px" }}>${t.entry}</td>
                        <td style={{ padding:"7px 14px" }}>${t.exit}</td>
                        <td style={{ padding:"7px 14px", color:"#2a4060" }}>{t.size}</td>
                        <td style={{ padding:"7px 14px", color:t.pnl>=0?"#00ff88":"#ff4466", fontWeight:700 }}>{t.pnl>=0?"+":""}${t.pnl}</td>
                        <td style={{ padding:"7px 14px", color:t.pnlPct>=0?"#00ff88":"#ff4466" }}>{t.pnlPct>=0?"+":""}{t.pnlPct}%</td>
                        <td style={{ padding:"7px 14px", fontSize:9, color:t.reason?.includes("Profit")?"#00ff88":t.reason?.includes("Stop")?"#ff4466":t.reason?.includes("Lock")?"#ffd700":"#5a7090" }}>{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {dTab === "intel" && bot.strat.isPhantom && (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, alignContent:"start" }}>
                <div style={{ background:"#08121e", border:"1px solid #b044ff25", borderRadius:6, padding:16 }}>
                  <div style={{ fontSize:8, letterSpacing:2, color:"#b044ff60", marginBottom:10 }}>REGIME · {tf.label}</div>
                  <div style={{ fontSize:22, fontWeight:900, fontFamily:"'Syne',sans-serif", color:RC[meta.regime]||"#2a4060" }}>{(meta.regime||"—").replace("_"," ").toUpperCase()}</div>
                  {meta.adx && <div style={{ fontSize:9, color:"#2a4060", marginTop:8 }}>ADX: <span style={{ color:meta.adx>25?"#00ff88":"#ffd700" }}>{meta.adx}</span></div>}
                  <div style={{ fontSize:8, color:"#2a4060", marginTop:6, lineHeight:1.8 }}>
                    {meta.regime==="trending_up"&&"🟢 Momentum mode · Riding breakouts"}
                    {meta.regime==="ranging"&&"🟡 Range mode · Mean reversion"}
                    {meta.regime==="volatile"&&"🟠 Standing aside · Too chaotic"}
                    {meta.regime==="trending_down"&&"🔴 Bear trend · Exit signals only"}
                    {meta.regime==="neutral"&&"🔵 Neutral · Both modes eligible"}
                  </div>
                </div>
                <div style={{ background:"#08121e", border:"1px solid #b044ff25", borderRadius:6, padding:16 }}>
                  <div style={{ fontSize:8, letterSpacing:2, color:"#b044ff60", marginBottom:10 }}>MOMENTUM SCORE</div>
                  <div style={{ fontSize:44, fontWeight:900, fontFamily:"'Syne',sans-serif", lineHeight:1, color:(meta.score||0)>62?"#00ff88":(meta.score||0)>38?"#ffd700":"#ff4466" }}>{meta.score??"—"}</div>
                  <div style={{ fontSize:8, color:"#2a4060", marginTop:4 }}>/ 100 · ROC 5/10/20 + RSI</div>
                  {meta.score!=null&&<div style={{ height:3, background:"#0d1a2e", borderRadius:2, marginTop:8 }}><div style={{ height:"100%", width:`${meta.score}%`, background:"#b044ff", borderRadius:2 }}/></div>}
                </div>
                <div style={{ background:"#08121e", border:"1px solid #b044ff25", borderRadius:6, padding:16 }}>
                  <div style={{ fontSize:8, letterSpacing:2, color:"#b044ff60", marginBottom:10 }}>ORDER FLOW</div>
                  <div style={{ fontSize:36, fontWeight:900, fontFamily:"'Syne',sans-serif", color:(meta.ofi||0)>0.1?"#00ff88":(meta.ofi||0)<-0.1?"#ff4466":"#ffd700" }}>{meta.ofi!=null?((meta.ofi>0?"+":"")+meta.ofi):"—"}</div>
                  <div style={{ fontSize:8, color:"#2a4060", marginTop:4 }}>{(meta.ofi||0)>0.1?"🟢 Buyers dominating":(meta.ofi||0)<-0.1?"🔴 Sellers dominating":"🟡 Balanced"}</div>
                  {meta.rsi&&<div style={{ fontSize:9, color:"#2a4060", marginTop:8 }}>RSI: <span style={{ color:meta.rsi>70?"#ff4466":meta.rsi<30?"#00ff88":"#c0cce0" }}>{meta.rsi}</span></div>}
                </div>
                {/* All TF phantom overview */}
                <div style={{ gridColumn:"1/-1", background:"#08121e", border:"1px solid #b044ff25", borderRadius:6, padding:16 }}>
                  <div style={{ fontSize:8, letterSpacing:2, color:"#b044ff60", marginBottom:12 }}>PHANTOM ACROSS ALL TIMEFRAMES</div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                    {TIMEFRAMES.map(t => {
                      const e = bot.engines[t.key];
                      const m = e.lastMeta||{};
                      return (
                        <div key={t.key} onClick={()=>setSelTF(t.key)} style={{ background:"#05080f", border:`1px solid ${t.color}${selTF===t.key?"60":"20"}`, borderRadius:4, padding:12, cursor:"pointer" }}>
                          <div style={{ fontSize:9, color:t.color, fontWeight:700, marginBottom:6 }}>{t.label}</div>
                          <div style={{ fontSize:18, fontWeight:900, fontFamily:"'Syne',sans-serif", color:e.totalReturn>=0?"#00ff88":"#ff4466" }}>{e.totalReturn>=0?"+":""}{e.totalReturn}%</div>
                          <div style={{ fontSize:8, color:"#2a4060", marginTop:4 }}>{e.trades.length} trades · {e.winRate}% WR</div>
                          <div style={{ fontSize:8, marginTop:2, color:RC[m.regime]||"#1a3050" }}>{(m.regime||"warming up").replace("_"," ")}</div>
                          <div style={{ fontSize:7, color:"#1a3050", marginTop:2 }}>Score: {m.score??"—"} · OFI: {m.ofi??"—"}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — Cross-bot leaderboard */}
        <div style={{ width: 195, borderLeft:"1px solid #0d1a2e", background:"#06101a", padding:12, overflowY:"auto" }}>
          <div style={{ fontSize:8, letterSpacing:2, color:"#1a3050", marginBottom:12 }}>LEADERBOARD</div>
          {TIMEFRAMES.map(t => {
            const sorted = [...bots].sort((a,b) => b.engines[t.key].totalReturn - a.engines[t.key].totalReturn);
            const mx = Math.max(...bots.map(b=>Math.abs(b.engines[t.key].totalReturn)), 0.01);
            return (
              <div key={t.key} style={{ marginBottom:12, padding:"8px 10px", background:"#08121e", border:`1px solid ${t.color}18`, borderRadius:4 }}>
                <div style={{ fontSize:8, color:t.color, fontWeight:700, letterSpacing:1, marginBottom:6 }}>{t.label}</div>
                {sorted.map(b => {
                  const e = b.engines[t.key];
                  return (
                    <div key={b.stratKey} style={{ marginBottom:5 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, marginBottom:2 }}>
                        <span style={{ color:b.strat.color }}>{b.strat.name.split(" ")[0].slice(0,8)}</span>
                        <span style={{ color:e.totalReturn>=0?"#00ff88":"#ff4466", fontWeight:700 }}>{e.totalReturn>=0?"+":""}{e.totalReturn}%</span>
                      </div>
                      <div style={{ height:2, background:"#0d1a2e", borderRadius:1 }}>
                        <div style={{ height:"100%", width:`${Math.abs(e.totalReturn)/mx*100}%`, background:e.totalReturn>=0?b.strat.color:"#ff4466", borderRadius:1, transition:"width 0.5s" }}/>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div style={{ marginTop:8, padding:10, background:"#08121e", borderRadius:4, fontSize:7, color:"#1a3050", lineHeight:2, border:"1px solid #0d1a2e" }}>
            <div style={{ color:"#b044ff", marginBottom:3, letterSpacing:1, fontSize:8 }}>PAPERBOT v3</div>
            Kraken WebSocket<br/>SOL/USD real-time<br/>No key · No expiry<br/>3 bots · 4 TFs each<br/>12 independent engines<br/>GBM sim fallback
          </div>
        </div>
      </div>
    </div>
  );
}
