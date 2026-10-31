/**
 * fetch_etf.js — pull US spot-Bitcoin ETF candles from TradingView and write
 * data/etfs.json for the static dashboard.
 *
 * No API key, no rate limit. Runs on a GitHub Actions runner every 30 minutes.
 *
 * TradingView quirks (learned the hard way):
 *   - timeframe must be 'D', not '1D'
 *   - chart.periods is NEWEST FIRST — index 0 is today
 *
 * ALIGNMENT CAVEAT (this matters a lot):
 *   BTC trades 24/7 but ETFs only trade Mon-Fri. Comparing "20 bars of BTC"
 *   with "20 bars of an ETF" compares ~28 calendar days against ~20, which
 *   injects a systematic bias into every relative metric. All BTC-relative
 *   numbers below are therefore computed on DATE-ALIGNED pairs: only dates
 *   present in BOTH series are used.
 */
const fs = require('fs');
const path = require('path');
const TradingView = require('@mathieuc/tradingview');

const OUT_DIR = path.join(__dirname, 'data');
const OUT = path.join(OUT_DIR, 'etfs.json');

// symbol -> display metadata. IBIT only resolves under NASDAQ on TradingView.
const ETFS = [
  ['NASDAQ:IBIT', 'IBIT', 'iShares Bitcoin Trust', 'بلک‌راک'],
  ['AMEX:FBTC', 'FBTC', 'Fidelity Wise Origin', 'فیدلیتی'],
  ['AMEX:GBTC', 'GBTC', 'Grayscale Bitcoin Trust', 'گری‌اسکیل'],
  ['AMEX:ARKB', 'ARKB', 'ARK 21Shares', 'آرک'],
  ['AMEX:BITB', 'BITB', 'Bitwise Bitcoin ETF', 'بیت‌وایز'],
  ['AMEX:HODL', 'HODL', 'VanEck Bitcoin Trust', 'ون‌اک'],
  ['AMEX:BTCO', 'BTCO', 'Invesco Galaxy', 'اینوسکو'],
  ['AMEX:EZBC', 'EZBC', 'Franklin Bitcoin ETF', 'فرانکلین'],
  ['AMEX:BITO', 'BITO', 'ProShares Bitcoin ETF', 'پروشیرز (فیوچرز)'],
  ['AMEX:BITX', 'BITX', '2x Bitcoin Strategy', 'پروشیرز ۲x'],
];

const BTC_SYMBOLS = ['BINANCE:BTCUSDT', 'COINBASE:BTCUSD', 'BITSTAMP:BTCUSD'];

const RANGE = 200;   // sessions to request

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return Math.round(((a / b) - 1) * 10000) / 100;
}

function num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

function dayKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Fetch one series. Resolves to an array ordered OLDEST -> NEWEST, or null.
 * Each element: { t, date, o, h, l, c, v }
 */
function fetchSeries(client, symbol, want) {
  return new Promise((resolve) => {
    let done = false;
    let chart = null;
    let timer = null;

    const finish = (val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { if (chart) chart.delete(); } catch (e) { /* ignore */ }
      resolve(val);
    };

    try {
      chart = new client.Session.Chart();
    } catch (e) {
      return resolve(null);
    }

    timer = setTimeout(() => finish(null), 30000);

    chart.onError(() => finish(null));
    chart.onUpdate(() => {
      const p = chart.periods;
      if (!p || p.length < 25) return;   // wait for a usable series
      const arr = p.map((c) => ({
        t: c.time,
        date: dayKey(c.time),
        o: num(c.open),
        h: num(c.high),
        l: num(c.low),
        c: num(c.close),
        v: num(c.volume),
      })).reverse();                     // newest-first -> oldest-first
      finish(arr.slice(-want));
    });

    chart.setMarket(symbol, { timeframe: 'D', range: want });
  });
}

