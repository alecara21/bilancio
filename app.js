/* =========================================================================
   Bilancio — logica applicativa
   Nessuna dipendenza esterna. Tutti i dati restano in localStorage,
   sul dispositivo dell'utente: niente rete, niente account.
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'bilancio.v1';
  var THEME_KEY = 'bilancio.theme';

  var DEFAULT_CATS = {
    entrata: ['Stipendio', 'Lavoro freelance', 'Vendite', 'Rimborsi', 'Regali', 'Investimenti', 'Altro'],
    uscita: ['Casa', 'Spesa', 'Trasporti', 'Bollette', 'Svago', 'Salute', 'Abbonamenti', 'Altro']
  };

  // ---------------------------------------------------------------- storage
  var data = { movimenti: [], categorie: null };

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    var parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (e) { parsed = null; } }

    data.movimenti = (parsed && Array.isArray(parsed.movimenti)) ? parsed.movimenti : [];
    var c = parsed && parsed.categorie;
    data.categorie = {
      entrata: (c && Array.isArray(c.entrata) && c.entrata.length) ? c.entrata : DEFAULT_CATS.entrata.slice(),
      uscita: (c && Array.isArray(c.uscita) && c.uscita.length) ? c.uscita : DEFAULT_CATS.uscita.slice()
    };
    data.movimenti = data.movimenti.filter(function (m) {
      return m && typeof m.id === 'string' && (m.tipo === 'entrata' || m.tipo === 'uscita') &&
        typeof m.importo === 'number' && isFinite(m.importo) && /^\d{4}-\d{2}-\d{2}$/.test(m.data);
    });
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      toast('Spazio esaurito: non riesco a salvare. Esporta un backup.');
      return false;
    }
  }

  // ---------------------------------------------------------------- utility
  var eurFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  var eurShort = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  function eur(n) { return eurFmt.format(n); }
  function eurK(n) {
    var a = Math.abs(n);
    if (a >= 10000) return (n < 0 ? '-' : '') + '€' + Math.round(a / 1000) + 'k';
    return eurShort.format(n);
  }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + eur(Math.abs(n)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthKey(iso) { return iso.slice(0, 7); }
  function fromISO(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function monthDate(key) { return new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, 1); }
  function shiftMonth(key, delta) {
    var d = monthDate(key);
    d.setMonth(d.getMonth() + delta);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function monthName(key, style) {
    return monthDate(key).toLocaleDateString('it-IT', { month: style || 'long', year: 'numeric' });
  }
  function dayName(iso) {
    var d = fromISO(iso);
    var today = new Date();
    if (toISO(today) === iso) return 'Oggi';
    today.setDate(today.getDate() - 1);
    if (toISO(today) === iso) return 'Ieri';
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // "1.234,56" | "1234.56" | "1234,5" -> 1234.56
  function parseAmount(str) {
    if (typeof str !== 'string') return NaN;
    var s = str.trim().replace(/[\s €]/g, '');
    if (!s) return NaN;
    var lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      // il separatore decimale è l'ultimo dei due
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    if (!/^-?\d*\.?\d*$/.test(s)) return NaN;
    var n = parseFloat(s);
    return isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : NaN;
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  // ---------------------------------------------------------------- stato
  var state = {
    month: (function () { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); })(),
    view: 'riepilogo',
    editing: null,
    kind: 'entrata',
    tables: {},
    filters: { period: 'month', type: 'all', cat: 'all', q: '' }
  };

  // ---------------------------------------------------------------- calcoli
  function ofMonth(key) {
    return data.movimenti.filter(function (m) { return monthKey(m.data) === key; });
  }
  function totals(list) {
    var t = { entrate: 0, uscite: 0, n: list.length };
    for (var i = 0; i < list.length; i++) {
      if (list[i].tipo === 'entrata') t.entrate += list[i].importo;
      else t.uscite += list[i].importo;
    }
    t.saldo = t.entrate - t.uscite;
    return t;
  }
  function byCategory(list, tipo) {
    var map = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.tipo !== tipo) continue;
      if (!map[m.categoria]) map[m.categoria] = { cat: m.categoria, tot: 0, n: 0 };
      map[m.categoria].tot += m.importo;
      map[m.categoria].n++;
    }
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (a, b) { return b.tot - a.tot; });
    return arr;
  }
  // oltre 7 classi il colore/lettura si degrada: la coda diventa "Altre"
  function capCategories(arr, cap) {
    cap = cap || 7;
    if (arr.length <= cap) return arr;
    var head = arr.slice(0, cap - 1);
    var tail = arr.slice(cap - 1);
    var rest = { cat: 'Altre (' + tail.length + ')', tot: 0, n: 0, isRest: true };
    tail.forEach(function (x) { rest.tot += x.tot; rest.n += x.n; });
    head.push(rest);
    return head;
  }
  function lastMonths(key, count) {
    var out = [];
    for (var i = count - 1; i >= 0; i--) out.push(shiftMonth(key, -i));
    return out;
  }
  // Tetto "tondo" appena sopra il massimo: passi fitti per non lasciare
  // metà grafico vuoto (2560 -> 3000, non 5000).
  function niceMax(v) {
    if (v <= 0) return 100;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var r = v / mag;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      if (r <= steps[i] + 1e-9) return steps[i] * mag;
    }
    return 10 * mag;
  }

  // ---------------------------------------------------------------- tooltip
  var tip = null;
  function showTip(html, x, y) {
    if (!tip) tip = $('#tip');
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var left = x + 14, top = y - r.height - 12;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  // ---------------------------------------------------------------- grafici
  function svgEl(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" xmlns="http://www.w3.org/2000/svg">';
  }
  // barra verticale con estremità dato arrotondata (4px) ancorata alla linea di base
  function colPath(x, y, w, h, r) {
    if (h <= 0.5) return '';
    r = Math.min(r, w / 2, h);
    return 'M' + x + ' ' + (y + h) +
      'V' + (y + r) +
      'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r +
      'h' + (w - 2 * r) +
      'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
      'V' + (y + h) + 'Z';
  }

  function emptyChart(el, msg) {
    el.innerHTML = '<div class="chart-empty"><span>' + esc(msg) + '</span></div>';
  }

  // Larghezza disponibile misurata sulla card, non sul contenitore del grafico:
  // così un SVG largo rimasto da un render precedente non falsa la misura.
  function availWidth(el, fallback) {
    var card = el.closest ? el.closest('.card') : null;
    var w = 0;
    if (card) {
      var cs = window.getComputedStyle(card);
      w = card.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    }
    if (!(w > 40)) w = el.clientWidth;
    return w > 40 ? Math.floor(w) : fallback;
  }

  function renderTrend() {
    var host = $('#chartTrend');
    var months = lastMonths(state.month, 12);
    var rows = months.map(function (k) {
      var t = totals(ofMonth(k));
      return { key: k, entrate: t.entrate, uscite: t.uscite, saldo: t.saldo };
    });
    var peak = 0;
    rows.forEach(function (r) { peak = Math.max(peak, r.entrate, r.uscite); });

    renderTrendTable(rows);

    if (peak === 0) { emptyChart(host, 'Nessun movimento negli ultimi 12 mesi.'); return; }

    var avail = availWidth(host, 640);
    var W = Math.max(avail, 600), H = 250;
    var padL = 54, padR = 10, padT = 12, padB = 36;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var top = niceMax(peak);
    var band = plotW / rows.length;
    var barW = Math.max(6, Math.min(15, (band - 12) / 2));
    var gap = 2; // distanza di superficie tra barre adiacenti

    var s = svgEl(W, H);
    s += '<title>Entrate e uscite mensili degli ultimi 12 mesi</title>';

    // griglia + asse y
    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = top * i / ticks;
      var y = padT + plotH - (plotH * i / ticks);
      s += '<line class="gridline" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(eurK(val)) + '</text>';
    }
    s += '<line class="axisline" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"/>';

    rows.forEach(function (r, i) {
      var cx = padL + band * i + band / 2;
      var hIn = plotH * (r.entrate / top);
      var hOut = plotH * (r.uscite / top);
      var xIn = cx - barW - gap / 2;
      var xOut = cx + gap / 2;
      var base = padT + plotH;

      s += '<path d="' + colPath(xIn, base - hIn, barW, hIn, 4) + '" fill="var(--in)"/>';
      s += '<path d="' + colPath(xOut, base - hOut, barW, hOut, 4) + '" fill="var(--out)"/>';

      var lbl = monthDate(r.key).toLocaleDateString('it-IT', { month: 'short' });
      var isCur = r.key === state.month;
      s += '<text class="tick" x="' + cx + '" y="' + (base + 15) + '" text-anchor="middle"' +
        (isCur ? ' style="fill:var(--ink);font-weight:600"' : '') + '>' + esc(lbl) + '</text>';
      if (i === 0 || monthDate(r.key).getMonth() === 0) {
        s += '<text class="tick" x="' + cx + '" y="' + (base + 28) + '" text-anchor="middle">' +
          monthDate(r.key).getFullYear() + '</text>';
      }
      // banda di hover: area sensibile larga quanto il mese, non quanto la barra
      s += '<rect class="hitband" x="' + (padL + band * i) + '" y="' + padT + '" width="' + band +
        '" height="' + plotH + '" data-i="' + i + '"/>';
    });

    s += '</svg>';
    host.innerHTML = s;

    // su schermi stretti il grafico scorre: parti dai mesi recenti, non dal vuoto
    var scroller = host.parentNode;
    if (scroller && scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = scroller.scrollWidth;
    }

    host.querySelectorAll('.hitband').forEach(function (band) {
      band.addEventListener('mousemove', function (ev) {
        var r = rows[+band.getAttribute('data-i')];
        showTip(
          '<div class="tip-title">' + esc(monthName(r.key)) + '</div>' +
          tipRow('Entrate', eur(r.entrate), 'var(--in)') +
          tipRow('Uscite', eur(r.uscite), 'var(--out)') +
          '<div class="tip-sep"></div>' +
          '<div class="tip-row"><span class="k">Saldo</span><span class="v" style="color:' +
          (r.saldo >= 0 ? 'var(--good)' : 'var(--bad)') + '">' + esc(signed(r.saldo)) + '</span></div>',
          ev.clientX, ev.clientY);
      });
      band.addEventListener('mouseleave', hideTip);
      band.addEventListener('click', function () {
        state.month = rows[+band.getAttribute('data-i')].key;
        hideTip();
        renderAll();
      });
    });
  }

  function tipRow(k, v, color) {
    return '<div class="tip-row"><span class="k"><span class="swatch" style="background:' + color +
      '"></span>' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }

  function renderTrendTable(rows) {
    var h = '<table><caption class="visually-hidden"></caption><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Saldo</th></tr></thead><tbody>';
    var tE = 0, tU = 0;
    rows.forEach(function (r) {
      tE += r.entrate; tU += r.uscite;
      h += '<tr><td>' + esc(monthName(r.key, 'short')) + '</td><td>' + esc(eur(r.entrate)) +
        '</td><td>' + esc(eur(r.uscite)) + '</td><td>' + esc(signed(r.saldo)) + '</td></tr>';
    });
    h += '</tbody><tfoot><tr><td>Totale</td><td>' + esc(eur(tE)) + '</td><td>' + esc(eur(tU)) +
      '</td><td>' + esc(signed(tE - tU)) + '</td></tr></tfoot></table>';
    $('#tableTrend').innerHTML = h;
  }

  function renderCategories(hostSel, tableSel, tipo) {
    var host = $(hostSel);
    var list = ofMonth(state.month);
    var cats = capCategories(byCategory(list, tipo));
    var tot = cats.reduce(function (a, c) { return a + c.tot; }, 0);
    var color = tipo === 'entrata' ? 'var(--in)' : 'var(--out)';

    // tabella gemella (ogni grafico ha il suo equivalente testuale)
    var th = '<table><thead><tr><th>Categoria</th><th>Importo</th><th>Quota</th><th>N.</th></tr></thead><tbody>';
    cats.forEach(function (c) {
      th += '<tr><td>' + esc(c.cat) + '</td><td>' + esc(eur(c.tot)) + '</td><td>' +
        (tot ? Math.round(c.tot / tot * 100) : 0) + '%</td><td>' + c.n + '</td></tr>';
    });
    th += '</tbody><tfoot><tr><td>Totale</td><td>' + esc(eur(tot)) + '</td><td>100%</td><td>' +
      cats.reduce(function (a, c) { return a + c.n; }, 0) + '</td></tr></tfoot></table>';
    $(tableSel).innerHTML = cats.length ? th : '<p class="card-note">Nessun dato.</p>';

    if (!cats.length) {
      emptyChart(host, tipo === 'entrata' ? 'Nessuna entrata in questo mese.' : 'Nessuna uscita in questo mese.');
      return;
    }

    var W = availWidth(host, 320);
    var rowH = 40, padB = 2;
    var H = cats.length * rowH + padB;
    var max = cats[0].tot || 1;

    var s = svgEl(W, H).replace('width="' + W + '"', 'width="100%"');
    s += '<title>' + (tipo === 'entrata' ? 'Entrate' : 'Uscite') + ' per categoria</title>';

    cats.forEach(function (c, i) {
      var y = i * rowH;
      var bw = Math.max(3, (W - 2) * (c.tot / max));
      var pct = tot ? Math.round(c.tot / tot * 100) : 0;
      s += '<text class="catlabel" x="0" y="' + (y + 13) + '">' + esc(c.cat) + '</text>';
      s += '<text class="barlabel" x="' + W + '" y="' + (y + 13) + '" text-anchor="end">' +
        esc(eur(c.tot)) + '<tspan class="tick" dx="6">' + pct + '%</tspan></text>';
      s += '<rect x="0" y="' + (y + 21) + '" width="' + bw + '" height="9" rx="4" fill="' + color + '"/>';
      s += '<rect class="hitband" x="0" y="' + y + '" width="' + W + '" height="' + (rowH - 4) +
        '" data-i="' + i + '" rx="6"/>';
    });
    s += '</svg>';
    host.innerHTML = s;

    host.querySelectorAll('.hitband').forEach(function (b) {
      b.addEventListener('mousemove', function (ev) {
        var c = cats[+b.getAttribute('data-i')];
        showTip('<div class="tip-title">' + esc(c.cat) + '</div>' +
          tipRow(tipo === 'entrata' ? 'Entrate' : 'Uscite', eur(c.tot), color) +
          '<div class="tip-row"><span class="k">Quota</span><span class="v">' +
          (tot ? Math.round(c.tot / tot * 100) : 0) + '%</span></div>' +
          '<div class="tip-row"><span class="k">Movimenti</span><span class="v">' + c.n + '</span></div>',
          ev.clientX, ev.clientY);
      });
      b.addEventListener('mouseleave', hideTip);
    });
  }

  // ---------------------------------------------------------------- riepilogo
  function renderSummary() {
    $('#monthLabel').textContent = monthName(state.month);

    var cur = totals(ofMonth(state.month));
    var prev = totals(ofMonth(shiftMonth(state.month, -1)));

    var hero = $('#heroSaldo');
    hero.textContent = signed(cur.saldo);
    hero.className = 'hero-figure ' + (cur.saldo > 0 ? 'is-pos' : cur.saldo < 0 ? 'is-neg' : '');

    var d = $('#heroDelta');
    if (prev.n === 0) {
      d.className = 'delta flat';
      d.textContent = '';
    } else {
      var diff = cur.saldo - prev.saldo;
      d.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
      d.textContent = (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '= ') + eur(Math.abs(diff)) + ' vs mese prec.';
    }

    $('#heroSub').textContent = cur.n === 0
      ? 'Nessun movimento registrato in questo mese.'
      : cur.n + (cur.n === 1 ? ' movimento' : ' movimenti') + ' registrati.';

    $('#kpiIn').textContent = eur(cur.entrate);
    $('#kpiOut').textContent = eur(cur.uscite);
    $('#kpiInSub').textContent = deltaText(cur.entrate, prev.entrate, prev.n);
    $('#kpiOutSub').textContent = deltaText(cur.uscite, prev.uscite, prev.n);

    var rate = cur.entrate > 0 ? (cur.saldo / cur.entrate) * 100 : null;
    $('#kpiRate').textContent = rate === null ? '—' : Math.round(rate) + '%';
    $('#kpiRateSub').textContent = rate === null
      ? 'serve almeno un’entrata'
      : (rate >= 0 ? 'di ogni 100 € incassati te ne restano ' + Math.round(rate) : 'stai spendendo più di quanto entra');

    $('#noteCatIn').textContent = monthName(state.month);
    $('#noteCatOut').textContent = monthName(state.month);

    renderTrend();
    renderCategories('#chartCatIn', '#tableCatIn', 'entrata');
    renderCategories('#chartCatOut', '#tableCatOut', 'uscita');
    renderRecent();
  }

  function deltaText(cur, prev, prevN) {
    if (!prevN) return '';
    var diff = cur - prev;
    if (Math.abs(diff) < 0.005) return 'come il mese scorso';
    return (diff > 0 ? '+' : '−') + eur(Math.abs(diff)) + ' vs mese prec.';
  }

  function renderRecent() {
    var host = $('#recentList');
    var list = ofMonth(state.month).slice().sort(cmpDesc).slice(0, 6);
    if (!list.length) {
      host.innerHTML = emptyState();
      wireEmpty(host);
      return;
    }
    host.innerHTML = list.map(rowHtml).join('');
    wireRows(host);
  }

  function emptyState() {
    var hasAny = data.movimenti.length > 0;
    return '<div class="empty">' +
      '<strong>' + (hasAny ? 'Nessun movimento in questo mese' : 'Inizia da qui') + '</strong>' +
      '<span>' + (hasAny
        ? 'Cambia mese con le frecce in alto, oppure aggiungi un movimento.'
        : 'Registra la tua prima entrata con il pulsante Aggiungi.') + '</span>' +
      (hasAny ? '' : '<button class="btn btn-sm" type="button" data-demo="1">Carica dati di esempio</button>') +
      '</div>';
  }
  function wireEmpty(host) {
    var b = host.querySelector('[data-demo]');
    if (b) b.addEventListener('click', loadDemo);
  }

  function cmpDesc(a, b) {
    if (a.data !== b.data) return a.data < b.data ? 1 : -1;
    return (b.creato || 0) - (a.creato || 0);
  }

  function rowHtml(m) {
    var isIn = m.tipo === 'entrata';
    return '<button class="row" type="button" data-id="' + esc(m.id) + '">' +
      '<span class="row-mark ' + (isIn ? 'in' : 'out') + '" aria-hidden="true">' + (isIn ? '+' : '−') + '</span>' +
      '<span class="row-main">' +
      '<span class="row-cat">' + esc(m.categoria) + '</span>' +
      '<span class="row-note">' + esc(m.nota || fromISO(m.data).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })) + '</span>' +
      '</span>' +
      '<span class="row-amt ' + (isIn ? 'in' : 'out') + '">' + (isIn ? '+' : '−') + esc(eur(m.importo)) + '</span>' +
      '</button>';
  }

  function wireRows(host) {
    host.querySelectorAll('.row').forEach(function (r) {
      r.addEventListener('click', function () { openSheet(r.getAttribute('data-id')); });
    });
  }

  // ---------------------------------------------------------------- movimenti
  function filteredList() {
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    var year = state.month.slice(0, 4);
    return data.movimenti.filter(function (m) {
      if (f.period === 'month' && monthKey(m.data) !== state.month) return false;
      if (f.period === 'year' && m.data.slice(0, 4) !== year) return false;
      if (f.type !== 'all' && m.tipo !== f.type) return false;
      if (f.cat !== 'all' && m.categoria !== f.cat) return false;
      if (q) {
        var hay = (m.categoria + ' ' + (m.nota || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    }).sort(cmpDesc);
  }

  function renderMovimenti() {
    var list = filteredList();
    var t = totals(list);

    $('#filterSummary').innerHTML =
      '<span>' + t.n + (t.n === 1 ? ' movimento' : ' movimenti') + '</span>' +
      '<span>Entrate <b style="color:var(--in)">' + esc(eur(t.entrate)) + '</b></span>' +
      '<span>Uscite <b style="color:var(--out)">' + esc(eur(t.uscite)) + '</b></span>' +
      '<span>Saldo <b style="color:' + (t.saldo >= 0 ? 'var(--good)' : 'var(--bad)') + '">' +
      esc(signed(t.saldo)) + '</b></span>';

    var host = $('#fullList');
    if (!list.length) {
      host.innerHTML = '<div class="empty"><strong>Nessun risultato</strong><span>Prova ad allargare i filtri qui sopra.</span></div>';
      return;
    }

    var html = '', lastDay = null;
    list.forEach(function (m) {
      if (m.data !== lastDay) {
        lastDay = m.data;
        var dayTot = list.filter(function (x) { return x.data === m.data; })
          .reduce(function (a, x) { return a + (x.tipo === 'entrata' ? x.importo : -x.importo); }, 0);
        html += '<div class="list-day"><span>' + esc(dayName(m.data)) + '</span><span>' +
          esc(signed(dayTot)) + '</span></div>';
      }
      html += rowHtml(m);
    });
    host.innerHTML = html;
    wireRows(host);
  }

  function refreshCatFilter() {
    var sel = $('#fCat');
    var cur = sel.value;
    var all = {};
    data.movimenti.forEach(function (m) { all[m.categoria] = 1; });
    var names = Object.keys(all).sort(function (a, b) { return a.localeCompare(b, 'it'); });
    sel.innerHTML = '<option value="all">Tutte</option>' +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    sel.value = names.indexOf(cur) > -1 ? cur : 'all';
    state.filters.cat = sel.value;
  }

  // ---------------------------------------------------------------- impostazioni
  function renderSettings() {
    renderChips('#catsIn', 'entrata');
    renderChips('#catsOut', 'uscita');
    var bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length; } catch (e) { bytes = 0; }
    $('#storageInfo').textContent = data.movimenti.length + ' movimenti salvati · ' +
      (bytes < 1024 ? bytes + ' byte' : Math.round(bytes / 1024) + ' KB') + ' occupati su questo dispositivo.';
  }

  function renderChips(sel, kind) {
    var host = $(sel);
    host.innerHTML = data.categorie[kind].map(function (c) {
      return '<span class="chip">' + esc(c) +
        '<button type="button" aria-label="Rimuovi ' + esc(c) + '" data-cat="' + esc(c) + '">×</button></span>';
    }).join('');
    host.querySelectorAll('button[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-cat');
        var used = data.movimenti.some(function (m) { return m.categoria === name; });
        if (used && !confirm('La categoria "' + name + '" è usata da movimenti già registrati.\nI movimenti restano, ma la voce sparisce dal modulo. Continuare?')) return;
        data.categorie[kind] = data.categorie[kind].filter(function (c) { return c !== name; });
        if (!data.categorie[kind].length) data.categorie[kind] = ['Altro'];
        save();
        renderSettings();
      });
    });
  }

  // ---------------------------------------------------------------- sheet
  function fillCategorySelect() {
    var sel = $('#fCategory');
    sel.innerHTML = data.categorie[state.kind].map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function setKind(kind) {
    state.kind = kind;
    $$('.seg').forEach(function (s) {
      var on = s.getAttribute('data-kind') === kind;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    fillCategorySelect();
  }

  function openSheet(id) {
    var sheet = $('#sheet');
    $('#formError').hidden = true;
    state.editing = id || null;

    if (id) {
      var m = data.movimenti.find(function (x) { return x.id === id; });
      if (!m) return;
      $('#sheetTitle').textContent = 'Modifica movimento';
      setKind(m.tipo);
      $('#fAmount').value = m.importo.toFixed(2).replace('.', ',');
      $('#fDate').value = m.data;
      if (data.categorie[m.tipo].indexOf(m.categoria) === -1) {
        $('#fCategory').insertAdjacentHTML('beforeend',
          '<option value="' + esc(m.categoria) + '">' + esc(m.categoria) + '</option>');
      }
      $('#fCategory').value = m.categoria;
      $('#fNote').value = m.nota || '';
      $('#deleteTx').hidden = false;
    } else {
      $('#sheetTitle').textContent = 'Nuovo movimento';
      setKind('entrata');
      $('#fAmount').value = '';
      // se sto guardando un mese passato, propongo una data di quel mese
      var today = new Date();
      $('#fDate').value = (monthKey(toISO(today)) === state.month)
        ? toISO(today)
        : state.month + '-01';
      $('#fNote').value = '';
      $('#deleteTx').hidden = true;
    }

    if (typeof sheet.showModal === 'function') sheet.showModal();
    else sheet.setAttribute('open', '');
    setTimeout(function () { $('#fAmount').focus(); }, 40);
  }

  function closeSheet() {
    var sheet = $('#sheet');
    if (typeof sheet.close === 'function') sheet.close();
    else sheet.removeAttribute('open');
  }

  function submitTx(ev) {
    ev.preventDefault();
    var amount = parseAmount($('#fAmount').value);
    var err = $('#formError');

    if (!isFinite(amount) || amount <= 0) {
      err.textContent = 'Inserisci un importo valido, maggiore di zero.';
      err.hidden = false;
      $('#fAmount').focus();
      return;
    }
    var date = $('#fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      err.textContent = 'Scegli una data valida.';
      err.hidden = false;
      return;
    }
    err.hidden = true;

    var payload = {
      tipo: state.kind,
      importo: amount,
      data: date,
      categoria: $('#fCategory').value || 'Altro',
      nota: $('#fNote').value.trim()
    };

    if (state.editing) {
      var m = data.movimenti.find(function (x) { return x.id === state.editing; });
      if (m) {
        m.tipo = payload.tipo; m.importo = payload.importo; m.data = payload.data;
        m.categoria = payload.categoria; m.nota = payload.nota;
      }
      if (save()) toast('Movimento aggiornato');
    } else {
      payload.id = uid();
      payload.creato = Date.now();
      data.movimenti.push(payload);
      if (save()) toast((payload.tipo === 'entrata' ? 'Entrata' : 'Uscita') + ' di ' + eur(amount) + ' registrata');
    }

    state.month = monthKey(date);
    closeSheet();
    refreshCatFilter();
    renderAll();
  }

  function deleteTx() {
    if (!state.editing) return;
    if (!confirm('Eliminare definitivamente questo movimento?')) return;
    data.movimenti = data.movimenti.filter(function (m) { return m.id !== state.editing; });
    save();
    closeSheet();
    refreshCatFilter();
    renderAll();
    toast('Movimento eliminato');
  }

  // ---------------------------------------------------------------- backup
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportJSON() {
    var payload = {
      app: 'bilancio', versione: 1, esportato: new Date().toISOString(),
      categorie: data.categorie, movimenti: data.movimenti
    };
    download('bilancio-backup-' + toISO(new Date()) + '.json', JSON.stringify(payload, null, 2));
    toast('Backup esportato');
  }

  function exportCSV() {
    var head = ['Data', 'Tipo', 'Categoria', 'Nota', 'Importo'];
    var rows = data.movimenti.slice().sort(function (a, b) { return a.data < b.data ? -1 : 1; })
      .map(function (m) {
        return [m.data, m.tipo, m.categoria, (m.nota || ''),
          (m.tipo === 'uscita' ? '-' : '') + m.importo.toFixed(2).replace('.', ',')];
      });
    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\r\n');
    download('bilancio-' + toISO(new Date()) + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
    toast('CSV esportato');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { toast('File non leggibile: non è un backup valido.'); return; }

      if (!parsed || !Array.isArray(parsed.movimenti)) {
        toast('File non valido: manca l’elenco dei movimenti.');
        return;
      }
      var incoming = parsed.movimenti.filter(function (m) {
        return m && (m.tipo === 'entrata' || m.tipo === 'uscita') &&
          typeof m.importo === 'number' && isFinite(m.importo) && /^\d{4}-\d{2}-\d{2}$/.test(m.data);
      });
      if (!incoming.length) { toast('Il backup non contiene movimenti validi.'); return; }

      var mode = data.movimenti.length === 0 ? 'replace' : null;
      if (!mode) {
        mode = confirm('Trovati ' + incoming.length + ' movimenti nel backup.\n\n' +
          'OK = UNISCI ai ' + data.movimenti.length + ' movimenti già presenti\n' +
          'Annulla = SOSTITUISCI tutto con il backup') ? 'merge' : 'replace';
      }

      if (mode === 'replace') {
        data.movimenti = [];
      }
      var known = {};
      data.movimenti.forEach(function (m) { known[m.id] = 1; });

      var added = 0;
      incoming.forEach(function (m) {
        var id = (typeof m.id === 'string' && m.id) ? m.id : uid();
        if (known[id]) return;           // evita duplicati alla riunione
        known[id] = 1;
        data.movimenti.push({
          id: id, tipo: m.tipo, importo: Math.abs(m.importo), data: m.data,
          categoria: String(m.categoria || 'Altro').slice(0, 40),
          nota: String(m.nota || '').slice(0, 80),
          creato: typeof m.creato === 'number' ? m.creato : Date.now()
        });
        added++;
      });

      if (parsed.categorie) {
        ['entrata', 'uscita'].forEach(function (k) {
          if (Array.isArray(parsed.categorie[k])) {
            parsed.categorie[k].forEach(function (c) {
              c = String(c).slice(0, 28);
              if (c && data.categorie[k].indexOf(c) === -1) data.categorie[k].push(c);
            });
          }
        });
      }

      save();
      refreshCatFilter();
      renderAll();
      toast(added + (added === 1 ? ' movimento importato' : ' movimenti importati'));
    };
    reader.onerror = function () { toast('Non riesco a leggere il file.'); };
    reader.readAsText(file);
  }

  function wipe() {
    if (!confirm('Cancellare TUTTI i movimenti di questo dispositivo?\n\nL’operazione non è reversibile. Se non hai un backup, annulla ed esportalo prima.')) return;
    if (!confirm('Confermi definitivamente? Tutti i dati verranno persi.')) return;
    data.movimenti = [];
    data.categorie = { entrata: DEFAULT_CATS.entrata.slice(), uscita: DEFAULT_CATS.uscita.slice() };
    save();
    refreshCatFilter();
    renderAll();
    toast('Tutti i dati sono stati cancellati');
  }

  function loadDemo() {
    var today = new Date();
    var demo = [];
    var inCats = [['Stipendio', 1650], ['Lavoro freelance', 420], ['Vendite', 180]];
    var outCats = [['Casa', 620], ['Spesa', 310], ['Trasporti', 95], ['Bollette', 140], ['Svago', 130], ['Abbonamenti', 35]];
    for (var back = 5; back >= 0; back--) {
      var d = new Date(today.getFullYear(), today.getMonth() - back, 1);
      var mk = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      inCats.forEach(function (c, i) {
        if (i === 2 && back % 2) return;
        demo.push({
          id: uid(), tipo: 'entrata', importo: Math.round(c[1] * (0.85 + Math.random() * 0.3)),
          data: mk + '-' + pad2(3 + i * 6), categoria: c[0], nota: '', creato: Date.now() + demo.length
        });
      });
      outCats.forEach(function (c, i) {
        demo.push({
          id: uid(), tipo: 'uscita', importo: Math.round(c[1] * (0.8 + Math.random() * 0.4)),
          data: mk + '-' + pad2(2 + i * 4), categoria: c[0], nota: '', creato: Date.now() + demo.length
        });
      });
    }
    data.movimenti = demo;
    save();
    refreshCatFilter();
    renderAll();
    toast('Dati di esempio caricati — cancellali dalle Impostazioni');
  }

  // ---------------------------------------------------------------- tema
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  function initTheme() {
    var t = 'auto';
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
    document.documentElement.setAttribute('data-theme', t);
  }
  function currentIsDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ---------------------------------------------------------------- viste
  function setView(name) {
    state.view = name;
    $$('.tab').forEach(function (t) {
      var on = t.getAttribute('data-view') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + name; });
    hideTip();
    renderAll();
    window.scrollTo({ top: 0, behavior: 'instant' in document.body.style ? 'instant' : 'auto' });
  }

  function renderAll() {
    if (state.view === 'riepilogo') renderSummary();
    else if (state.view === 'movimenti') renderMovimenti();
    else renderSettings();
  }

  // ---------------------------------------------------------------- eventi
  function init() {
    initTheme();
    load();
    refreshCatFilter();

    $('#themeBtn').addEventListener('click', function () {
      applyTheme(currentIsDark() ? 'light' : 'dark');
      renderAll();
    });

    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    });
    $$('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-goto')); });
    });

    $('#prevMonth').addEventListener('click', function () { state.month = shiftMonth(state.month, -1); renderAll(); });
    $('#nextMonth').addEventListener('click', function () { state.month = shiftMonth(state.month, 1); renderAll(); });
    $('#todayBtn').addEventListener('click', function () {
      var d = new Date();
      state.month = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      renderAll();
    });

    $('#addBtn').addEventListener('click', function () { openSheet(null); });
    $('#closeSheet').addEventListener('click', closeSheet);
    $('#cancelTx').addEventListener('click', closeSheet);
    $('#deleteTx').addEventListener('click', deleteTx);
    $('#txForm').addEventListener('submit', submitTx);
    $$('.seg').forEach(function (s) {
      s.addEventListener('click', function () { setKind(s.getAttribute('data-kind')); });
    });

    // toggle tabella/grafico
    $$('.btn-table').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-table');
        var on = !state.tables[key];
        state.tables[key] = on;
        b.classList.toggle('is-on', on);
        b.textContent = on ? 'Grafico' : 'Tabella';
        var chart = b.closest('.chart-card').querySelector('.chart');
        var scroll = chart.closest('.chart-scroll') || chart;
        scroll.hidden = on;
        $('#table' + key.charAt(0).toUpperCase() + key.slice(1)).hidden = !on;
      });
    });

    // filtri
    $('#fPeriod').addEventListener('change', function () { state.filters.period = this.value; renderMovimenti(); });
    $('#fType').addEventListener('change', function () { state.filters.type = this.value; renderMovimenti(); });
    $('#fCat').addEventListener('change', function () { state.filters.cat = this.value; renderMovimenti(); });
    $('#fSearch').addEventListener('input', function () { state.filters.q = this.value; renderMovimenti(); });

    // impostazioni
    $('#exportBtn').addEventListener('click', exportJSON);
    $('#csvBtn').addEventListener('click', exportCSV);
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importJSON(this.files[0]);
      this.value = '';
    });
    $('#wipeBtn').addEventListener('click', wipe);

    $$('.add-cat').forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var input = f.querySelector('input');
        var name = input.value.trim().slice(0, 28);
        var kind = f.getAttribute('data-kind');
        if (!name) return;
        if (data.categorie[kind].some(function (c) { return c.toLowerCase() === name.toLowerCase(); })) {
          toast('Categoria già presente'); return;
        }
        data.categorie[kind].push(name);
        save();
        input.value = '';
        renderSettings();
      });
    });

    // chiusura sheet con backdrop / Esc
    $('#sheet').addEventListener('click', function (ev) {
      if (ev.target === this) closeSheet();
    });
    window.addEventListener('scroll', hideTip, { passive: true });
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      hideTip();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.view === 'riepilogo') renderSummary();
      }, 120);
    });

    setView('riepilogo');

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
