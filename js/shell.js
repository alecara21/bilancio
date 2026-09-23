/* =========================================================================
   Hub — guscio dell'applicazione.
   Si occupa di: blocco con PIN, home dei servizi, navigazione, tema, toast.
   I singoli servizi si registrano da soli con Hub.register().

   NOTA SUL PIN: il controllo avviene nel browser, quindi è una barriera
   contro chi prende in mano il telefono, NON una misura di sicurezza vera.
   Il PIN non è scritto in chiaro (è confrontato tramite hash), ma chiunque
   sappia leggere il codice può aggirare il blocco. I dati restano comunque
   solo su questo dispositivo: non c'è nulla da rubare da remoto.
   ========================================================================= */
(function () {
  'use strict';

  var SALT = 'hub.v1.';
  var PIN_SHA = '046b66f3ad38c06c5d4a75068c4601e95c07b5a9adc04ed6a6ff8c9e4d762bd9';
  var PIN_DJB = 'a307ee9b';           // ripiego quando crypto.subtle non c'è (file://)
  var PIN_LEN = 6;

  var SESSION_KEY = 'hub.unlocked';
  var THEME_KEY = 'hub.theme';
  var AUTOLOCK_MS = 5 * 60 * 1000;    // riblocca dopo 5 minuti in secondo piano
  var MAX_TRIES = 5;
  var COOLDOWN_MS = 15000;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  /* ─────────────────────────── servizi ─────────────────────────── */
  var SERVIZI = [
    {
      id: 'bilancio', nome: 'Bilancio', desc: 'Entrate e uscite', tint: 'var(--svc-1)',
      icona: '<path d="M3.5 13.5h3.4v7H3.5zM10.3 8h3.4v12.5h-3.4zM17.1 3.5h3.4v17h-3.4z"/>'
    },
    {
      id: 'calendario', nome: 'Calendario', desc: 'Appuntamenti e promemoria', tint: 'var(--svc-2)',
      icona: '<rect x="3" y="5" width="18" height="16" rx="2.8" fill="none" stroke-width="1.9"/><path d="M8 2.5v5M16 2.5v5M3 10.5h18" fill="none" stroke-width="1.9" stroke-linecap="round"/>'
    },
    {
      id: 'scelta3', nome: 'Scelta 3', desc: 'Da definire', tint: 'var(--svc-3)',
      icona: '<path d="M4 6.5h16M4 12h16M4 17.5h10" fill="none" stroke-width="2.1" stroke-linecap="round"/>'
    },
    {
      id: 'scelta4', nome: 'Scelta 4', desc: 'Da definire', tint: 'var(--svc-4)',
      icona: '<circle cx="12" cy="12" r="8.6" fill="none" stroke-width="2"/><path d="M12 7.2V12l3.2 2.2" fill="none" stroke-width="2" stroke-linecap="round"/>'
    },
    {
      id: 'scelta5', nome: 'Scelta 5', desc: 'Da definire', tint: 'var(--svc-5)',
      icona: '<path d="M6.5 3.5h11a1.6 1.6 0 0 1 1.6 1.6v15.4l-7.1-4-7.1 4V5.1A1.6 1.6 0 0 1 6.5 3.5Z" fill="none" stroke-width="2" stroke-linejoin="round"/>'
    }
  ];

  var moduli = Object.create(null);   // id -> modulo registrato
  var attivo = null;                  // modulo attualmente montato
  var depth = 0;                      // quante volte abbiamo aperto un servizio

  function register(mod) {
    if (!mod || !mod.id) return;
    moduli[mod.id] = mod;
    if (sbloccato()) renderHome();    // la scheda può mostrare un dato aggiornato
  }

  /* ─────────────────────────── tema ─────────────────────────── */
  function initTheme() {
    var t = 'auto';
    try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) {}
    document.documentElement.setAttribute('data-theme', t);
  }
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function toggleTheme() {
    var next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    if (attivo && attivo.onThemeChange) attivo.onThemeChange();
    renderHome();
  }

  /* ─────────────────────────── blocco ─────────────────────────── */
  var buffer = '';
  var tries = 0;
  var lockedUntil = 0;

  function sbloccato() {
    try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; }
  }

  function hashPin(pin) {
    var s = SALT + pin;
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      try {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
          .then(function (buf) {
            var b = new Uint8Array(buf), out = '';
            for (var i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
            return { algo: 'sha', val: out };
          });
      } catch (e) { /* ripiego sotto */ }
    }
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return Promise.resolve({ algo: 'djb', val: h.toString(16) });
  }

  function renderDots() {
    var dots = $('#dots');
    $$('span', dots).forEach(function (d, i) { d.classList.toggle('on', i < buffer.length); });
    dots.setAttribute('aria-label', 'PIN, ' + buffer.length + ' cifre su ' + PIN_LEN + ' inserite');
  }

  function pressDigit(d) {
    if (Date.now() < lockedUntil || buffer.length >= PIN_LEN) return;
    buffer += d;
    renderDots();
    if (buffer.length === PIN_LEN) setTimeout(checkPin, 140);
  }

  function pressDelete() {
    if (Date.now() < lockedUntil || !buffer.length) return;
    buffer = buffer.slice(0, -1);
    renderDots();
  }

  function checkPin() {
    var attempt = buffer;
    hashPin(attempt).then(function (h) {
      var atteso = h.algo === 'sha' ? PIN_SHA : PIN_DJB;
      if (h.val === atteso) { unlock(); return; }

      tries++;
      buffer = '';
      renderDots();
      var dots = $('#dots');
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }

      var msg = $('#lockMsg');
      msg.classList.add('is-err');

      if (tries >= MAX_TRIES) {
        lockedUntil = Date.now() + COOLDOWN_MS;
        $('#lock').classList.add('is-locked-out');
        tries = 0;
        var left = Math.ceil(COOLDOWN_MS / 1000);
        msg.textContent = 'Troppi tentativi. Riprova tra ' + left + 's';
        var iv = setInterval(function () {
          left--;
          if (left > 0) { msg.textContent = 'Troppi tentativi. Riprova tra ' + left + 's'; return; }
          clearInterval(iv);
          lockedUntil = 0;
          $('#lock').classList.remove('is-locked-out');
          msg.classList.remove('is-err');
          msg.textContent = 'Inserisci il PIN';
        }, 1000);
      } else {
        msg.textContent = 'PIN errato';
      }
    });
  }

  function unlock() {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {}
    buffer = ''; tries = 0;
    var lock = $('#lock');
    lock.classList.add('is-out');
    setTimeout(function () {
      lock.hidden = true;
      lock.classList.remove('is-out');
      $('#app').hidden = false;
      renderHome();
      route();
    }, 300);
  }

  function lockNow() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    closeService(true);
    buffer = '';
    renderDots();
    var msg = $('#lockMsg');
    msg.classList.remove('is-err');
    msg.textContent = 'Inserisci il PIN';
    $('#app').hidden = true;
    var lock = $('#lock');
    lock.hidden = false;
    lock.classList.remove('is-out');
  }

  /* ─────────────────────────── home ─────────────────────────── */
  function saluto() {
    var h = new Date().getHours();
    if (h < 5) return 'Buonanotte';
    if (h < 13) return 'Buongiorno';
    if (h < 18) return 'Buon pomeriggio';
    return 'Buonasera';
  }

  function renderHome() {
    $('#greet').textContent = saluto();
    $('#today').textContent = new Date().toLocaleDateString('it-IT',
      { weekday: 'long', day: 'numeric', month: 'long' });

    var host = $('#services');
    host.innerHTML = SERVIZI.map(function (s, i) {
      var mod = moduli[s.id];
      var pronto = !!mod;
      var stat = null;
      if (pronto && mod.stat) { try { stat = mod.stat(); } catch (e) { stat = null; } }

      var coda = pronto
        ? (stat ? '<span class="svc-stat ' + esc(stat.tone || '') + '">' + esc(stat.text) + '</span>' : '')
        : '<span class="soon-tag">In arrivo</span>';

      return '<button class="svc-card' + (pronto ? '' : ' is-soon') + '" type="button" ' +
        'data-id="' + esc(s.id) + '" style="--tint:' + s.tint + ';animation-delay:' + (i * 55) + 'ms">' +
        '<span class="svc-ico"><svg viewBox="0 0 24 24" class="ico" aria-hidden="true">' + s.icona + '</svg></span>' +
        '<span class="svc-name">' + esc(s.nome) + '</span>' +
        '<span class="svc-desc">' + esc(s.desc) + '</span>' +
        coda +
        '</button>';
    }).join('');

    $$('.svc-card', host).forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        if (!moduli[id]) { toast('Servizio non ancora attivo'); return; }
        open(id);
      });
    });
  }

  /* ─────────────────────────── navigazione ─────────────────────────── */
  function open(id) {
    depth++;
    location.hash = '#/' + id;
  }

  function back() {
    if (depth > 0 && history.length > 1) { depth--; history.back(); }
    else { depth = 0; location.replace(location.pathname + location.search + '#'); route(); }
  }

  function mountService(id) {
    var mod = moduli[id];
    if (!mod) { location.replace(location.pathname + location.search + '#'); return; }
    if (attivo && attivo.id === id) return;
    closeService(false);

    var svc = SERVIZI.filter(function (s) { return s.id === id; })[0] || { nome: mod.nome || id };
    $('#svcTitle').textContent = mod.nome || svc.nome;
    $('#svcTools').innerHTML = '';

    var body = $('#svcBody');
    body.innerHTML = '';
    body.scrollTop = 0;

    attivo = mod;
    mod.mount(body, { tools: $('#svcTools'), toast: toast, back: back });

    $('#screen-home').hidden = true;
    $('#screen-service').hidden = false;
  }

  function closeService(silent) {
    if (attivo) {
      if (attivo.unmount) { try { attivo.unmount(); } catch (e) {} }
      attivo = null;
    }
    $('#svcBody').innerHTML = '';
    $('#screen-service').hidden = true;
    $('#screen-home').hidden = false;
    if (!silent) renderHome();
  }

  function route() {
    if (!sbloccato()) return;
    var m = /^#\/([\w-]+)$/.exec(location.hash || '');
    if (m && moduli[m[1]]) mountService(m[1]);
    else if (attivo || !$('#screen-service').hidden) closeService(false);
  }

  /* ─────────────────────────── avvio ─────────────────────────── */
  function init() {
    initTheme();
    renderDots();

    $$('.key[data-d]').forEach(function (k) {
      k.addEventListener('click', function () { pressDigit(k.getAttribute('data-d')); });
    });
    $('.key[data-act="del"]').addEventListener('click', pressDelete);

    // tastiera fisica (utile da PC)
    document.addEventListener('keydown', function (ev) {
      if ($('#lock').hidden) return;
      if (/^[0-9]$/.test(ev.key)) { pressDigit(ev.key); ev.preventDefault(); }
      else if (ev.key === 'Backspace') { pressDelete(); ev.preventDefault(); }
    });

    $('#themeBtn').addEventListener('click', toggleTheme);
    $('#lockBtn').addEventListener('click', lockNow);
    $('#backBtn').addEventListener('click', back);

    window.addEventListener('hashchange', route);

    // riblocco automatico dopo un periodo in secondo piano
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > AUTOLOCK_MS && sbloccato()) lockNow();
      hiddenAt = 0;
    });

    if (sbloccato()) {
      $('#lock').hidden = true;
      $('#app').hidden = false;
      renderHome();
      route();
    }

    if ('serviceWorker' in navigator) {
      // Quando esce una versione nuova, il service worker la installa e prende
      // il controllo: a quel punto ricarichiamo una volta sola, altrimenti la
      // pagina resterebbe con il codice vecchio già caricato in memoria.
      // alla primissima installazione il controllo passa da "nessuno" al service
      // worker: quello non è un aggiornamento e non deve ricaricare nulla
      var avevaControllo = !!navigator.serviceWorker.controller;
      var giaRicaricato = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!avevaControllo || giaRicaricato) return;
        giaRicaricato = true;
        location.reload();
      });

      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          reg.update();
          // ricontrolla a ogni ritorno sull'app
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { try { reg.update(); } catch (e) {} }
          });
        }).catch(function () {});
      });
    }
  }

  window.Hub = {
    register: register,
    toast: toast,
    esc: esc,
    open: open,
    back: back,
    isDark: isDark,
    refreshHome: function () { if (!$('#screen-home').hidden) renderHome(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