function summarise(candles) {
  if (!candles || candles.length < 25) return null;
  const closes = candles.map((c) => c.c).filter((x) => x != null);
  if (closes.length < 25) return null;

  const last = closes[closes.length - 1];
  const at = (n) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const ma = (n) => {
    const w = closes.slice(-n);
    return w.length === n ? w.reduce((a, b) => a + b, 0) / n : null;
  };

  const vols = candles
    .map((c) => (c.c != null && c.v != null ? c.c * c.v : null))
    .filter((x) => x != null && x > 0);
  const lastVol = vols.length ? vols[vols.length - 1] : null;
  const v20 = vols.slice(-20);
  const dvol20 = v20.length ? v20.reduce((a, b) => a + b, 0) / v20.length : null;

  return {
    price: last,
    chg_1d: pct(last, at(1)),
    chg_5d: pct(last, at(5)),
    chg_20d: pct(last, at(20)),
    chg_60d: pct(last, at(60)),
    ma20: ma(20),
    ma50: ma(50),
    above_ma20: ma(20) == null ? null : last > ma(20),
    above_ma50: ma(50) == null ? null : last > ma(50),
    dvol: lastVol,
    dvol_20d: dvol20,
    dvol_ratio: (dvol20 && lastVol) ? Math.round((lastVol / dvol20) * 100) / 100 : null,
    sessions: closes.length,
    last_date: candles[candles.length - 1].t,
    series: closes.slice(-60),
  };
}

/**
 * Date-aligned comparison between one ETF and BTC.
 * Returns { etf_chg: {1,5,20}, btc_chg: {1,5,20}, ratio_prem, ratio, n }
 * using ONLY dates present in both series.
 */
function align(etfCandles, btcByDate) {
  const pairs = [];
  for (const c of etfCandles) {
    const b = btcByDate.get(c.date);
    if (b != null && c.c != null) pairs.push({ date: c.date, etf: c.c, btc: b });
  }
  if (pairs.length < 25) return null;

  const back = (n) => (pairs.length > n ? pairs[pairs.length - 1 - n] : null);
  const now = pairs[pairs.length - 1];

  const out = { n: pairs.length, etf_chg: {}, btc_chg: {}, ratio: null, ratio_prem: null };

  for (const n of [1, 5, 20]) {
    const p = back(n);
    out.etf_chg[n] = p ? pct(now.etf, p.etf) : null;
    out.btc_chg[n] = p ? pct(now.btc, p.btc) : null;
  }

  const ratios = pairs.map((p) => p.etf / p.btc);
  out.ratio = Math.round(ratios[ratios.length - 1] * 1e6) / 1e6;
  if (ratios.length >= 21) {
    const cur = ratios[ratios.length - 1];
    const prev = ratios.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    out.ratio_prem = Math.round(((cur / prev) - 1) * 10000) / 100;
  }
  out.aligned_days = pairs.length;
  out.first_date = pairs[0].date;
  out.last_date = now.date;
  return out;
}

