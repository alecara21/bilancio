/* =========================================================================
   Servizio "Bilancio" — tracker di entrate e uscite.
   Si registra nel guscio con Hub.register(). Tutti i dati stanno in
   localStorage, sotto la chiave bilancio.v1: nulla lascia il dispositivo.
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'bilancio.v1';

  var DEFAULT_CATS = {
    entrata: ['Stipendio', 'Lavoro freelance', 'Vendite', 'Rimborsi', 'Regali', 'Investimenti', 'Altro'],
    uscita: ['Casa', 'Spesa', 'Trasporti', 'Bollette', 'Svago', 'Salute', 'Abbonamenti', 'Altro']
  };

  var data = { movimenti: [], categorie: null };
  var root = null;          // radice montata
  var listeners = [];       // listener su window/document, rimossi allo smontaggio

  /* ─────────────────────────── archivio ─────────────────────────── */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    var p = null;
    if (raw) { try { p = JSON.parse(raw); } catch (e) { p = null; } }

    data.movimenti = (p && Array.isArray(p.movimenti)) ? p.movimenti : [];
    var c = p && p.categorie;
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
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch (e) { Hub.toast('Spazio esaurito: non riesco a salvare. Esporta un backup.'); return false; }
  }

  /* ─────────────────────────── utilità ─────────────────────────── */
  var eurFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  var eurShort = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  function eur(n) { return eurFmt.format(n); }
  function eurK(n) {
    var a = Math.abs(n);
    if (a >= 10000) return (n < 0 ? '-' : '') + '€' + Math.round(a / 1000) + 'k';
    return eurShort.format(n);
  }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + eur(Math.abs(n)); }
  function esc(s) { return Hub.esc(s); }

  function uid() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthKey(iso) { return iso.slice(0, 7); }
  function fromISO(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function monthDate(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1); }
  function shiftMonth(k, d) {
    var x = monthDate(k); x.setMonth(x.getMonth() + d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1);
  }
  function monthName(k, style) {
    return monthDate(k).toLocaleDateString('it-IT', { month: style || 'long', year: 'numeric' });
  }
  function thisMonth() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function dayName(iso) {
    var d = fromISO(iso), t = new Date();
    if (toISO(t) === iso) return 'Oggi';
    t.setDate(t.getDate() - 1);
    if (toISO(t) === iso) return 'Ieri';
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // accetta "1.234,56" come "1234.56"
  function parseAmount(str) {
    if (typeof str !== 'string') return NaN;
    var s = str.trim().replace(/[\s €]/g, '');
    if (!s) return NaN;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > -1 && ld > -1) {
      if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lc > -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    if (!/^-?\d*\.?\d*$/.test(s)) return NaN;
    var n = parseFloat(s);
    return isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : NaN;
  }

  function el(name) { return root.querySelector('[data-el="' + name + '"]'); }
  function all(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function doc(sel) { return document.querySelector(sel); }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  /* ─────────────────────────── stato ─────────────────────────── */
  var state = {
    month: thisMonth(), view: 'riepilogo', editing: null, kind: 'entrata',
    tables: {}, filters: { period: 'month', type: 'all', cat: 'all', q: '' }
  };

  /* ─────────────────────────── calcoli ─────────────────────────── */
  function ofMonth(k) { return data.movimenti.filter(function (m) { return monthKey(m.data) === k; }); }

  function totals(list) {
    var t = { entrate: 0, uscite: 0, n: list.length };
    for (var i = 0; i < list.length; i++) {
      if (list[i].tipo === 'entrata') t.entrate += list[i].importo; else t.uscite += list[i].importo;
    }
    t.saldo = t.entrate - t.uscite;
    return t;
  }

  function byCategory(list, tipo) {
    var map = Object.create(null);
    list.forEach(function (m) {
      if (m.tipo !== tipo) return;
      if (!map[m.categoria]) map[m.categoria] = { cat: m.categoria, tot: 0, n: 0 };
      map[m.categoria].tot += m.importo;
      map[m.categoria].n++;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.tot - a.tot; });
  }

  // oltre 7 voci la lettura si degrada: la coda diventa "Altre"
  function capCategories(arr, cap) {
    cap = cap || 7;
    if (arr.length <= cap) return arr;
    var head = arr.slice(0, cap - 1), tail = arr.slice(cap - 1);
    var rest = { cat: 'Altre (' + tail.length + ')', tot: 0, n: 0 };
    tail.forEach(function (x) { rest.tot += x.tot; rest.n += x.n; });
    head.push(rest);
    return head;
  }

  function lastMonths(k, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(shiftMonth(k, -i));
    return out;
  }

  // tetto "tondo" appena sopra il massimo, per non lasciare mezzo grafico vuoto
  function niceMax(v) {
    if (v <= 0) return 100;
    var mag = Math.pow(10, Math.floor(Math.log10(v))), r = v / mag;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (r <= steps[i] + 1e-9) return steps[i] * mag;
    return 10 * mag;
  }

  /* ─────────────────────────── tooltip ─────────────────────────── */
  function showTip(html, x, y) {
    var tip = doc('#tip');
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
  function hideTip() { var t = doc('#tip'); if (t) t.hidden = true; }

  function tipRow(k, v, color) {
    return '<div class="tip-row"><span class="k"><span class="swatch" style="background:' + color +
      '"></span>' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
  }

  /* ─────────────────────────── grafici ─────────────────────────── */
  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" xmlns="http://www.w3.org/2000/svg">';
  }

  // colonna con estremità arrotondata (4px) ancorata alla linea di base
  function colPath(x, y, w, h, r) {
    if (h <= 0.5) return '';
    r = Math.min(r, w / 2, h);
    return 'M' + x + ' ' + (y + h) + 'V' + (y + r) +
      'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + -r +
      'h' + (w - 2 * r) +
      'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
      'V' + (y + h) + 'Z';
  }

  function emptyChart(host, msg) {
    host.innerHTML = '<div class="chart-empty"><span>' + esc(msg) + '</span></div>';
  }

  // misura sulla card, non sul contenitore: un SVG largo rimasto da un
  // render precedente non deve falsare la larghezza disponibile
  function availWidth(node, fallback) {
    var card = node.closest ? node.closest('.card') : null, w = 0;
    if (card) {
      var cs = getComputedStyle(card);
      w = card.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    }
    if (!(w > 40)) w = node.clientWidth;
    return w > 40 ? Math.floor(w) : fallback;
  }

  function renderTrend() {
    var host = el('chartTrend');
    var rows = lastMonths(state.month, 12).map(function (k) {
      var t = totals(ofMonth(k));
      return { key: k, entrate: t.entrate, uscite: t.uscite, saldo: t.saldo };
    });
    var peak = 0;
    rows.forEach(function (r) { peak = Math.max(peak, r.entrate, r.uscite); });

    renderTrendTable(rows);
    if (peak === 0) { emptyChart(host, 'Nessun movimento negli ultimi 12 mesi.'); return; }

    var W = Math.max(availWidth(host, 620), 580), H = 240;
    var padL = 52, padR = 8, padT = 12, padB = 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var top = niceMax(peak), band = plotW / rows.length;
    var barW = Math.max(6, Math.min(15, (band - 12) / 2)), gap = 2;

    var s = svgOpen(W, H) + '<title>Entrate e uscite mensili degli ultimi 12 mesi</title>';

    for (var i = 0; i <= 4; i++) {
      var y = padT + plotH - (plotH * i / 4);
      s += '<line class="gridline" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      s += '<text class="tick" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' +
        esc(eurK(top * i / 4)) + '</text>';
    }
    s += '<line class="axisline" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) +
      '" y2="' + (padT + plotH) + '"/>';

    rows.forEach(function (r, i) {
      var cx = padL + band * i + band / 2, base = padT + plotH;
      var hIn = plotH * (r.entrate / top), hOut = plotH * (r.uscite / top);
      s += '<path d="' + colPath(cx - barW - gap / 2, base - hIn, barW, hIn, 4) + '" fill="var(--in)"/>';
      s += '<path d="' + colPath(cx + gap / 2, base - hOut, barW, hOut, 4) + '" fill="var(--out)"/>';

      var lbl = monthDate(r.key).toLocaleDateString('it-IT', { month: 'short' });
      var cur = r.key === state.month;
      s += '<text class="tick" x="' + cx + '" y="' + (base + 15) + '" text-anchor="middle"' +
        (cur ? ' style="fill:var(--ink);font-weight:600"' : '') + '>' + esc(lbl) + '</text>';
      if (i === 0 || monthDate(r.key).getMonth() === 0) {
        s += '<text class="tick" x="' + cx + '" y="' + (base + 27) + '" text-anchor="middle">' +
          monthDate(r.key).getFullYear() + '</text>';
      }
      // area sensibile larga quanto il mese, non quanto la barra
      s += '<rect class="hitband" x="' + (padL + band * i) + '" y="' + padT + '" width="' + band +
        '" height="' + plotH + '" data-i="' + i + '"/>';
    });

    host.innerHTML = s + '</svg>';

    var scroller = host.parentNode;
    if (scroller && scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = scroller.scrollWidth;

    Array.prototype.forEach.call(host.querySelectorAll('.hitband'), function (b) {
      b.addEventListener('mousemove', function (ev) {
        var r = rows[+b.getAttribute('data-i')];
        showTip('<div class="tip-title">' + esc(monthName(r.key)) + '</div>' +
          tipRow('Entrate', eur(r.entrate), 'var(--in)') +
          tipRow('Uscite', eur(r.uscite), 'var(--out)') +
          '<div class="tip-sep"></div>' +
          '<div class="tip-row"><span class="k">Saldo</span><span class="v" style="color:' +
          (r.saldo >= 0 ? 'var(--good)' : 'var(--bad)') + '">' + esc(signed(r.saldo)) + '</span></div>',
          ev.clientX, ev.clientY);
      });
      b.addEventListener('mouseleave', hideTip);
      b.addEventListener('click', function () {
        state.month = rows[+b.getAttribute('data-i')].key;
        hideTip();
        renderSummary();
      });
    });
  }

  function renderTrendTable(rows) {
    var h = '<table><thead><tr><th>Mese</th><th>Entrate</th><th>Uscite</th><th>Saldo</th></tr></thead><tbody>';
    var tE = 0, tU = 0;
    rows.forEach(function (r) {
      tE += r.entrate; tU += r.uscite;
      h += '<tr><td>' + esc(monthName(r.key, 'short')) + '</td><td>' + esc(eur(r.entrate)) +
        '</td><td>' + esc(eur(r.uscite)) + '</td><td>' + esc(signed(r.saldo)) + '</td></tr>';
    });
    el('tableTrend').innerHTML = h + '</tbody><tfoot><tr><td>Totale</td><td>' + esc(eur(tE)) +
      '</td><td>' + esc(eur(tU)) + '</td><td>' + esc(signed(tE - tU)) + '</td></tr></tfoot></table>';
  }

  function renderCategories(chartName, tableName, tipo) {
    var host = el(chartName);
    var cats = capCategories(byCategory(ofMonth(state.month), tipo));
    var tot = cats.reduce(function (a, c) { return a + c.tot; }, 0);
    var color = tipo === 'entrata' ? 'var(--in)' : 'var(--out)';

    // ogni grafico ha il suo equivalente in tabella
    var th = '<table><thead><tr><th>Categoria</th><th>Importo</th><th>Quota</th><th>N.</th></tr></thead><tbody>';
    cats.forEach(function (c) {
      th += '<tr><td>' + esc(c.cat) + '</td><td>' + esc(eur(c.tot)) + '</td><td>' +
        (tot ? Math.round(c.tot / tot * 100) : 0) + '%</td><td>' + c.n + '</td></tr>';
    });
    th += '</tbody><tfoot><tr><td>Totale</td><td>' + esc(eur(tot)) + '</td><td>100%</td><td>' +
      cats.reduce(function (a, c) { return a + c.n; }, 0) + '</td></tr></tfoot></table>';
    el(tableName).innerHTML = cats.length ? th : '<p class="card-note">Nessun dato.</p>';

    if (!cats.length) {
      emptyChart(host, tipo === 'entrata' ? 'Nessuna entrata in questo mese.' : 'Nessuna uscita in questo mese.');
      return;
    }

    var W = availWidth(host, 300), rowH = 40, H = cats.length * rowH + 2;
    var max = cats[0].tot || 1;
    var s = svgOpen(W, H).replace('width="' + W + '"', 'width="100%"') +
      '<title>' + (tipo === 'entrata' ? 'Entrate' : 'Uscite') + ' per categoria</title>';

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

    host.innerHTML = s + '</svg>';

    Array.prototype.forEach.call(host.querySelectorAll('.hitband'), function (b) {
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

  /* ─────────────────────────── riepilogo ─────────────────────────── */
  function renderSummary() {
    el('monthLabel').textContent = monthName(state.month);

    var cur = totals(ofMonth(state.month));
    var prev = totals(ofMonth(shiftMonth(state.month, -1)));

    var hero = el('heroSaldo');
    hero.textContent = signed(cur.saldo);
    hero.className = 'hero-figure ' + (cur.saldo > 0 ? 'is-pos' : cur.saldo < 0 ? 'is-neg' : '');

    var d = el('heroDelta');
    if (prev.n === 0) { d.className = 'delta flat'; d.textContent = ''; }
    else {
      var diff = cur.saldo - prev.saldo;
      d.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
      d.textContent = (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '= ') + eur(Math.abs(diff)) + ' vs mese prec.';
    }

    el('heroSub').textContent = cur.n === 0
      ? 'Nessun movimento in questo mese.'
      : cur.n + (cur.n === 1 ? ' movimento' : ' movimenti') + ' registrati.';

    el('kpiIn').textContent = eur(cur.entrate);
    el('kpiOut').textContent = eur(cur.uscite);
    el('kpiInSub').textContent = deltaText(cur.entrate, prev.entrate, prev.n);
    el('kpiOutSub').textContent = deltaText(cur.uscite, prev.uscite, prev.n);

    var rate = cur.entrate > 0 ? (cur.saldo / cur.entrate) * 100 : null;
    el('kpiRate').textContent = rate === null ? '—' : Math.round(rate) + '%';
    el('kpiRateSub').textContent = rate === null
      ? 'serve almeno un’entrata'
      : (rate >= 0 ? 'di ogni 100 € te ne restano ' + Math.round(rate) : 'spendi più di quanto entra');

    el('noteCatIn').textContent = monthName(state.month);
    el('noteCatOut').textContent = monthName(state.month);

    renderTrend();
    renderCategories('chartCatIn', 'tableCatIn', 'entrata');
    renderCategories('chartCatOut', 'tableCatOut', 'uscita');
    renderRecent();
  }

  function deltaText(cur, prev, prevN) {
    if (!prevN) return '';
    var diff = cur - prev;
    if (Math.abs(diff) < 0.005) return 'come il mese scorso';
    return (diff > 0 ? '+' : '−') + eur(Math.abs(diff)) + ' vs mese prec.';
  }

  function cmpDesc(a, b) {
    if (a.data !== b.data) return a.data < b.data ? 1 : -1;
    return (b.creato || 0) - (a.creato || 0);
  }

  function rowHtml(m) {
    var isIn = m.tipo === 'entrata';
    return '<button class="row" type="button" data-id="' + esc(m.id) + '">' +
      '<span class="row-mark ' + (isIn ? 'in' : 'out') + '" aria-hidden="true">' + (isIn ? '+' : '−') + '</span>' +
      '<span class="row-main"><span class="row-cat">' + esc(m.categoria) + '</span>' +
      '<span class="row-note">' + esc(m.nota || fromISO(m.data).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })) + '</span></span>' +
      '<span class="row-amt ' + (isIn ? 'in' : 'out') + '">' + (isIn ? '+' : '−') + esc(eur(m.importo)) + '</span>' +
      '</button>';
  }

  function wireRows(host) {
    Array.prototype.forEach.call(host.querySelectorAll('.row'), function (r) {
      r.addEventListener('click', function () { openSheet(r.getAttribute('data-id')); });
    });
  }

  function renderRecent() {
    var host = el('recentList');
    var list = ofMonth(state.month).slice().sort(cmpDesc).slice(0, 6);
    if (!list.length) {
      var hasAny = data.movimenti.length > 0;
      host.innerHTML = '<div class="empty"><strong>' +
        (hasAny ? 'Nessun movimento in questo mese' : 'Inizia da qui') + '</strong><span>' +
        (hasAny ? 'Cambia mese con le frecce, oppure aggiungi un movimento.'
                : 'Registra la tua prima entrata con il pulsante Aggiungi.') + '</span>' +
        (hasAny ? '' : '<button class="btn btn-sm" type="button" data-demo="1">Carica dati di esempio</button>') +
        '</div>';
      var b = host.querySelector('[data-demo]');
      if (b) b.addEventListener('click', loadDemo);
      return;
    }
    host.innerHTML = list.map(rowHtml).join('');
    wireRows(host);
  }

  /* ─────────────────────────── movimenti ─────────────────────────── */
  function filteredList() {
    var f = state.filters, q = f.q.trim().toLowerCase(), year = state.month.slice(0, 4);
    return data.movimenti.filter(function (m) {
      if (f.period === 'month' && monthKey(m.data) !== state.month) return false;
      if (f.period === 'year' && m.data.slice(0, 4) !== year) return false;
      if (f.type !== 'all' && m.tipo !== f.type) return false;
      if (f.cat !== 'all' && m.categoria !== f.cat) return false;
      if (q && (m.categoria + ' ' + (m.nota || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(cmpDesc);
  }

  function renderMovimenti() {
    var list = filteredList(), t = totals(list);

    el('filterSummary').innerHTML =
      '<span>' + t.n + (t.n === 1 ? ' movimento' : ' movimenti') + '</span>' +
      '<span>Entrate <b style="color:var(--in)">' + esc(eur(t.entrate)) + '</b></span>' +
      '<span>Uscite <b style="color:var(--out)">' + esc(eur(t.uscite)) + '</b></span>' +
      '<span>Saldo <b style="color:' + (t.saldo >= 0 ? 'var(--good)' : 'var(--bad)') + '">' +
      esc(signed(t.saldo)) + '</b></span>';

    var host = el('fullList');
    if (!list.length) {
      host.innerHTML = '<div class="empty"><strong>Nessun risultato</strong><span>Prova ad allargare i filtri.</span></div>';
      return;
    }

    // totale per giorno calcolato una volta sola
    var perDay = Object.create(null);
    list.forEach(function (m) {
      perDay[m.data] = (perDay[m.data] || 0) + (m.tipo === 'entrata' ? m.importo : -m.importo);
    });

    var html = '', lastDay = null;
    list.forEach(function (m) {
      if (m.data !== lastDay) {
        lastDay = m.data;
        html += '<div class="list-day"><span>' + esc(dayName(m.data)) + '</span><span>' +
          esc(signed(perDay[m.data])) + '</span></div>';
      }
      html += rowHtml(m);
    });
    host.innerHTML = html;
    wireRows(host);
  }

  function refreshCatFilter() {
    var sel = el('fCat');
    if (!sel) return;
    var cur = sel.value, seen = {};
    data.movimenti.forEach(function (m) { seen[m.categoria] = 1; });
    var names = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, 'it'); });
    sel.innerHTML = '<option value="all">Tutte</option>' +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
    sel.value = names.indexOf(cur) > -1 ? cur : 'all';
    state.filters.cat = sel.value;
  }

  /* ─────────────────────────── opzioni ─────────────────────────── */
  function renderSettings() {
    renderChips('catsIn', 'entrata');
    renderChips('catsOut', 'uscita');
    var bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length; } catch (e) {}
    el('storageInfo').textContent = data.movimenti.length + ' movimenti salvati · ' +
      (bytes < 1024 ? bytes + ' byte' : Math.round(bytes / 1024) + ' KB') + ' su questo dispositivo.';
  }

  function renderChips(name, kind) {
    var host = el(name);
    host.innerHTML = data.categorie[kind].map(function (c) {
      return '<span class="chip">' + esc(c) +
        '<button type="button" aria-label="Rimuovi ' + esc(c) + '" data-cat="' + esc(c) + '">×</button></span>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('button[data-cat]'), function (b) {
      b.addEventListener('click', function () {
        var n = b.getAttribute('data-cat');
        var used = data.movimenti.some(function (m) { return m.categoria === n; });
        if (used && !confirm('La categoria "' + n + '" è usata da movimenti già registrati.\nI movimenti restano, ma la voce sparisce dal modulo. Continuare?')) return;
        data.categorie[kind] = data.categorie[kind].filter(function (c) { return c !== n; });
        if (!data.categorie[kind].length) data.categorie[kind] = ['Altro'];
        save();
        renderSettings();
      });
    });
  }

  /* ─────────────────────────── modulo inserimento ─────────────────────────── */
  function fillCategorySelect() {
    doc('#fCategory').innerHTML = data.categorie[state.kind].map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('');
  }

  function setKind(kind) {
    state.kind = kind;
    Array.prototype.forEach.call(document.querySelectorAll('#sheet .seg'), function (s) {
      var on = s.getAttribute('data-kind') === kind;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    fillCategorySelect();
  }

  function openSheet(id) {
    var sheet = doc('#sheet');
    doc('#formError').hidden = true;
    state.editing = id || null;

    if (id) {
      var m = data.movimenti.filter(function (x) { return x.id === id; })[0];
      if (!m) return;
      doc('#sheetTitle').textContent = 'Modifica movimento';
      setKind(m.tipo);
      doc('#fAmount').value = m.importo.toFixed(2).replace('.', ',');
      doc('#fDate').value = m.data;
      if (data.categorie[m.tipo].indexOf(m.categoria) === -1) {
        doc('#fCategory').insertAdjacentHTML('beforeend',
          '<option value="' + esc(m.categoria) + '">' + esc(m.categoria) + '</option>');
      }
      doc('#fCategory').value = m.categoria;
      doc('#fNote').value = m.nota || '';
      doc('#deleteTx').hidden = false;
    } else {
      doc('#sheetTitle').textContent = 'Nuovo movimento';
      setKind('entrata');
      doc('#fAmount').value = '';
      doc('#fDate').value = (thisMonth() === state.month) ? toISO(new Date()) : state.month + '-01';
      doc('#fNote').value = '';
      doc('#deleteTx').hidden = true;
    }

    if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
    setTimeout(function () { doc('#fAmount').focus(); }, 60);
  }

  function closeSheet() {
    var sheet = doc('#sheet');
    if (typeof sheet.close === 'function') sheet.close(); else sheet.removeAttribute('open');
  }

  function submitTx(ev) {
    ev.preventDefault();
    var amount = parseAmount(doc('#fAmount').value), err = doc('#formError');

    if (!isFinite(amount) || amount <= 0) {
      err.textContent = 'Inserisci un importo valido, maggiore di zero.';
      err.hidden = false; doc('#fAmount').focus(); return;
    }
    var date = doc('#fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      err.textContent = 'Scegli una data valida.'; err.hidden = false; return;
    }
    err.hidden = true;

    var p = {
      tipo: state.kind, importo: amount, data: date,
      categoria: doc('#fCategory').value || 'Altro', nota: doc('#fNote').value.trim()
    };

    if (state.editing) {
      var m = data.movimenti.filter(function (x) { return x.id === state.editing; })[0];
      if (m) { m.tipo = p.tipo; m.importo = p.importo; m.data = p.data; m.categoria = p.categoria; m.nota = p.nota; }
      if (save()) Hub.toast('Movimento aggiornato');
    } else {
      p.id = uid(); p.creato = Date.now();
      data.movimenti.push(p);
      if (save()) Hub.toast((p.tipo === 'entrata' ? 'Entrata' : 'Uscita') + ' di ' + eur(amount) + ' registrata');
    }

    state.month = monthKey(date);
    closeSheet();
    refreshCatFilter();
    renderCurrent();
  }

  function deleteTx() {
    if (!state.editing) return;
    if (!confirm('Eliminare definitivamente questo movimento?')) return;
    data.movimenti = data.movimenti.filter(function (m) { return m.id !== state.editing; });
    save(); closeSheet(); refreshCatFilter(); renderCurrent();
    Hub.toast('Movimento eliminato');
  }

  /* ─────────────────────────── backup ─────────────────────────── */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportJSON() {
    download('bilancio-backup-' + toISO(new Date()) + '.json', JSON.stringify({
      app: 'bilancio', versione: 1, esportato: new Date().toISOString(),
      categorie: data.categorie, movimenti: data.movimenti
    }, null, 2));
    Hub.toast('Backup esportato');
  }

  function exportCSV() {
    var rows = [['Data', 'Tipo', 'Categoria', 'Nota', 'Importo']].concat(
      data.movimenti.slice().sort(function (a, b) { return a.data < b.data ? -1 : 1; })
        .map(function (m) {
          return [m.data, m.tipo, m.categoria, m.nota || '',
            (m.tipo === 'uscita' ? '-' : '') + m.importo.toFixed(2).replace('.', ',')];
        }));
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';');
    }).join('\r\n');
    download('bilancio-' + toISO(new Date()) + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
    Hub.toast('CSV esportato');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var p;
      try { p = JSON.parse(String(reader.result)); }
      catch (e) { Hub.toast('File non leggibile: non è un backup valido.'); return; }

      if (!p || !Array.isArray(p.movimenti)) { Hub.toast('File non valido: manca l’elenco dei movimenti.'); return; }

      var incoming = p.movimenti.filter(function (m) {
        return m && (m.tipo === 'entrata' || m.tipo === 'uscita') &&
          typeof m.importo === 'number' && isFinite(m.importo) && /^\d{4}-\d{2}-\d{2}$/.test(m.data);
      });
      if (!incoming.length) { Hub.toast('Il backup non contiene movimenti validi.'); return; }

      var mode = data.movimenti.length === 0 ? 'replace' : null;
      if (!mode) {
        mode = confirm('Trovati ' + incoming.length + ' movimenti nel backup.\n\n' +
          'OK = UNISCI ai ' + data.movimenti.length + ' già presenti\n' +
          'Annulla = SOSTITUISCI tutto con il backup') ? 'merge' : 'replace';
      }
      if (mode === 'replace') data.movimenti = [];

      var known = {};
      data.movimenti.forEach(function (m) { known[m.id] = 1; });

      var added = 0;
      incoming.forEach(function (m) {
        var id = (typeof m.id === 'string' && m.id) ? m.id : uid();
        if (known[id]) return;                     // niente doppioni quando si unisce
        known[id] = 1;
        data.movimenti.push({
          id: id, tipo: m.tipo, importo: Math.abs(m.importo), data: m.data,
          categoria: String(m.categoria || 'Altro').slice(0, 40),
          nota: String(m.nota || '').slice(0, 80),
          creato: typeof m.creato === 'number' ? m.creato : Date.now()
        });
        added++;
      });

      if (p.categorie) {
        ['entrata', 'uscita'].forEach(function (k) {
          if (!Array.isArray(p.categorie[k])) return;
          p.categorie[k].forEach(function (c) {
            c = String(c).slice(0, 28);
            if (c && data.categorie[k].indexOf(c) === -1) data.categorie[k].push(c);
          });
        });
      }

      save(); refreshCatFilter(); renderCurrent();
      Hub.toast(added + (added === 1 ? ' movimento importato' : ' movimenti importati'));
    };
    reader.onerror = function () { Hub.toast('Non riesco a leggere il file.'); };
    reader.readAsText(file);
  }

  function wipe() {
    if (!confirm('Cancellare TUTTI i movimenti?\n\nL’operazione non è reversibile. Se non hai un backup, annulla ed esportalo prima.')) return;
    if (!confirm('Confermi definitivamente? Tutti i dati verranno persi.')) return;
    data.movimenti = [];
    data.categorie = { entrata: DEFAULT_CATS.entrata.slice(), uscita: DEFAULT_CATS.uscita.slice() };
    save(); refreshCatFilter(); renderCurrent();
    Hub.toast('Tutti i dati sono stati cancellati');
  }

  function loadDemo() {
    var today = new Date(), demo = [];
    var ins = [['Stipendio', 1650], ['Lavoro freelance', 420], ['Vendite', 180]];
    var outs = [['Casa', 620], ['Spesa', 310], ['Trasporti', 95], ['Bollette', 140], ['Svago', 130], ['Abbonamenti', 35]];
    for (var back = 5; back >= 0; back--) {
      var d = new Date(today.getFullYear(), today.getMonth() - back, 1);
      var mk = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      /* jshint loopfunc:true */
      (function (mk, back) {
        ins.forEach(function (c, i) {
          if (i === 2 && back % 2) return;
          demo.push({ id: uid(), tipo: 'entrata', importo: Math.round(c[1] * (0.85 + Math.random() * 0.3)),
            data: mk + '-' + pad2(3 + i * 6), categoria: c[0], nota: '', creato: Date.now() + demo.length });
        });
        outs.forEach(function (c, i) {
          demo.push({ id: uid(), tipo: 'uscita', importo: Math.round(c[1] * (0.8 + Math.random() * 0.4)),
            data: mk + '-' + pad2(2 + i * 4), categoria: c[0], nota: '', creato: Date.now() + demo.length });
        });
      })(mk, back);
    }
    data.movimenti = demo;
    save(); refreshCatFilter(); renderCurrent();
    Hub.toast('Dati di esempio caricati — cancellali dalle Opzioni');
  }

  /* ─────────────────────────── viste ─────────────────────────── */
  function setView(name) {
    state.view = name;
    all('.segtab').forEach(function (t) {
      var on = t.getAttribute('data-view') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    all('[data-view-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-view-panel') !== name;
    });
    var fab = root.querySelector('.fab');
    if (fab) fab.hidden = (name === 'impostazioni');
    hideTip();
    renderCurrent();
    var body = document.getElementById('svcBody');
    if (body) body.scrollTop = 0;
  }

  function renderCurrent() {
    if (state.view === 'riepilogo') renderSummary();
    else if (state.view === 'movimenti') renderMovimenti();
    else renderSettings();
  }

  /* ─────────────────────────── montaggio ─────────────────────────── */
  function mount(host) {
    load();
    root = document.getElementById('tpl-bilancio').content.cloneNode(true).firstElementChild;
    host.appendChild(root);

    state.month = thisMonth();
    state.view = 'riepilogo';
    refreshCatFilter();

    all('.segtab').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    });
    all('[data-goto]').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-goto')); });
    });

    root.querySelector('[data-act="prevMonth"]').addEventListener('click', function () {
      state.month = shiftMonth(state.month, -1); renderCurrent();
    });
    root.querySelector('[data-act="nextMonth"]').addEventListener('click', function () {
      state.month = shiftMonth(state.month, 1); renderCurrent();
    });
    root.querySelector('[data-act="today"]').addEventListener('click', function () {
      state.month = thisMonth(); renderCurrent();
    });
    root.querySelector('[data-act="add"]').addEventListener('click', function () { openSheet(null); });

    all('.btn-table').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-table');
        var on = !state.tables[key];
        state.tables[key] = on;
        b.classList.toggle('is-on', on);
        b.textContent = on ? 'Grafico' : 'Tabella';
        var card = b.closest('.chart-card');
        var chart = card.querySelector('.chart');
        (chart.closest('.chart-scroll') || chart).hidden = on;
        card.querySelector('.table-view').hidden = !on;
      });
    });

    el('fPeriod').addEventListener('change', function () { state.filters.period = this.value; renderMovimenti(); });
    el('fType').addEventListener('change', function () { state.filters.type = this.value; renderMovimenti(); });
    el('fCat').addEventListener('change', function () { state.filters.cat = this.value; renderMovimenti(); });
    el('fSearch').addEventListener('input', function () { state.filters.q = this.value; renderMovimenti(); });

    root.querySelector('[data-act="export"]').addEventListener('click', exportJSON);
    root.querySelector('[data-act="csv"]').addEventListener('click', exportCSV);
    root.querySelector('[data-act="import"]').addEventListener('click', function () { el('importFile').click(); });
    el('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importJSON(this.files[0]);
      this.value = '';
    });
    root.querySelector('[data-act="wipe"]').addEventListener('click', wipe);

    all('.add-cat').forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var input = f.querySelector('input');
        var name = input.value.trim().slice(0, 28), kind = f.getAttribute('data-kind');
        if (!name) return;
        if (data.categorie[kind].some(function (c) { return c.toLowerCase() === name.toLowerCase(); })) {
          Hub.toast('Categoria già presente'); return;
        }
        data.categorie[kind].push(name);
        save(); input.value = ''; renderSettings();
      });
    });

    // modulo di inserimento (vive fuori dal servizio, nel body)
    on(doc('#txForm'), 'submit', submitTx);
    on(doc('#closeSheet'), 'click', closeSheet);
    on(doc('#cancelTx'), 'click', closeSheet);
    on(doc('#deleteTx'), 'click', deleteTx);
    on(doc('#sheet'), 'click', function (ev) { if (ev.target === this) closeSheet(); });
    Array.prototype.forEach.call(document.querySelectorAll('#sheet .seg'), function (s) {
      on(s, 'click', function () { setKind(s.getAttribute('data-kind')); });
    });

    var resizeTimer = null;
    on(window, 'resize', function () {
      hideTip();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (state.view === 'riepilogo') renderSummary(); }, 120);
    });
    on(document.getElementById('svcBody'), 'scroll', hideTip, { passive: true });

    setView('riepilogo');
  }

  function unmount() {
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners = [];
    closeSheet();
    hideTip();
    root = null;
  }

  function stat() {
    load();
    var t = totals(ofMonth(thisMonth()));
    if (t.n === 0) return { text: 'Nessun movimento', tone: '' };
    return { text: signed(t.saldo), tone: t.saldo >= 0 ? 'pos' : 'neg' };
  }

  Hub.register({
    id: 'bilancio', nome: 'Bilancio',
    mount: mount, unmount: unmount, stat: stat,
    onThemeChange: function () { if (state.view === 'riepilogo') renderSummary(); }
  });
})();
