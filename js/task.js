/* =========================================================================
   Servizio "Task" — cose da fare, con importanza e impegno.

   DUE DIMENSIONI SU DUE CANALI: l'importanza e' il colore (scala che cresce
   in luminosita'), l'impegno sono tre barrette senza colore. Metterle
   entrambe sul colore avrebbe reso l'elenco illeggibile, e il semaforo
   rosso/giallo/verde e' stato scartato perche' sotto daltonismo verde e
   giallo coincidono.

   Dati in localStorage come copia di lavoro, Firestore come verita' quando
   l'accesso e' attivo.
   ========================================================================= */
(function () {
  'use strict';

  var KEY = 'task.v1';

  var IMPORTANZA = [
    { v: 1, et: 'Bassa' },
    { v: 2, et: 'Media' },
    { v: 3, et: 'Alta' }
  ];
  var IMPEGNO = [
    { v: 1, et: 'Leggero' },
    { v: 2, et: 'Medio' },
    { v: 3, et: 'Pesante' }
  ];

  var data = { task: [] };
  var root = null, listeners = [], disiscrivi = [];

  /* ─────────────────────────── archivio ─────────────────────────── */
  function valida(t) {
    return !!t && typeof t.id === 'string' && typeof t.titolo === 'string' && t.titolo.length > 0 &&
      [1, 2, 3].indexOf(+t.importanza) > -1 && [1, 2, 3].indexOf(+t.impegno) > -1;
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    var p = null;
    if (raw) { try { p = JSON.parse(raw); } catch (e) {} }
    data.task = (p && Array.isArray(p.task)) ? p.task.filter(valida) : [];
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch (e) { Hub.toast('Spazio esaurito: non riesco a salvare.'); return false; }
  }

  /* ─────────────────────────── utilità ─────────────────────────── */
  function esc(s) { return Hub.esc(s); }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function oggiISO() { return toISO(new Date()); }
  function fromISO(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

  function el(n) { return root.querySelector('[data-el="' + n + '"]'); }
  function all(s) { return Array.prototype.slice.call(root.querySelectorAll(s)); }
  function doc(s) { return document.querySelector(s); }
  function on(t, ty, fn, o) { t.addEventListener(ty, fn, o); listeners.push([t, ty, fn, o]); }

  function etichettaScadenza(iso) {
    if (!iso) return null;
    var oggi = oggiISO();
    if (iso === oggi) return { testo: 'scade oggi', urgente: true };
    if (iso < oggi) {
      var gg = Math.round((fromISO(oggi) - fromISO(iso)) / 86400000);
      return { testo: 'scaduta da ' + gg + (gg === 1 ? ' giorno' : ' giorni'), urgente: true };
    }
    var d = Math.round((fromISO(iso) - fromISO(oggi)) / 86400000);
    if (d === 1) return { testo: 'scade domani', urgente: true };
    if (d < 7) return { testo: 'tra ' + d + ' giorni', urgente: false };
    return { testo: fromISO(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }), urgente: false };
  }

  /* ─────────────────────────── stato ─────────────────────────── */
  var state = {
    view: 'dafare', editing: null,
    importanza: 2, impegno: 2,
    filtri: { ordine: 'priorita', importanza: 0, cerca: '' }
  };

  /* ─────────────────────────── ordinamento ─────────────────────────── */
  // "Priorita'" mette in cima le cose importanti che costano poco: sono
  // quelle che conviene togliere di mezzo per prime.
  function confronta(ordine) {
    return function (a, b) {
      if (ordine === 'importanza') return b.importanza - a.importanza || a.impegno - b.impegno;
      if (ordine === 'impegno') return a.impegno - b.impegno || b.importanza - a.importanza;
      if (ordine === 'recenti') return (b.creato || 0) - (a.creato || 0);
      if (ordine === 'scadenza') {
        var sa = a.scadenza || '9999', sb = b.scadenza || '9999';
        if (sa !== sb) return sa < sb ? -1 : 1;
        return b.importanza - a.importanza;
      }
      var pa = a.importanza * 3 - a.impegno, pb = b.importanza * 3 - b.impegno;
      if (pa !== pb) return pb - pa;
      var xa = a.scadenza || '9999', xb = b.scadenza || '9999';
      return xa < xb ? -1 : xa > xb ? 1 : 0;
    };
  }

  function aperte() { return data.task.filter(function (t) { return !t.fatta; }); }
  function fatte() { return data.task.filter(function (t) { return t.fatta; }); }

  /* ─────────────────────────── disegno ─────────────────────────── */
  function barretteImpegno(n) {
    var out = '<span class="impegno" aria-hidden="true">';
    for (var i = 1; i <= 3; i++) out += '<i class="' + (i <= n ? 'on' : '') + '"></i>';
    return out + '</span>';
  }

  function rigaTask(t) {
    var sc = etichettaScadenza(t.scadenza);
    var meta = [];
    meta.push('<span class="task-imp">' + esc(IMPORTANZA[t.importanza - 1].et) + '</span>');
    meta.push(barretteImpegno(t.impegno) + ' ' + esc(IMPEGNO[t.impegno - 1].et));
    if (sc) meta.push('<span class="' + (sc.urgente && !t.fatta ? 'task-scaduta' : '') + '">' + esc(sc.testo) + '</span>');
    if (t.nota) meta.push(esc(t.nota));

    return '<div class="task-row i' + t.importanza + (t.fatta ? ' is-fatta' : '') + '" data-id="' + esc(t.id) + '">' +
      '<button type="button" class="task-spunta" data-act="spunta" ' +
        'aria-label="' + (t.fatta ? 'Segna come da fare' : 'Segna come fatta') + '" aria-pressed="' + (t.fatta ? 'true' : 'false') + '">' +
        '<svg viewBox="0 0 24 24" class="ico"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '<span class="task-barra" aria-hidden="true"></span>' +
      '<span class="task-corpo" data-act="apri" role="button" tabindex="0">' +
        '<span class="task-titolo">' + esc(t.titolo) + '</span>' +
        '<span class="task-meta">' + meta.join(' <span class="sep">·</span> ') + '</span>' +
      '</span>' +
      '<span class="task-azione">' +
        '<button type="button" class="task-modifica" data-act="apri" aria-label="Modifica">' +
          '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke-width="1.9" stroke-linejoin="round"/></svg>' +
        '</button>' +
      '</span>' +
    '</div>';
  }

  function collegaRighe(host) {
    Array.prototype.forEach.call(host.querySelectorAll('.task-row'), function (r) {
      var id = r.getAttribute('data-id');
      Array.prototype.forEach.call(r.querySelectorAll('[data-act="apri"]'), function (b) {
        b.addEventListener('click', function () { apriSheet(id); });
      });
      var sp = r.querySelector('[data-act="spunta"]');
      if (sp) sp.addEventListener('click', function (ev) { ev.stopPropagation(); commuta(id); });
    });
  }

  function renderSommario() {
    var a = aperte();
    el('sommario').innerHTML = IMPORTANZA.slice().reverse().map(function (i) {
      var n = a.filter(function (t) { return t.importanza === i.v; }).length;
      return '<div class="somma i' + i.v + '">' +
        '<div class="somma-n">' + n + '</div>' +
        '<div class="somma-et">' + esc(i.et) + '</div></div>';
    }).join('');
  }

  function renderAperte() {
    renderSommario();
    var f = state.filtri, q = f.cerca.trim().toLowerCase();
    var lista = aperte().filter(function (t) {
      if (f.importanza && t.importanza < f.importanza) return false;
      if (q && (t.titolo + ' ' + (t.nota || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(confronta(f.ordine));

    var host = el('elencoAperte');
    if (!lista.length) {
      host.innerHTML = '<div class="task-vuoto"><strong>' +
        (aperte().length ? 'Nessuna task con questi filtri' : 'Niente da fare') + '</strong><span>' +
        (aperte().length ? 'Allarga i filtri qui sopra.' : 'Tocca Aggiungi per crearne una.') + '</span></div>';
      return;
    }
    host.innerHTML = lista.map(rigaTask).join('');
    collegaRighe(host);
  }

  function renderFatte() {
    var lista = fatte().sort(function (a, b) { return (b.completato || 0) - (a.completato || 0); });
    var host = el('elencoFatte');
    if (!lista.length) {
      host.innerHTML = '<div class="task-vuoto"><strong>Ancora niente</strong><span>Le task completate finiscono qui.</span></div>';
      return;
    }
    host.innerHTML = lista.map(rigaTask).join('');
    collegaRighe(host);
  }

  function renderOpzioni() {
    el('nuvolaStato').textContent = statoNuvola();
    var collegata = nuvolaCollegata();
    root.querySelector('[data-act="nuvolaEntra"]').hidden = collegata;
    root.querySelector('[data-act="nuvolaEsci"]').hidden = !collegata;

    var bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length; } catch (e) {}
    el('storageInfo').textContent = data.task.length + (data.task.length === 1 ? ' task salvata · ' : ' task salvate · ') +
      (bytes < 1024 ? bytes + ' byte' : Math.round(bytes / 1024) + ' KB') + ' su questo dispositivo.';
  }

  /* ─────────────────────────── azioni ─────────────────────────── */
  function trova(id) { return data.task.filter(function (t) { return t.id === id; })[0]; }

  function commuta(id) {
    var t = trova(id);
    if (!t) return;
    t.fatta = !t.fatta;
    t.completato = t.fatta ? Date.now() : 0;
    save();
    nuvolaScrivi(t);
    renderAttuale();
    if (Hub.refreshHome) Hub.refreshHome();
    Hub.toast(t.fatta ? 'Fatta' : 'Rimessa fra le cose da fare');
  }

  function scalaHtml(contenitore, valori, scelto, conBarrette) {
    return valori.map(function (v, i) {
      var attiva = (v.v === scelto);
      var dentro = conBarrette ? barretteImpegno(v.v) : '<span class="pallino"></span>';
      return '<button type="button" class="scala-b i' + (conBarrette ? 2 : v.v) + (attiva ? ' is-on' : '') +
        '" data-v="' + v.v + '" aria-pressed="' + attiva + '">' + dentro +
        '<span>' + esc(v.et) + '</span></button>';
    }).join('');
  }

  function renderScale() {
    doc('#tkImportanza').innerHTML = scalaHtml(null, IMPORTANZA, state.importanza, false);
    doc('#tkImpegno').innerHTML = scalaHtml(null, IMPEGNO, state.impegno, true);

    Array.prototype.forEach.call(document.querySelectorAll('#tkImportanza .scala-b'), function (b) {
      b.addEventListener('click', function () { state.importanza = +b.getAttribute('data-v'); renderScale(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tkImpegno .scala-b'), function (b) {
      b.addEventListener('click', function () { state.impegno = +b.getAttribute('data-v'); renderScale(); });
    });
  }

  function apriSheet(id) {
    var sheet = doc('#tkSheet');
    doc('#tkErrore').hidden = true;
    state.editing = id || null;

    if (id) {
      var t = trova(id);
      if (!t) return;
      doc('#tkTitolo').textContent = 'Modifica task';
      doc('#tkNome').value = t.titolo;
      doc('#tkScadenza').value = t.scadenza || '';
      doc('#tkNota').value = t.nota || '';
      state.importanza = t.importanza;
      state.impegno = t.impegno;
      doc('#tkElimina').hidden = false;
    } else {
      doc('#tkTitolo').textContent = 'Nuova task';
      doc('#tkNome').value = '';
      doc('#tkScadenza').value = '';
      doc('#tkNota').value = '';
      state.importanza = 2;
      state.impegno = 2;
      doc('#tkElimina').hidden = true;
    }
    renderScale();

    if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
    setTimeout(function () { doc('#tkNome').focus(); }, 60);
  }

  function chiudiSheet() {
    var s = doc('#tkSheet');
    if (typeof s.close === 'function') s.close(); else s.removeAttribute('open');
  }

  function salva(ev) {
    ev.preventDefault();
    var titolo = doc('#tkNome').value.trim().slice(0, 90);
    var err = doc('#tkErrore');
    if (!titolo) { err.textContent = 'Scrivi cosa devi fare.'; err.hidden = false; doc('#tkNome').focus(); return; }
    err.hidden = true;

    var p = {
      titolo: titolo,
      importanza: state.importanza,
      impegno: state.impegno,
      scadenza: /^\d{4}-\d{2}-\d{2}$/.test(doc('#tkScadenza').value) ? doc('#tkScadenza').value : null,
      nota: doc('#tkNota').value.trim().slice(0, 140)
    };

    var salvata;
    if (state.editing) {
      salvata = trova(state.editing);
      if (salvata) Object.keys(p).forEach(function (k) { salvata[k] = p[k]; });
      if (save()) Hub.toast('Task aggiornata');
    } else {
      p.id = uid(); p.creato = Date.now(); p.fatta = false; p.completato = 0;
      data.task.push(p);
      salvata = p;
      if (save()) Hub.toast('Task aggiunta');
    }
    if (salvata) nuvolaScrivi(salvata);

    chiudiSheet();
    renderAttuale();
    if (Hub.refreshHome) Hub.refreshHome();
  }

  function elimina() {
    if (!state.editing) return;
    if (!confirm('Eliminare definitivamente questa task?')) return;
    nuvolaElimina(state.editing);
    data.task = data.task.filter(function (t) { return t.id !== state.editing; });
    save(); chiudiSheet(); renderAttuale();
    if (Hub.refreshHome) Hub.refreshHome();
    Hub.toast('Task eliminata');
  }

  function svuotaFatte() {
    var l = fatte();
    if (!l.length) { Hub.toast('Non c’è niente da eliminare.'); return; }
    if (!confirm('Eliminare definitivamente ' + l.length + (l.length === 1 ? ' task completata?' : ' task completate?'))) return;
    l.forEach(function (t) { nuvolaElimina(t.id); });
    data.task = aperte();
    save(); renderAttuale();
    if (Hub.refreshHome) Hub.refreshHome();
    Hub.toast('Archivio svuotato');
  }

  function svuotaTutto() {
    if (!confirm('Cancellare TUTTE le task?\n\nL’operazione non è reversibile.')) return;
    if (!confirm('Confermi definitivamente?')) return;
    var ids = data.task.map(function (t) { return t.id; });
    data.task = [];
    save();
    ids.forEach(nuvolaElimina);
    renderAttuale();
    if (Hub.refreshHome) Hub.refreshHome();
    Hub.toast('Tutte le task sono state cancellate');
  }

  /* ─────────────────────────── backup ─────────────────────────── */
  function scarica(nome, testo) {
    var blob = new Blob([testo], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
  }

  function esporta() {
    scarica('task-backup-' + oggiISO() + '.json', JSON.stringify({
      app: 'task', versione: 1, esportato: new Date().toISOString(), task: data.task
    }, null, 2));
    Hub.toast('Backup esportato');
  }

  function importa(file) {
    var r = new FileReader();
    r.onload = function () {
      var p;
      try { p = JSON.parse(String(r.result)); } catch (e) { Hub.toast('File non leggibile.'); return; }
      if (!p || !Array.isArray(p.task)) { Hub.toast('File non valido.'); return; }
      var buone = p.task.filter(valida);
      if (!buone.length) { Hub.toast('Nessuna task valida nel backup.'); return; }

      var noti = {};
      data.task.forEach(function (t) { noti[t.id] = 1; });
      var agg = 0;
      buone.forEach(function (t) {
        if (noti[t.id]) return;
        noti[t.id] = 1;
        data.task.push({
          id: t.id, titolo: String(t.titolo).slice(0, 90),
          importanza: +t.importanza, impegno: +t.impegno,
          scadenza: /^\d{4}-\d{2}-\d{2}$/.test(t.scadenza || '') ? t.scadenza : null,
          nota: String(t.nota || '').slice(0, 140),
          fatta: !!t.fatta, creato: +t.creato || Date.now(), completato: +t.completato || 0
        });
        agg++;
      });
      save();
      if (nuvolaCollegata()) Nuvola.scriviMolti('task', data.task);
      renderAttuale();
      if (Hub.refreshHome) Hub.refreshHome();
      Hub.toast(agg + (agg === 1 ? ' task importata' : ' task importate'));
    };
    r.onerror = function () { Hub.toast('Non riesco a leggere il file.'); };
    r.readAsText(file);
  }

  /* ─────────────────────── sincronizzazione ─────────────────────── */
  function nuvolaCollegata() { return !!(window.Nuvola && Nuvola.stato() === 'connessa'); }

  function chiaveMigrazione() {
    var u = window.Nuvola && Nuvola.utente();
    return 'hub.taskMigrato.' + (u ? u.uid : 'anonimo');
  }
  function giaMigrato() {
    try { return localStorage.getItem(chiaveMigrazione()) === '1'; } catch (e) { return false; }
  }
  function segnaMigrato() {
    try { localStorage.setItem(chiaveMigrazione(), '1'); } catch (e) {}
  }

  function senzaId(t) {
    var copia = {};
    Object.keys(t).forEach(function (k) { if (k !== 'id') copia[k] = t[k]; });
    return copia;
  }

  function fermaSincronizzazione() {
    disiscrivi.forEach(function (f) { try { f(); } catch (e) {} });
    disiscrivi = [];
  }

  function avviaSincronizzazione() {
    fermaSincronizzazione();
    if (!nuvolaCollegata()) return;

    disiscrivi.push(Nuvola.ascoltaCollezione('task', function (daNuvola) {
      var valide = daNuvola.filter(valida);

      // Prima connessione con dati solo locali: si caricano, non si sostituiscono.
      if (!valide.length && data.task.length && !giaMigrato()) {
        Nuvola.scriviMolti('task', data.task).then(function (n) {
          segnaMigrato();
          if (n) Hub.toast(n + (n === 1 ? ' task messa al sicuro' : ' task messe al sicuro'));
        });
        return;
      }

      segnaMigrato();
      data.task = valide;
      save();
      if (root) renderAttuale();
      if (Hub.refreshHome) Hub.refreshHome();
    }));
  }

  function nuvolaScrivi(t) {
    if (nuvolaCollegata()) Nuvola.scriviDocumento('task', t.id, senzaId(t));
  }
  function nuvolaElimina(id) {
    if (nuvolaCollegata()) Nuvola.eliminaDocumento('task', id);
  }

  function statoNuvola() {
    if (!window.Nuvola) return 'Sincronizzazione non disponibile su questo dispositivo.';
    var st = Nuvola.stato();
    if (st === 'non disponibile') return 'Libreria non caricata: ricarica la pagina.';
    if (st === 'connessa') {
      var u = Nuvola.utente();
      return 'Attiva come ' + (u && u.email ? u.email : 'utente collegato') + '.';
    }
    if (st === 'spenta') return 'Non attiva: le task stanno solo su questo dispositivo.';
    return 'Accesso non effettuato su questo dispositivo.';
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
    if (!root) return;
    if (state.view === 'dafare') renderAperte();
    else if (state.view === 'fatte') renderFatte();
    else renderOpzioni();
  }

  /* ─────────────────────────── montaggio ─────────────────────────── */
  function mount(host) {
    load();
    root = document.getElementById('tpl-task').content.cloneNode(true).firstElementChild;
    host.appendChild(root);
    state.view = 'dafare';

    all('.segtab').forEach(function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    });

    root.querySelector('[data-act="add"]').addEventListener('click', function () { apriSheet(null); });
    root.querySelector('[data-act="svuotaFatte"]').addEventListener('click', svuotaFatte);
    root.querySelector('[data-act="wipe"]').addEventListener('click', svuotaTutto);
    root.querySelector('[data-act="export"]').addEventListener('click', esporta);
    root.querySelector('[data-act="import"]').addEventListener('click', function () { el('importFile').click(); });
    el('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importa(this.files[0]);
      this.value = '';
    });

    el('fOrdine').addEventListener('change', function () { state.filtri.ordine = this.value; renderAperte(); });
    el('fImportanza').addEventListener('change', function () { state.filtri.importanza = +this.value; renderAperte(); });
    el('fCerca').addEventListener('input', function () { state.filtri.cerca = this.value; renderAperte(); });

    root.querySelector('[data-act="nuvolaEntra"]').addEventListener('click', function () {
      if (!window.Nuvola) { Hub.toast('Sincronizzazione non disponibile.'); return; }
      Hub.toast('Apro l’accesso Google…');
      Nuvola.accedi().catch(function (e) {
        Hub.toast('Accesso non riuscito' + (e && e.code ? ' (' + e.code + ')' : ''));
      });
    });
    root.querySelector('[data-act="nuvolaEsci"]').addEventListener('click', function () {
      if (!confirm('Disconnettere questo dispositivo?')) return;
      Nuvola.esci().then(function () { renderAttuale(); });
    });

    on(doc('#tkForm'), 'submit', salva);
    on(doc('#tkClose'), 'click', chiudiSheet);
    on(doc('#tkAnnulla'), 'click', chiudiSheet);
    on(doc('#tkElimina'), 'click', elimina);
    on(doc('#tkSheet'), 'click', function (e) { if (e.target === this) chiudiSheet(); });

    setView('dafare');
    avviaSincronizzazione();
  }

  function unmount() {
    fermaSincronizzazione();
    listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
    listeners = [];
    chiudiSheet();
    root = null;
  }

  function stat() {
    load();
    var a = aperte();
    if (!a.length) return { text: 'Niente da fare', tone: '' };
    var alte = a.filter(function (t) { return t.importanza === 3; }).length;
    return {
      text: a.length + (a.length === 1 ? ' aperta' : ' aperte') + (alte ? ' · ' + alte + ' urgenti' : ''),
      tone: alte ? 'neg' : ''
    };
  }

  if (window.Nuvola) {
    Nuvola.osserva(function () {
      avviaSincronizzazione();
      if (root) renderAttuale();
      if (Hub.refreshHome) Hub.refreshHome();
    });
  }

  Hub.register({ id: 'task', nome: 'Task', mount: mount, unmount: unmount, stat: stat });
})();
