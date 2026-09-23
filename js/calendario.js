/* =========================================================================
   Servizio "Calendario" — appuntamenti, compleanni, promemoria con sveglie.

   SULLE SVEGLIE, tre strade sovrapposte:
     · notifiche push (server Cloudflare): arrivano anche ad app chiusa. Il
       server conosce solo GLI ORARI; il testo sta in IndexedDB sul telefono e
       lo legge il service worker quando la notifica arriva;
     · esportazione .ics con VALARM verso il calendario di sistema: suona da
       solo, anche offline, senza dipendere da nessun server;
     · dentro l'app: avviso immediato mentre è aperta + elenco degli scaduti
       alla riapertura.
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'calendario.v1';

  // Server delle notifiche push. Sa solo QUANDO avvisare questo dispositivo:
  // il testo dei promemoria resta in IndexedDB, sul telefono.
  var PUSH_URL = 'https://hub-push.hub-push.workers.dev';
  var PUSH_PUBKEY = 'BOoKbbSLKpSW3tHksf5hfzC80z1fujbH79PU9RWBoB9abPR8mBYgyJRzQSkgJUdVhvL7ljtGVBizIM_VCxZsPCY';
  var DEV_KEY = 'hub.deviceId';
  var PUSH_KEY = 'hub.pushOn';

  var TIPI = {
    appuntamento: {
      nome: 'Appuntamento', classe: 't-appuntamento',
      icona: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6" fill="none" stroke-width="1.9"/><path d="M8 3v4M16 3v4M3.5 10h17" fill="none" stroke-width="1.9" stroke-linecap="round"/>'
    },
    compleanno: {
      nome: 'Compleanno', classe: 't-compleanno',
      icona: '<path d="M4 20.5h16v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6Z" fill="none" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 12.5v-4M12 5.5a1.5 1.5 0 1 1 0 3" fill="none" stroke-width="1.9" stroke-linecap="round"/>'
    },
    promemoria: {
      nome: 'Promemoria', classe: 't-promemoria',
      icona: '<path d="M12 3.5a6 6 0 0 0-6 6v4l-1.6 3h15.2L18 13.5v-4a6 6 0 0 0-6-6Z" fill="none" stroke-width="1.9" stroke-linejoin="round"/><path d="M10 19.5a2 2 0 0 0 4 0" fill="none" stroke-width="1.9" stroke-linecap="round"/>'
    }
  };

  var SVEGLIE = [
    { m: 0, et: 'All\u2019ora' }, { m: 15, et: '15 min prima' }, { m: 30, et: '30 min prima' },
    { m: 60, et: '1 ora prima' }, { m: 120, et: '2 ore prima' }, { m: 1440, et: '1 giorno prima' },
    { m: 2880, et: '2 giorni prima' }, { m: 10080, et: '1 settimana prima' }
  ];

  var RIPETI = { nessuna: '', annuale: 'ogni anno', mensile: 'ogni mese', settimanale: 'ogni settimana' };
  var RRULE = { annuale: 'FREQ=YEARLY', mensile: 'FREQ=MONTHLY', settimanale: 'FREQ=WEEKLY' };

  var data = { eventi: [], pref: { defTime: '09:00' }, ultimoAvviso: 0 };
  var root = null, listeners = [], timers = [];

  /* ─────────────────────────── archivio ─────────────────────────── */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    var p = null;
    if (raw) { try { p = JSON.parse(raw); } catch (e) {} }

    data.eventi = (p && Array.isArray(p.eventi)) ? p.eventi.filter(valido) : [];
    data.pref = { defTime: (p && p.pref && /^\d{2}:\d{2}$/.test(p.pref.defTime)) ? p.pref.defTime : '09:00' };
    data.ultimoAvviso = (p && typeof p.ultimoAvviso === 'number') ? p.ultimoAvviso : 0;
  }

  function valido(e) {
    return e && typeof e.id === 'string' && TIPI[e.tipo] &&
      typeof e.titolo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.data);
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch (e) { Hub.toast('Spazio esaurito: non riesco a salvare.'); return false; }
  }

  /* ─────────────────────────── utilità ─────────────────────────── */
  function esc(s) { return Hub.esc(s); }
  function uid() { return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fromISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function oggiISO() { return toISO(new Date()); }
  function addDays(iso, n) { var d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function minutiDi(hhmm) { var p = hhmm.split(':'); return (+p[0]) * 60 + (+p[1]); }

  // data + ora -> Date reale
  function quando(iso, ora) {
    var d = fromISO(iso);
    var m = minutiDi(ora || data.pref.defTime);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return d;
  }

  function nomeGiorno(iso) {
    var o = oggiISO();
    if (iso === o) return 'Oggi';
    if (iso === addDays(o, 1)) return 'Domani';
    if (iso === addDays(o, -1)) return 'Ieri';
    return fromISO(iso).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function traQuanto(iso, ora) {
    var giorni = Math.round((fromISO(iso) - fromISO(oggiISO())) / 86400000);
    if (giorni === 0) return ora ? 'oggi' : 'oggi';
    if (giorni === 1) return 'domani';
    if (giorni === -1) return 'ieri';
    if (giorni < 0) return Math.abs(giorni) + ' giorni fa';
    if (giorni < 7) return 'tra ' + giorni + ' giorni';
    if (giorni < 31) { var s = Math.round(giorni / 7); return 'tra ' + s + (s === 1 ? ' settimana' : ' settimane'); }
    var mm = Math.round(giorni / 30);
    return 'tra ' + mm + (mm === 1 ? ' mese' : ' mesi');
  }

  function el(n) { return root.querySelector('[data-el="' + n + '"]'); }
  function all(s) { return Array.prototype.slice.call(root.querySelectorAll(s)); }
  function doc(s) { return document.querySelector(s); }
  function on(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push([t, ty, fn, o]); }

  /* ─────────────────────────── ricorrenze ─────────────────────────── */
  // Restituisce le date (ISO) in cui l'evento cade dentro [da, a].
  function occorrenze(ev, da, a) {
    var out = [];
    if (ev.ripeti === 'nessuna' || !ev.ripeti) {
      if (ev.data >= da && ev.data <= a) out.push(ev.data);
      return out;
    }
    var base = fromISO(ev.data), dDa = fromISO(da), dA = fromISO(a);
    if (dA < base) return out;

    if (ev.ripeti === 'settimanale') {
      var giorniDaBase = Math.ceil((dDa - base) / 86400000);
      var salti = Math.max(0, Math.ceil(giorniDaBase / 7));
      var cur = new Date(base); cur.setDate(cur.getDate() + salti * 7);
      while (cur <= dA) { out.push(toISO(cur)); cur.setDate(cur.getDate() + 7); }
      return out;
    }

    if (ev.ripeti === 'mensile') {
      var giorno = base.getDate();
      var c = new Date(dDa.getFullYear(), dDa.getMonth(), 1);
      if (c < base) c = new Date(base.getFullYear(), base.getMonth(), 1);
      while (c <= dA) {
        var ultimo = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
        if (giorno <= ultimo) {               // salta i mesi che non hanno il 29/30/31
          var cand = new Date(c.getFullYear(), c.getMonth(), giorno);
          if (cand >= base && cand >= dDa && cand <= dA) out.push(toISO(cand));
        }
        c = new Date(c.getFullYear(), c.getMonth() + 1, 1);
      }
      return out;
    }

    // annuale (compleanni): il 29 febbraio ricade sul 28 negli anni comuni
    var mese = base.getMonth(), gg = base.getDate();
    for (var y = dDa.getFullYear(); y <= dA.getFullYear(); y++) {
      var ultimoM = new Date(y, mese + 1, 0).getDate();
      var cand2 = new Date(y, mese, Math.min(gg, ultimoM));
      if (cand2 >= base && cand2 >= dDa && cand2 <= dA) out.push(toISO(cand2));
    }
    return out;
  }

  // Espande tutti gli eventi in singole occorrenze ordinate.
  function espandi(da, a, filtro) {
    var out = [];
    data.eventi.forEach(function (ev) {
      if (filtro && !filtro(ev)) return;
      occorrenze(ev, da, a).forEach(function (iso) { out.push({ ev: ev, data: iso }); });
    });
    out.sort(function (x, y) {
      if (x.data !== y.data) return x.data < y.data ? -1 : 1;
      var ox = x.ev.ora || data.pref.defTime, oy = y.ev.ora || data.pref.defTime;
      return ox < oy ? -1 : ox > oy ? 1 : 0;
    });
    return out;
  }

  function etaCompleanno(ev, iso) {
    if (ev.tipo !== 'compleanno' || ev.ripeti !== 'annuale') return null;
    var anni = +iso.slice(0, 4) - +ev.data.slice(0, 4);
    return anni > 0 ? anni : null;
  }

  /* ─────────────────────────── stato ─────────────────────────── */
  var state = { mese: null, sel: null, view: 'mese', editing: null, tipo: 'appuntamento', sveglie: [], filtri: { range: '30', tipo: 'all', q: '' } };

  function meseCorrente() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function spostaMese(k, n) {
    var d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1 + n, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /* ─────────────────────────── vista mese ─────────────────────────── */
  function renderMese() {
    var k = state.mese;
    el('monthLabel').textContent = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1)
      .toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

    var primo = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, 1);
    var offset = (primo.getDay() + 6) % 7;                 // settimana che parte da lunedì
    var inizio = new Date(primo); inizio.setDate(1 - offset);
    var celle = 42;
    var fine = new Date(inizio); fine.setDate(fine.getDate() + celle - 1);

    var perGiorno = Object.create(null);
    espandi(toISO(inizio), toISO(fine)).forEach(function (o) {
      (perGiorno[o.data] = perGiorno[o.data] || []).push(o);
    });

    var oggi = oggiISO(), html = '';
    for (var i = 0; i < celle; i++) {
      var d = new Date(inizio); d.setDate(inizio.getDate() + i);
      var iso = toISO(d);
      var fuori = (d.getMonth() !== primo.getMonth());
      var lista = perGiorno[iso] || [];
      var punti = lista.slice(0, 3).map(function (o) {
        return '<span class="ev-dot ' + TIPI[o.ev.tipo].classe + '"></span>';
      }).join('');
      if (lista.length > 3) punti += '<span class="cal-more">+' + (lista.length - 3) + '</span>';

      html += '<button type="button" class="cal-day' +
        (fuori ? ' is-out' : '') + (iso === oggi ? ' is-today' : '') +
        (iso === state.sel ? ' is-sel' : '') + '" data-d="' + iso + '" role="gridcell"' +
        ' aria-label="' + esc(fromISO(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })) +
        (lista.length ? ', ' + lista.length + (lista.length === 1 ? ' evento' : ' eventi') : '') + '">' +
        '<span class="cal-num">' + d.getDate() + '</span>' +
        '<span class="cal-dots">' + punti + '</span></button>';
    }
    el('grid').innerHTML = html;

    all('.cal-day').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sel = b.getAttribute('data-d');
        if (state.sel.slice(0, 7) !== state.mese) state.mese = state.sel.slice(0, 7);
        renderMese();
      });
    });

    renderGiorno();
  }

  function renderGiorno() {
    var iso = state.sel;
    el('dayTitle').textContent = nomeGiorno(iso);
    var lista = espandi(iso, iso);
    var host = el('dayList');
    if (!lista.length) {
      host.innerHTML = '<div class="empty"><strong>Niente in programma</strong>' +
        '<span>Tocca "Aggiungi qui" per creare un evento in questa data.</span></div>';
      return;
    }
    host.innerHTML = lista.map(function (o) { return rigaEvento(o, false); }).join('');
    collegaRighe(host);
  }

  function rigaEvento(o, mostraData) {
    var ev = o.ev, t = TIPI[ev.tipo];
    var passato = quando(o.data, ev.ora) < new Date();
    var eta = etaCompleanno(ev, o.data);

    var meta = [];
    meta.push(ev.ora ? ev.ora : 'tutto il giorno');
    if (eta) meta.push('compie ' + eta);
    if (ev.nota) meta.push(esc(ev.nota));

    var extra = '';
    if (ev.sveglie && ev.sveglie.length) {
      extra += '<span class="ev-bell"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true">' +
        '<path d="M12 3.5a6 6 0 0 0-6 6v4l-1.6 3h15.2L18 13.5v-4a6 6 0 0 0-6-6Z" fill="none" stroke-width="2"/></svg>' +
        ev.sveglie.length + '</span>';
    }
    if (ev.ripeti && ev.ripeti !== 'nessuna') {
      extra += '<span class="ev-rep"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true">' +
        '<path d="M4 9a6 6 0 0 1 10-2.5L17 9M20 15a6 6 0 0 1-10 2.5L7 15" fill="none" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M17 5v4h-4M7 19v-4h4" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    }

    var dx = mostraData
      ? '<span class="ev-when">' + esc(fromISO(o.data).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })) +
        '<span class="giorni">' + esc(traQuanto(o.data, ev.ora)) + '</span></span>'
      : '<span class="ev-when">' + esc(ev.ora || '—') + '</span>';

    return '<button type="button" class="ev-row ' + t.classe + (passato ? ' is-past' : '') +
      '" data-id="' + esc(ev.id) + '" data-occ="' + esc(o.data) + '">' +
      '<span class="ev-ico"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true">' + t.icona + '</svg></span>' +
      '<span class="ev-main"><span class="ev-name">' + esc(ev.titolo) + '</span>' +
      '<span class="ev-meta">' + meta.join(' <span class="sep">·</span> ') + extra + '</span></span>' +
      dx + '</button>';
  }

  function collegaRighe(host) {
    Array.prototype.forEach.call(host.querySelectorAll('.ev-row'), function (r) {
      r.addEventListener('click', function () { apriSheet(r.getAttribute('data-id')); });
    });
  }

  /* ─────────────────────────── agenda ─────────────────────────── */
  function renderAgenda() {
    var f = state.filtri, q = f.q.trim().toLowerCase();
    var da = oggiISO(), a = addDays(da, +f.range);
    var lista = espandi(da, a, function (ev) {
      if (f.tipo !== 'all' && ev.tipo !== f.tipo) return false;
      if (q && (ev.titolo + ' ' + (ev.nota || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    var conta = {};
    lista.forEach(function (o) { conta[o.ev.tipo] = (conta[o.ev.tipo] || 0) + 1; });
    el('agendaSummary').innerHTML =
      '<span>' + lista.length + (lista.length === 1 ? ' evento' : ' eventi') + '</span>' +
      Object.keys(TIPI).map(function (t) {
        return conta[t] ? '<span>' + TIPI[t].nome + ' <b>' + conta[t] + '</b></span>' : '';
      }).join('');

    var host = el('agendaList');
    if (!lista.length) {
      host.innerHTML = '<div class="empty"><strong>Nessun evento in arrivo</strong>' +
        '<span>Allarga il periodo qui sopra, oppure aggiungine uno.</span></div>';
      return;
    }

    var html = '', ultimo = null;
    lista.forEach(function (o) {
      if (o.data !== ultimo) {
        ultimo = o.data;
        var nome = nomeGiorno(o.data), quanto = traQuanto(o.data, o.ev.ora);
        // "Domani — domani" non aggiunge nulla: la seconda colonna sparisce
        var coda = (nome.toLowerCase() === quanto.toLowerCase()) ? '' : esc(quanto);
        html += '<div class="ev-day-head"><span>' + esc(nome) + '</span>' +
          '<span class="quando">' + coda + '</span></div>';
      }
      html += rigaEvento(o, false);
    });
    host.innerHTML = html;
    collegaRighe(host);
  }

  /* ─────────────────────────── file .ics ─────────────────────────── */
  function icsEsc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  // Le righe oltre 75 ottetti vanno spezzate, come richiede lo standard.
  function piega(riga) {
    if (riga.length <= 73) return riga;
    var out = riga.slice(0, 73), resto = riga.slice(73);
    while (resto.length > 72) { out += '\r\n ' + resto.slice(0, 72); resto = resto.slice(72); }
    return out + '\r\n ' + resto;
  }

  function stampaUTC(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }
  function stampaLocale(iso, ora) {
    var m = minutiDi(ora);
    return iso.replace(/-/g, '') + 'T' + pad2(Math.floor(m / 60)) + pad2(m % 60) + '00';
  }

  function vevent(ev) {
    var L = [];
    L.push('BEGIN:VEVENT');
    L.push('UID:' + ev.id + '@hub.local');
    L.push('DTSTAMP:' + stampaUTC(new Date()));

    if (ev.ora) {
      // orario "fluttuante": il telefono lo interpreta nel proprio fuso, che è quello giusto
      L.push('DTSTART:' + stampaLocale(ev.data, ev.ora));
      var fine = minutiDi(ev.ora) + (ev.durata || 0);
      if (ev.durata > 0) {
        var gg = Math.floor(fine / 1440), rest = fine % 1440;
        var dFine = addDays(ev.data, gg);
        L.push('DTEND:' + stampaLocale(dFine, pad2(Math.floor(rest / 60)) + ':' + pad2(rest % 60)));
      }
    } else {
      L.push('DTSTART;VALUE=DATE:' + ev.data.replace(/-/g, ''));
      L.push('DTEND;VALUE=DATE:' + addDays(ev.data, 1).replace(/-/g, ''));
    }

    if (ev.ripeti && RRULE[ev.ripeti]) L.push('RRULE:' + RRULE[ev.ripeti]);
    L.push('SUMMARY:' + icsEsc(ev.titolo));
    if (ev.nota) L.push('DESCRIPTION:' + icsEsc(ev.nota));
    L.push('CATEGORIES:' + icsEsc(TIPI[ev.tipo].nome));
    if (!ev.ora) L.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE');

    (ev.sveglie || []).forEach(function (min) {
      L.push('BEGIN:VALARM');
      L.push('ACTION:DISPLAY');
      L.push('DESCRIPTION:' + icsEsc(ev.titolo));
      if (ev.ora) {
        L.push(min === 0 ? 'TRIGGER:PT0S' : 'TRIGGER:-PT' + min + 'M');
      } else {
        // evento senza orario: la sveglia si calcola dall'ora predefinita
        var off = minutiDi(data.pref.defTime) - min;
        L.push(off === 0 ? 'TRIGGER:PT0S' : (off > 0 ? 'TRIGGER:PT' + off + 'M' : 'TRIGGER:-PT' + (-off) + 'M'));
      }
      L.push('END:VALARM');
    });

    L.push('END:VEVENT');
    return L;
  }

  function costruisciIcs(eventi) {
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hub//Calendario//IT',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    eventi.forEach(function (ev) { L = L.concat(vevent(ev)); });
    L.push('END:VCALENDAR');
    return L.map(piega).join('\r\n') + '\r\n';
  }

  function scarica(nome, testo, mime) {
    var blob = new Blob([testo], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function esportaIcs(eventi, nome) {
    if (!eventi.length) { Hub.toast('Nessun evento da esportare.'); return; }
    scarica(nome, costruisciIcs(eventi), 'text/calendar;charset=utf-8');
    Hub.toast(eventi.length === 1
      ? 'Aprilo per aggiungerlo al calendario del telefono'
      : eventi.length + ' eventi esportati — aprili per importarli');
  }

  /* ─────────────────────────── avvisi ─────────────────────────── */
  function statoNotifiche() {
    if (!('Notification' in window)) return 'Questo browser non supporta gli avvisi.';
    if (Notification.permission === 'granted') return 'Avvisi attivi: compariranno mentre l\u2019app è aperta.';
    if (Notification.permission === 'denied') return 'Avvisi bloccati dal browser. Puoi riattivarli dalle impostazioni del sito.';
    return 'Avvisi non ancora attivati.';
  }

  function chiediNotifiche() {
    if (!('Notification' in window)) { Hub.toast('Il browser non supporta gli avvisi.'); return; }
    Notification.requestPermission().then(function (p) {
      if (root) el('notifState').textContent = statoNotifiche();
      Hub.toast(p === 'granted' ? 'Avvisi attivati' : 'Avvisi non attivati');
      if (p === 'granted') programmaTimer();
    });
  }

  function avvisa(titolo, corpo) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(titolo, { body: corpo, icon: 'icons/icon-192.png', tag: titolo + corpo });
        return;
      }
    } catch (e) {}
    Hub.toast(titolo + ' — ' + corpo);
  }

  // Sveglie che scattano entro le prossime 6 ore, mentre l'app resta aperta.
  function programmaTimer() {
    timers.forEach(clearTimeout);
    timers = [];
    var ora = Date.now(), limite = ora + 6 * 3600 * 1000;
    var da = oggiISO(), a = addDays(da, 8);

    espandi(da, a).forEach(function (o) {
      (o.ev.sveglie || []).forEach(function (min) {
        var t = quando(o.data, o.ev.ora).getTime() - min * 60000;
        if (t > ora && t <= limite && timers.length < 40) {
          timers.push(setTimeout(function () {
            avvisa(o.ev.titolo, etichettaSveglia(min) + ' · ' + (o.ev.ora || 'tutto il giorno'));
          }, t - ora));
        }
      });
    });
  }

  function etichettaSveglia(min) {
    for (var i = 0; i < SVEGLIE.length; i++) if (SVEGLIE[i].m === min) return SVEGLIE[i].et;
    return min + ' min prima';
  }

  // Sveglie scattate mentre l'app era chiusa: le mostro in un riquadro.
  function scaduteDaAvvisare() {
    var ora = Date.now();
    var dal = data.ultimoAvviso || (ora - 7 * 86400000);
    if (dal >= ora) return [];
    var out = [];
    espandi(addDays(oggiISO(), -14), addDays(oggiISO(), 2)).forEach(function (o) {
      (o.ev.sveglie || []).forEach(function (min) {
        var t = quando(o.data, o.ev.ora).getTime() - min * 60000;
        if (t > dal && t <= ora) out.push({ o: o, min: min, t: t });
      });
    });
    out.sort(function (a, b) { return b.t - a.t; });
    return out.slice(0, 6);
  }

  function renderScadute() {
    var box = root.querySelector('.missed');
    if (box) box.remove();
    var lista = scaduteDaAvvisare();
    data.ultimoAvviso = Date.now();
    save();
    if (!lista.length) return;

    var div = document.createElement('div');
    div.className = 'missed';
    div.innerHTML = '<div class="missed-head">' +
      '<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><path d="M12 3.5a6 6 0 0 0-6 6v4l-1.6 3h15.2L18 13.5v-4a6 6 0 0 0-6-6Z" fill="none" stroke-width="2" stroke-linejoin="round"/><path d="M10 19.5a2 2 0 0 0 4 0" fill="none" stroke-width="2"/></svg>' +
      'Promemoria scaduti mentre l\u2019app era chiusa</div><ul>' +
      lista.map(function (x) {
        return '<li><strong>' + esc(x.o.ev.titolo) + '</strong> — ' +
          esc(nomeGiorno(x.o.data).toLowerCase()) + ', ' + esc(etichettaSveglia(x.min)) + '</li>';
      }).join('') + '</ul>';
    root.insertBefore(div, root.querySelector('.segtabs').nextSibling);
  }

  /* ─────────────────────────── modulo evento ─────────────────────────── */
  function setTipo(t) {
    state.tipo = t;
    Array.prototype.forEach.call(document.querySelectorAll('#evSheet .seg'), function (s) {
      var on = s.getAttribute('data-tipo') === t;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function renderSveglie() {
    doc('#evAlarms').innerHTML = SVEGLIE.map(function (s) {
      var on = state.sveglie.indexOf(s.m) > -1;
      return '<button type="button" class="alarm-chip' + (on ? ' is-on' : '') +
        '" data-m="' + s.m + '" aria-pressed="' + on + '">' + esc(s.et) + '</button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#evAlarms .alarm-chip'), function (b) {
      b.addEventListener('click', function () {
        var m = +b.getAttribute('data-m'), i = state.sveglie.indexOf(m);
        if (i > -1) state.sveglie.splice(i, 1); else state.sveglie.push(m);
        state.sveglie.sort(function (x, y) { return x - y; });
        renderSveglie();
      });
    });
  }

  function aggiornaOrario() {
    var tutto = doc('#evAllDay').checked;
    doc('#evTimeRow').hidden = tutto;
  }

  function apriSheet(id, dataIso) {
    var sheet = doc('#evSheet');
    doc('#evError').hidden = true;
    state.editing = id || null;

    if (id) {
      var ev = data.eventi.filter(function (x) { return x.id === id; })[0];
      if (!ev) return;
      doc('#evTitle').textContent = 'Modifica evento';
      setTipo(ev.tipo);
      doc('#evName').value = ev.titolo;
      doc('#evDate').value = ev.data;
      doc('#evRepeat').value = ev.ripeti || 'nessuna';
      doc('#evAllDay').checked = !ev.ora;
      doc('#evTime').value = ev.ora || data.pref.defTime;
      doc('#evDur').value = String(ev.durata || 0);
      doc('#evNote').value = ev.nota || '';
      state.sveglie = (ev.sveglie || []).slice();
      doc('#evDelete').hidden = false;
      doc('#evIcs').hidden = false;
    } else {
      doc('#evTitle').textContent = 'Nuovo evento';
      setTipo('appuntamento');
      doc('#evName').value = '';
      doc('#evDate').value = dataIso || state.sel || oggiISO();
      doc('#evRepeat').value = 'nessuna';
      doc('#evAllDay').checked = false;
      doc('#evTime').value = data.pref.defTime;
      doc('#evDur').value = '60';
      doc('#evNote').value = '';
      state.sveglie = [60];                       // un promemoria un'ora prima, di partenza
      doc('#evDelete').hidden = true;
      doc('#evIcs').hidden = true;
    }
    aggiornaOrario();
    renderSveglie();

    if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
    setTimeout(function () { doc('#evName').focus(); }, 60);
  }

  function chiudiSheet() {
    var s = doc('#evSheet');
    if (typeof s.close === 'function') s.close(); else s.removeAttribute('open');
  }

  function leggiModulo() {
    var tutto = doc('#evAllDay').checked;
    return {
      tipo: state.tipo,
      titolo: doc('#evName').value.trim().slice(0, 70),
      data: doc('#evDate').value,
      ora: tutto ? null : doc('#evTime').value,
      durata: tutto ? 0 : (+doc('#evDur').value || 0),
      ripeti: doc('#evRepeat').value,
      sveglie: state.sveglie.slice(),
      nota: doc('#evNote').value.trim().slice(0, 120)
    };
  }

  function salva(ev2) {
    ev2.preventDefault();
    var p = leggiModulo(), err = doc('#evError');

    if (!p.titolo) { err.textContent = 'Dai un titolo all\u2019evento.'; err.hidden = false; doc('#evName').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.data)) { err.textContent = 'Scegli una data valida.'; err.hidden = false; return; }
    if (!p.ora && !doc('#evAllDay').checked) { err.textContent = 'Scegli un orario.'; err.hidden = false; return; }
    err.hidden = true;

    if (state.editing) {
      var ev = data.eventi.filter(function (x) { return x.id === state.editing; })[0];
      if (ev) { Object.keys(p).forEach(function (k) { ev[k] = p[k]; }); }
      if (save()) Hub.toast('Evento aggiornato');
    } else {
      p.id = uid(); p.creato = Date.now();
      data.eventi.push(p);
      if (save()) Hub.toast('Evento salvato');
    }

    // Per un evento ricorrente la data base può essere lontana nel passato
    // (il 1995 di un compleanno): porto la vista sulla prossima ricorrenza.
    var prossima = occorrenze(p, oggiISO(), addDays(oggiISO(), 366))[0] || p.data;
    state.sel = prossima;
    state.mese = prossima.slice(0, 7);
    chiudiSheet();
    programmaTimer();
    sincronizza(false);
    renderAttuale();
    Hub.refreshHome();
  }

  function elimina() {
    if (!state.editing) return;
    if (!confirm('Eliminare definitivamente questo evento?')) return;
    data.eventi = data.eventi.filter(function (e) { return e.id !== state.editing; });
    save(); chiudiSheet(); programmaTimer(); sincronizza(false); renderAttuale(); Hub.refreshHome();
    Hub.toast('Evento eliminato');
  }

  function icsSingolo() {
    var ev = data.eventi.filter(function (x) { return x.id === state.editing; })[0];
    if (!ev) return;
    var nome = (ev.titolo.replace(/[^\w\sàèéìòù-]/gi, '').trim().replace(/\s+/g, '-').toLowerCase() || 'evento');
    esportaIcs([ev], nome + '.ics');
  }

  /* ─────────────────────────── backup ─────────────────────────── */
  function esporta() {
    scarica('calendario-backup-' + oggiISO() + '.json', JSON.stringify({
      app: 'calendario', versione: 1, esportato: new Date().toISOString(),
      pref: data.pref, eventi: data.eventi
    }, null, 2), 'application/json;charset=utf-8');
    Hub.toast('Backup esportato');
  }

  function importa(file) {
    var r = new FileReader();
    r.onload = function () {
      var p;
      try { p = JSON.parse(String(r.result)); }
      catch (e) { Hub.toast('File non leggibile.'); return; }
      if (!p || !Array.isArray(p.eventi)) { Hub.toast('File non valido: manca l\u2019elenco eventi.'); return; }

      var buoni = p.eventi.filter(valido);
      if (!buoni.length) { Hub.toast('Nessun evento valido nel backup.'); return; }

      var modo = data.eventi.length === 0 ? 'sost' : null;
      if (!modo) {
        modo = confirm('Trovati ' + buoni.length + ' eventi nel backup.\n\n' +
          'OK = UNISCI ai ' + data.eventi.length + ' già presenti\n' +
          'Annulla = SOSTITUISCI tutto con il backup') ? 'unisci' : 'sost';
      }
      if (modo === 'sost') data.eventi = [];

      var noti = {};
      data.eventi.forEach(function (e) { noti[e.id] = 1; });
      var agg = 0;
      buoni.forEach(function (e) {
        if (noti[e.id]) return;
        noti[e.id] = 1;
        data.eventi.push({
          id: e.id, tipo: e.tipo, titolo: String(e.titolo).slice(0, 70), data: e.data,
          ora: /^\d{2}:\d{2}$/.test(e.ora || '') ? e.ora : null,
          durata: +e.durata || 0, ripeti: RIPETI[e.ripeti] !== undefined ? e.ripeti : 'nessuna',
          sveglie: Array.isArray(e.sveglie) ? e.sveglie.filter(function (m) { return typeof m === 'number'; }) : [],
          nota: String(e.nota || '').slice(0, 120), creato: +e.creato || Date.now()
        });
        agg++;
      });
      if (p.pref && /^\d{2}:\d{2}$/.test(p.pref.defTime)) data.pref.defTime = p.pref.defTime;

      save(); programmaTimer(); sincronizza(false); renderAttuale(); Hub.refreshHome();
      Hub.toast(agg + (agg === 1 ? ' evento importato' : ' eventi importati'));
    };
    r.onerror = function () { Hub.toast('Non riesco a leggere il file.'); };
    r.readAsText(file);
  }

  function svuota() {
    if (!confirm('Cancellare TUTTI gli eventi?\n\nL\u2019operazione non è reversibile. Se non hai un backup, annulla ed esportalo prima.')) return;
    if (!confirm('Confermi definitivamente?')) return;
    data.eventi = [];
    save(); programmaTimer(); sincronizza(false); renderAttuale(); Hub.refreshHome();
    Hub.toast('Tutti gli eventi sono stati cancellati');
  }

  function renderOpzioni() {
    el('pushState').textContent = statoPush();
    el('notifState').textContent = statoNotifiche();
    el('defTime').value = data.pref.defTime;
    var bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length; } catch (e) {}
    el('storageInfo').textContent = data.eventi.length + (data.eventi.length === 1 ? ' evento salvato · ' : ' eventi salvati · ') +
      (bytes < 1024 ? bytes + ' byte' : Math.round(bytes / 1024) + ' KB') + ' su questo dispositivo.';
  }


  /* ─────────────────────── notifiche push (server) ───────────────────────

     Il server riceve solo una lista di istanti. Il testo dell'avviso viene
     scritto in IndexedDB, che il service worker sa leggere quando arriva la
     notifica: così il contenuto non esce mai dal dispositivo.
     ───────────────────────────────────────────────────────────────────── */

  var DB_NOME = 'hub-cal', DB_STORE = 'avvisi';

  function apriDb() {
    return new Promise(function (ok, no) {
      var req = indexedDB.open(DB_NOME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'k' });
      };
      req.onsuccess = function () { ok(req.result); };
      req.onerror = function () { no(req.error); };
    });
  }

  // Tutte le sveglie dei prossimi 60 giorni, come voci indipendenti.
  function avvisiFuturi() {
    var adesso = Date.now(), out = [];
    espandi(oggiISO(), addDays(oggiISO(), 60)).forEach(function (o) {
      (o.ev.sveglie || []).forEach(function (min) {
        var t = quando(o.data, o.ev.ora).getTime() - min * 60000;
        if (t > adesso) {
          out.push({
            k: o.ev.id + '|' + o.data + '|' + min,
            at: t,
            titolo: o.ev.titolo,
            corpo: etichettaSveglia(min) + ' \u00b7 ' + (o.ev.ora ? o.ev.ora : 'tutto il giorno')
          });
        }
      });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(0, 400);
  }

  function scriviSpecchio(lista) {
    return apriDb().then(function (db) {
      return new Promise(function (ok) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        var st = tx.objectStore(DB_STORE);
        st.clear();
        lista.forEach(function (a) { st.put(a); });
        tx.oncomplete = function () { ok(); };
        tx.onerror = function () { ok(); };
      });
    }).catch(function () {});
  }

  function deviceId() {
    var v = null;
    try { v = localStorage.getItem(DEV_KEY); } catch (e) {}
    if (!v) {
      var b = new Uint8Array(16);
      if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
      else for (var i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
      v = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(DEV_KEY, v); } catch (e) {}
    }
    return v;
  }

  function pushAttivo() {
    try { return localStorage.getItem(PUSH_KEY) === '1'; } catch (e) { return false; }
  }

  function b64ToUint8(b64) {
    var s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Manda al server solo gli orari. Nessun titolo, nessuna nota.
  function sincronizza(forzaRegistrazione) {
    if (!pushAttivo() && !forzaRegistrazione) return Promise.resolve(false);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.resolve(false);

    var lista = avvisiFuturi();
    var orari = lista.map(function (a) { return a.at; });

    return scriviSpecchio(lista).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        if (!forzaRegistrazione) return null;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToUint8(PUSH_PUBKEY)
        });
      });
    }).then(function (sub) {
      if (!sub) return false;
      var corpo = { deviceId: deviceId(), reminders: orari };
      var percorso = '/sync';
      if (forzaRegistrazione) { corpo.subscription = { endpoint: sub.endpoint }; percorso = '/register'; }

      return fetch(PUSH_URL + percorso, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo)
      }).then(function (r) {
        if (!r.ok && percorso === '/sync') {
          // il server non ci conosce piu': rifacciamo la registrazione
          return fetch(PUSH_URL + '/register', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: deviceId(), subscription: { endpoint: sub.endpoint }, reminders: orari })
          }).then(function (r2) { return r2.ok; });
        }
        return r.ok;
      });
    }).catch(function () { return false; });
  }

  function attivaPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      Hub.toast('Questo browser non supporta le notifiche push.'); return;
    }
    if (!window.isSecureContext) {
      Hub.toast('Servono il sito online (https) e l\u2019app installata.'); return;
    }
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') { Hub.toast('Permesso negato: senza non posso avvisarti.'); return; }
      Hub.toast('Attivazione in corso\u2026');
      return sincronizza(true).then(function (ok) {
        try { localStorage.setItem(PUSH_KEY, ok ? '1' : '0'); } catch (e) {}
        Hub.toast(ok ? 'Notifiche attive su questo dispositivo' : 'Attivazione non riuscita: riprova');
        if (root && state.view === 'opzioni') renderOpzioni();
      });
    });
  }

  function disattivaPush() {
    try { localStorage.setItem(PUSH_KEY, '0'); } catch (e) {}
    fetch(PUSH_URL + '/unregister', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId() })
    }).catch(function () {});
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription();
      }).then(function (s) { if (s) s.unsubscribe(); }).catch(function () {});
    }
    Hub.toast('Notifiche disattivate');
    if (root && state.view === 'opzioni') renderOpzioni();
  }

  function provaPush() {
    Hub.toast('Invio di prova\u2026');
    fetch(PUSH_URL + '/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId() })
    }).then(function (r) { return r.json(); })
      .then(function (j) { Hub.toast(j.ok ? 'Inviata: dovrebbe arrivare tra pochi secondi' : 'Non riuscita (' + (j.errore || j.statoPush) + ')'); })
      .catch(function () { Hub.toast('Server non raggiungibile.'); });
  }

  function statoPush() {
    if (!('PushManager' in window)) return 'Questo browser non supporta le notifiche push.';
    if (!window.isSecureContext) return 'Disponibili solo sul sito online, non aprendo il file in locale.';
    if (Notification.permission === 'denied') return 'Notifiche bloccate dal browser: riattivale dalle impostazioni del sito.';
    if (pushAttivo()) return 'Attive su questo dispositivo: arrivano anche ad app chiusa.';
    return 'Non ancora attive su questo dispositivo.';
  }

  /* ─────────────────────────── viste ─────────────────────────── */
  function setView(n) {
    state.view = n;
    all('.segtab').forEach(function (t) {
      var on = t.getAttribute('data-view') === n;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    all('[data-view-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-view-panel') !== n; });
    var fab = root.querySelector('.fab');
    if (fab) fab.hidden = (n === 'opzioni');
    renderAttuale();
    var b = document.getElementById('svcBody');
    if (b) b.scrollTop = 0;
  }

  function renderAttuale() {
    if (state.view === 'mese') renderMese();
    else if (state.view === 'agenda') renderAgenda();
    else renderOpzioni();
  }

  /* ─────────────────────────── montaggio ─────────────────────────── */
  function mount(host) {
    load();
    root = document.getElementById('tpl-calendario').content.cloneNode(true).firstElementChild;
    host.appendChild(root);

    state.sel = oggiISO();
    state.mese = meseCorrente();
    state.view = 'mese';

    all('.segtab').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    });

    root.querySelector('[data-act="prevMonth"]').addEventListener('click', function () {
      state.mese = spostaMese(state.mese, -1); renderMese();
    });
    root.querySelector('[data-act="nextMonth"]').addEventListener('click', function () {
      state.mese = spostaMese(state.mese, 1); renderMese();
    });
    root.querySelector('[data-act="today"]').addEventListener('click', function () {
      state.sel = oggiISO(); state.mese = meseCorrente(); renderMese();
    });
    root.querySelector('[data-act="add"]').addEventListener('click', function () { apriSheet(null); });
    root.querySelector('[data-act="addOnDay"]').addEventListener('click', function () { apriSheet(null, state.sel); });

    el('fRange').addEventListener('change', function () { state.filtri.range = this.value; renderAgenda(); });
    el('fType').addEventListener('change', function () { state.filtri.tipo = this.value; renderAgenda(); });
    el('fSearch').addEventListener('input', function () { state.filtri.q = this.value; renderAgenda(); });

    root.querySelector('[data-act="icsAll"]').addEventListener('click', function () {
      esportaIcs(data.eventi, 'calendario-' + oggiISO() + '.ics');
    });
    root.querySelector('[data-act="askNotif"]').addEventListener('click', chiediNotifiche);
    root.querySelector('[data-act="pushOn"]').addEventListener('click', attivaPush);
    root.querySelector('[data-act="pushOff"]').addEventListener('click', disattivaPush);
    root.querySelector('[data-act="pushTest"]').addEventListener('click', provaPush);
    root.querySelector('[data-act="export"]').addEventListener('click', esporta);
    root.querySelector('[data-act="import"]').addEventListener('click', function () { el('importFile').click(); });
    el('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importa(this.files[0]);
      this.value = '';
    });
    root.querySelector('[data-act="wipe"]').addEventListener('click', svuota);
    el('defTime').addEventListener('change', function () {
      if (/^\d{2}:\d{2}$/.test(this.value)) { data.pref.defTime = this.value; save(); programmaTimer(); }
    });

    // modulo evento (vive nel body)
    on(doc('#evForm'), 'submit', salva);
    on(doc('#evClose'), 'click', chiudiSheet);
    on(doc('#evCancel'), 'click', chiudiSheet);
    on(doc('#evDelete'), 'click', elimina);
    on(doc('#evIcs'), 'click', icsSingolo);
    on(doc('#evAllDay'), 'change', aggiornaOrario);
    on(doc('#evSheet'), 'click', function (e) { if (e.target === this) chiudiSheet(); });
    Array.prototype.forEach.call(document.querySelectorAll('#evSheet .seg'), function (s) {
      on(s, 'click', function () { setTipo(s.getAttribute('data-tipo')); });
    });

    setView('mese');
    renderScadute();
    programmaTimer();
    sincronizza(false);
  }

  function unmount() {
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners = [];
    timers.forEach(clearTimeout);
    timers = [];
    chiudiSheet();
    root = null;
  }

  function stat() {
    load();
    var pros = espandi(oggiISO(), addDays(oggiISO(), 365));
    var adesso = new Date();
    for (var i = 0; i < pros.length; i++) {
      if (quando(pros[i].data, pros[i].ev.ora) >= adesso || pros[i].data > oggiISO()) {
        var o = pros[i];
        return { text: o.ev.titolo.slice(0, 18) + ' · ' + traQuanto(o.data, o.ev.ora), tone: '' };
      }
    }
    return { text: 'Nessun evento', tone: '' };
  }

  Hub.register({
    id: 'calendario', nome: 'Calendario',
    mount: mount, unmount: unmount, stat: stat
  });
})();