(async () => {
  const errors = [];
  const client = new TradingView.Client();
  const out = { generated_at: new Date().toISOString(), generated_at_display: null,
                btc: null, etfs: {}, aggregate: null, errors: [] };

  let btcCandles = null;
  let btcByDate = new Map();

  try {
    // ---- BTC reference -----------------------------------------------------
    let btcSymbol = null;
    let btcSummary = null;
    for (const sym of BTC_SYMBOLS) {
      const candles = await fetchSeries(client, sym, RANGE);
      const s = summarise(candles);
      if (s) { btcCandles = candles; btcSummary = s; btcSymbol = sym; break; }
    }

    if (!btcSummary) {
      errors.push('BTC series unavailable');
    } else {
      for (const c of btcCandles) if (c.c != null) btcByDate.set(c.date, c.c);
      out.btc = {
        symbol: btcSymbol,
        price: btcSummary.price,
        chg_1d: btcSummary.chg_1d,
        chg_5d: btcSummary.chg_5d,
        chg_20d: btcSummary.chg_20d,
        chg_60d: btcSummary.chg_60d,
        last_date: btcSummary.last_date,
        series: btcSummary.series,
      };
    }

    // ---- ETFs --------------------------------------------------------------
    for (const [symbol, ticker, name, name_fa] of ETFS) {
      const candles = await fetchSeries(client, symbol, RANGE);
      const s = summarise(candles);
      if (!s) {
        errors.push(`${ticker}: no data`);
        continue;
      }

      const row = {
        ticker, symbol, name, name_fa,
        price: s.price,
        chg_1d: s.chg_1d,
        chg_5d: s.chg_5d,
        chg_20d: s.chg_20d,
        chg_60d: s.chg_60d,
        ma20: s.ma20,
        ma50: s.ma50,
        above_ma20: s.above_ma20,
        above_ma50: s.above_ma50,
        dvol: s.dvol,
        dvol_20d: s.dvol_20d,
        dvol_ratio: s.dvol_ratio,
        series: s.series,
        sessions: s.sessions,
        last_date: s.last_date,
      };

      // ---- date-aligned BTC comparison -------------------------------------
      const a = btcByDate.size ? align(candles, btcByDate) : null;
      if (a) {
        row.aligned_days = a.aligned_days;
        row.ratio = a.ratio;
        row.ratio_prem = a.ratio_prem;
        row.vs_btc_1d = (a.etf_chg[1] == null || a.btc_chg[1] == null)
          ? null : Math.round((a.etf_chg[1] - a.btc_chg[1]) * 100) / 100;
        row.vs_btc_5d = (a.etf_chg[5] == null || a.btc_chg[5] == null)
          ? null : Math.round((a.etf_chg[5] - a.btc_chg[5]) * 100) / 100;
        row.vs_btc_20d = (a.etf_chg[20] == null || a.btc_chg[20] == null)
          ? null : Math.round((a.etf_chg[20] - a.btc_chg[20]) * 100) / 100;
      }

      out.etfs[ticker] = row;
    }
  } catch (e) {
    errors.push(`fatal: ${e.message}`);
  } finally {
    try { client.end(); } catch (e) { /* ignore */ }
  }

  out.errors = errors;

  // ---- aggregate verdict ----------------------------------------------------
  const rows = Object.values(out.etfs);
  if (rows.length) {
    // BITX is 2x leveraged and BITO holds futures — exclude them from the
    // spot premium average, they would dominate and dilute the signal
    const spot = rows.filter((r) => !['BITX', 'BITO'].includes(r.ticker));
    const prem = spot.map((r) => r.ratio_prem).filter((x) => x != null);
    const avgPrem = prem.length ? prem.reduce((a, b) => a + b, 0) / prem.length : null;

    const totalDvol20 = spot.reduce((a, r) => a + (r.dvol_20d || 0), 0);
    const totalDvol = spot.reduce((a, r) => a + (r.dvol || 0), 0);

    out.aggregate = {
      spot_count: spot.length,
      avg_premium: avgPrem == null ? null : Math.round(avgPrem * 100) / 100,
      premium_positive: prem.filter((x) => x > 0).length,
      premium_total: prem.length,
      dvol_total: Math.round(totalDvol),
      dvol_20d_total: Math.round(totalDvol20),
      dvol_vs_avg: totalDvol20 ? Math.round((totalDvol / totalDvol20) * 100) / 100 : null,
    };

    let score = 0;
    if (avgPrem != null) {
      if (avgPrem > 0.20) score += 2;
      else if (avgPrem > 0.07) score += 1;
      else if (avgPrem < -0.20) score -= 2;
      else if (avgPrem < -0.07) score -= 1;
    }
    const vr = out.aggregate.dvol_vs_avg;
    if (vr != null) {
      if (vr > 1.4) score += 1;
      else if (vr < 0.6) score -= 1;
    }

    out.aggregate.score = score;
    out.aggregate.verdict = score >= 2 ? 'INFLOW' : score <= -2 ? 'OUTFLOW' : 'NEUTRAL';
  }

  // display timestamp in Tehran
  try {
    const teh = new Date(Date.now() + 3.5 * 3600 * 1000);
    out.generated_at_display = teh.toISOString().slice(0, 16).replace('T', ' ') + ' Iran';
  } catch (e) { /* ignore */ }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  const dstr = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`wrote ${OUT}`);
  console.log(`BTC ${out.btc ? out.btc.price : 'n/a'} (${out.btc ? out.btc.chg_1d : '?'}%) ` +
    `as of ${out.btc ? dstr(out.btc.last_date) : '?'}`);
  for (const r of rows) {
    console.log(`  ${r.ticker.padEnd(5)} ${String(r.price).padStart(9)}  ` +
      `1d=${String(r.chg_1d).padStart(7)}  20d=${String(r.chg_20d).padStart(7)}  ` +
      `vsBTC20=${String(r.vs_btc_20d).padStart(7)}  prem=${String(r.ratio_prem).padStart(7)}  ` +
      `dvol=${r.dvol ? (r.dvol / 1e6).toFixed(1) + 'M' : 'n/a'}  ` +
      `${r.aligned_days || 0}d  as of ${dstr(r.last_date)}`);
  }
  if (out.aggregate) {
    console.log(`aggregate: ${out.aggregate.verdict} score=${out.aggregate.score} ` +
      `avg_prem=${out.aggregate.avg_premium}% ` +
      `(${out.aggregate.premium_positive}/${out.aggregate.premium_total} positive) ` +
      `dvol_vs_avg=${out.aggregate.dvol_vs_avg}`);
  }
  if (errors.length) console.log('errors:', errors);
  process.exit(0);
})();
