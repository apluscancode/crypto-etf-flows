/* Bitcoin ETF Flows — client-side renderer.
   Reads data/etfs.json (written by fetch_etf.js on GitHub Actions) and paints
   the verdict card, the table, and the 20-session volume chart.
   No framework, no dependency, no network calls beyond the one JSON. */

(function () {
  'use strict';

  var DATA_URL = 'data/etfs.json';
  var SPOT_EXCLUDE = ['BITO', 'BITX'];   // futures / leveraged — not comparable

  var el = function (id) { return document.getElementById(id); };

  function nf(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('en-US', {
      minimumFractionDigits: d === undefined ? 2 : d,
      maximumFractionDigits: d === undefined ? 2 : d
    });
  }

  function money(v) {
    if (v === null || v === undefined) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toFixed(0);
  }

  function pctStr(v) {
    if (v === null || v === undefined) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
  }

  function cls(v) {
    if (v === null || v === undefined) return 'mut';
    if (v > 0.005) return 'pos';
    if (v < -0.005) return 'neg';
    return 'mut';
  }

  function ago(minutes) {
    if (minutes < 1) return 'همین حالا';
    if (minutes < 60) return minutes + ' دقیقه پیش';
    var h = Math.floor(minutes / 60);
    if (h < 24) return h + ' ساعت پیش';
    return Math.floor(h / 24) + ' روز پیش';
  }

  /* --------------------------------------------------------------- sparkline */
  function sparkline(values, w, h) {
    if (!values || values.length < 2) return '';
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    var step = w / (values.length - 1);
    var pts = values.map(function (v, i) {
      var x = i * step;
      var y = h - ((v - min) / span) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    var up = values[values.length - 1] >= values[0];
    var color = up ? '#22c55e' : '#ef4444';

    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"' +
      ' preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '"' +
      ' stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>';
  }

  /* ------------------------------------------------------------ verdict card */
  function renderVerdict(data) {
    var agg = data.aggregate || {};
    var btc = data.btc || {};
    var verdict = agg.verdict || 'NEUTRAL';

    var badge = el('verdict-badge');
    badge.textContent = verdict;
    badge.className = 'verdict-badge ' + verdict.toLowerCase();

    var text, sub;

    if (verdict === 'INFLOW') {
      text = '🟢 پول وارد ETF ها می‌شود';
      sub = 'صندوق‌ها بالاتر از ارزش ذاتی معامله می‌شوند و حجم بالاست. ' +
        'تقاضای نهادی مثبت است — ولی قبل از ورود، تأییدیه روز دوم را ببین.';
    } else if (verdict === 'OUTFLOW') {
      text = '🔴 پول از ETF ها خارج می‌شود';
      sub = 'صندوق‌ها زیر ارزش ذاتی و حجم کم است. فشار فروش نهادی — ' +
        'در خرید عجله نکن.';
    } else {
      text = '🟡 نه ورود، نه خروج';
      sub = 'پرمیوم نزدیک صفر و حجم معمولی است. بازار در حال تصمیم‌گیری — ' +
        'علامت مشخصی برای ورود یا خروج وجود ندارد.';
    }
    el('verdict-text').textContent = text;
    el('verdict-sub').textContent = sub;

    if (btc.price) {
      el('btc-price').textContent = '$' + nf(btc.price, 0);
      var c = el('btc-chg');
      c.textContent = pctStr(btc.chg_1d) + ' (۱ روز)';
      c.className = 'chg ' + (btc.chg_1d > 0 ? 'up' : btc.chg_1d < 0 ? 'down' : 'flat');
    }

    // --- meters -------------------------------------------------------------
    var prem = agg.avg_premium;
    el('m-prem').textContent = prem === null || prem === undefined ? '—'
      : (prem > 0 ? '+' : '') + prem.toFixed(2) + '%';
    var bPrem = el('b-prem');
    var premPct = Math.min(Math.abs(prem || 0) / 0.5 * 100, 100);
    bPrem.style.width = premPct + '%';
    bPrem.className = prem > 0 ? 'pos' : prem < 0 ? 'neg' : '';

    var vr = agg.dvol_vs_avg;
    el('m-vol').textContent = vr ? vr.toFixed(2) + '×' : '—';
    var bVol = el('b-vol');
    bVol.style.width = Math.min((vr || 0) / 2 * 100, 100) + '%';
    bVol.className = vr > 1 ? 'pos' : vr < 0.8 ? 'neg' : '';

    var pos = agg.premium_positive;
    var tot = agg.premium_total || 1;
    el('m-pos').textContent = pos + ' / ' + tot;
    var bPos = el('b-pos');
    bPos.style.width = (pos / tot * 100) + '%';
    bPos.className = pos / tot >= 0.5 ? 'pos' : 'neg';
  }

  /* ------------------------------------------------------------------- table */
  function renderTable(data, sortKey) {
    var rows = Object.keys(data.etfs || {}).map(function (k) { return data.etfs[k]; });
    if (!rows.length) {
      el('tbody').innerHTML = '<tr><td colspan="8" class="empty">داده‌ای نیست</td></tr>';
      return;
    }

    rows.sort(function (a, b) {
      if (sortKey === 'dvol') return (b.dvol || 0) - (a.dvol || 0);
      if (sortKey === 'chg_20d') return (b.chg_20d || -1e9) - (a.chg_20d || -1e9);
      if (sortKey === 'ratio_prem') return (b.ratio_prem || -1e9) - (a.ratio_prem || -1e9);
      if (sortKey === 'vs_btc_20d') return (b.vs_btc_20d || -1e9) - (a.vs_btc_20d || -1e9);
      return 0;
    });

    var html = rows.map(function (r) {
      var special = SPOT_EXCLUDE.indexOf(r.ticker) !== -1;
      return '<tr>' +
        '<td><div class="name-cell">' +
          '<span class="tick">' + r.ticker + '</span>' +
          '<span><span class="name-fa">' + (r.name_fa || r.name) + '</span>' +
          '<span class="name-en">' + (r.name || '') + '</span></span>' +
        '</div></td>' +
        '<td class="num">$' + nf(r.price) + '</td>' +
        '<td class="num ' + cls(r.chg_1d) + '">' + pctStr(r.chg_1d) + '</td>' +
        '<td class="num ' + cls(r.chg_20d) + '">' + pctStr(r.chg_20d) + '</td>' +
        '<td class="num ' + cls(r.vs_btc_20d) + '">' + pctStr(r.vs_btc_20d) + '</td>' +
        '<td class="num ' + cls(r.ratio_prem) + '">' + pctStr(r.ratio_prem) + '</td>' +
        '<td class="num ' + (special ? 'mut' : '') + '">' + money(r.dvol) + '</td>' +
        '<td class="c-spark">' + sparkline(r.series, 78, 24) + '</td>' +
      '</tr>';
    }).join('');

    el('tbody').innerHTML = html;
  }

  /* ------------------------------------------------------------------ chart */
  function renderChart(data) {
    var canvas = el('vol-chart');
    if (!canvas) return;

    var spot = Object.keys(data.etfs || {})
      .map(function (k) { return data.etfs[k]; })
      .filter(function (r) { return SPOT_EXCLUDE.indexOf(r.ticker) === -1; });

    if (!spot.length) return;

    // aggregate not available; show each fund's dollar volume as a bar
    spot.sort(function (a, b) { return (b.dvol || 0) - (a.dvol || 0); });

    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 900;
    var cssH = 150;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var padB = 26, padT = 12, padL = 8, padR = 8;
    var plotW = cssW - padL - padR;
    var plotH = cssH - padT - padB;

    var max = Math.max.apply(null, spot.map(function (r) { return r.dvol || 0; })) || 1;
    var n = spot.length;
    var gap = 8;
    var bw = (plotW - gap * (n - 1)) / n;

    // grid
    ctx.strokeStyle = 'rgba(35,44,58,.7)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 3; g++) {
      var y = padT + (plotH / 3) * g;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
    }

    // bars — RTL: start from the right
    for (var i = 0; i < n; i++) {
      var r = spot[i];
      var h = ((r.dvol || 0) / max) * plotH;
      var x = cssW - padR - bw - i * (bw + gap);
      var y2 = padT + plotH - h;

      var grad = ctx.createLinearGradient(0, y2, 0, padT + plotH);
      var above = (r.dvol_ratio || 0) >= 1;
      grad.addColorStop(0, above ? 'rgba(34,197,94,.85)' : 'rgba(239,68,68,.7)');
      grad.addColorStop(1, above ? 'rgba(34,197,94,.18)' : 'rgba(239,68,68,.12)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      var rr = Math.min(4, bw / 2);
      ctx.moveTo(x, padT + plotH);
      ctx.lineTo(x, y2 + rr);
      ctx.quadraticCurveTo(x, y2, x + rr, y2);
      ctx.lineTo(x + bw - rr, y2);
      ctx.quadraticCurveTo(x + bw, y2, x + bw, y2 + rr);
      ctx.lineTo(x + bw, padT + plotH);
      ctx.closePath();
      ctx.fill();

      // ticker label
      ctx.fillStyle = '#9aa8bd';
      ctx.font = '10px Vazirmatn, Tahoma, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(r.ticker, x + bw / 2, cssH - 9);

      // value on hover-ish: only for the top 3 to avoid clutter
      if (i < 3) {
        ctx.fillStyle = '#e8edf5';
        ctx.font = 'bold 10px Vazirmatn, Tahoma, sans-serif';
        ctx.fillText(money(r.dvol), x + bw / 2, y2 - 4);
      }
    }

    el('vol-hint').textContent = 'سبز = بالاتر از میانگین ۲۰ روزه · قرمز = پایین‌تر';
  }

  /* ------------------------------------------------------------------- boot */
  var DATA = null;   // last payload, kept for re-sorting on tab clicks

  function stamp(data) {
    el('foot-gen').textContent = data.generated_at_display || '—';

    var dot = el('live-dot');
    if (!data.generated_at) {
      el('stamp-time').textContent = data.generated_at_display || '—';
      return;
    }
    var age = (Date.now() - new Date(data.generated_at).getTime()) / 60000;
    dot.className = 'dot' + (age > 180 ? ' dead' : age > 75 ? ' stale' : '');
    dot.title = 'آخرین به‌روزرسانی: ' + ago(Math.round(age));
    el('stamp-time').textContent = ago(Math.round(age));
  }

  function load() {
    fetch(DATA_URL + '?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.etfs) throw new Error('empty payload');
        DATA = data;
        stamp(data);
        renderVerdict(data);
        renderTable(data, 'dvol');
        renderChart(data);
      })
      .catch(function (err) {
        el('verdict-text').textContent = '⚠️ داده در دسترس نیست';
        el('verdict-sub').textContent =
          'فایل data/etfs.json بارگذاری نشد (' + err.message + '). ' +
          'به‌روزرسانی بعدی چند دقیقه دیگر انجام می‌شود.';
        el('tbody').innerHTML =
          '<tr><td colspan="8" class="empty">اتصال به فایل داده برقرار نشد</td></tr>';
        el('live-dot').className = 'dot dead';
      });
  }

  // tab clicks re-sort the payload we already have
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.classList || !t.classList.contains('tab')) return;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    t.classList.add('active');
    if (DATA) renderTable(DATA, t.getAttribute('data-sort'));
  });

  // redraw the canvas on resize (it is sized from clientWidth)
  var rt = null;
  window.addEventListener('resize', function () {
    if (rt) clearTimeout(rt);
    rt = setTimeout(function () { if (DATA) renderChart(DATA); }, 180);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
