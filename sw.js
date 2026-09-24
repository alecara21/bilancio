/* Service worker: rende l'app utilizzabile anche senza rete.
   Strategia: PRIMA LA RETE per tutto, cache come riserva quando si e' offline.
   (In precedenza i file statici venivano presi prima dalla cache: dopo un
   aggiornamento il telefono continuava a eseguire il codice vecchio.)
   Nessun dato personale passa di qui: i movimenti vivono in localStorage,
   che il service worker non vede e non tocca. */

var CACHE = 'hub-v7';
var ASSETS = [
  './',
  './index.html',
  './css/base.css',
  './css/bilancio.css',
  './css/calendario.css',
  './js/shell.js',
  './js/bilancio.js',
  './js/calendario.js',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(u).catch(function () { /* un file mancante non blocca l'installazione */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  var isDoc = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') > -1;

  ev.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // senza rete si ripiega su quello che abbiamo salvato
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        return isDoc ? caches.match('./index.html') : Response.error();
      });
    })
  );
});


/* Risponde alla pagina che chiede quale versione sta servendo, e accetta
   l'ordine di subentrare subito quando l'utente forza un aggiornamento. */
self.addEventListener('message', function (ev) {
  if (!ev.data) return;
  if (ev.data.type === 'versione' && ev.ports && ev.ports[0]) {
    ev.ports[0].postMessage({ cache: CACHE });
  }
  if (ev.data.type === 'attiva') self.skipWaiting();
});

/* ══════════════════════ notifiche push del Calendario ══════════════════════

   La notifica arriva SENZA contenuto: il server sa solo che a quest'ora va
   avvisato questo dispositivo. Il testo del promemoria vive qui, nel database
   locale del telefono, e non ha mai attraversato la rete.
   ══════════════════════════════════════════════════════════════════════════ */

var DB_NOME = 'hub-cal';
var DB_STORE = 'avvisi';

function apriDb() {
  return new Promise(function (ok, no) {
    var req = indexedDB.open(DB_NOME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'k' });
      }
    };
    req.onsuccess = function () { ok(req.result); };
    req.onerror = function () { no(req.error); };
  });
}

function tuttiGliAvvisi(db) {
  return new Promise(function (ok, no) {
    var tx = db.transaction(DB_STORE, 'readonly');
    var req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = function () { ok(req.result || []); };
    req.onerror = function () { no(req.error); };
  });
}

function eliminaAvvisi(db, chiavi) {
  return new Promise(function (ok) {
    var tx = db.transaction(DB_STORE, 'readwrite');
    var st = tx.objectStore(DB_STORE);
    chiavi.forEach(function (k) { st.delete(k); });
    tx.oncomplete = function () { ok(); };
    tx.onerror = function () { ok(); };
  });
}

self.addEventListener('push', function (ev) {
  ev.waitUntil((function () {
    var adesso = Date.now();
    return apriDb().then(function (db) {
      return tuttiGliAvvisi(db).then(function (lista) {
        // scattati da poco o che stanno per scattare
        var dovuti = lista
          .filter(function (a) { return a.at <= adesso + 60000 && a.at > adesso - 10 * 60000; })
          .sort(function (x, y) { return x.at - y.at; })
          .slice(0, 3);

        if (!dovuti.length) {
          // il permesso obbliga a mostrare sempre qualcosa
          return self.registration.showNotification('Promemoria', {
            body: 'Apri il calendario per vedere cosa c\u2019\u00e8.',
            icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'hub-generico'
          });
        }

        return Promise.all(dovuti.map(function (a) {
          return self.registration.showNotification(a.titolo || 'Promemoria', {
            body: a.corpo || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
            tag: a.k, renotify: true, requireInteraction: false,
            data: { url: './#/calendario' }
          });
        })).then(function () {
          return eliminaAvvisi(db, dovuti.map(function (a) { return a.k; }));
        });
      });
    }).catch(function () {
      return self.registration.showNotification('Promemoria', {
        body: 'Apri il calendario per vedere cosa c\u2019\u00e8.',
        icon: 'icons/icon-192.png', tag: 'hub-generico'
      });
    });
  })());
});

self.addEventListener('notificationclick', function (ev) {
  ev.notification.close();
  var dest = (ev.notification.data && ev.notification.data.url) || './#/calendario';
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (lista) {
      for (var i = 0; i < lista.length; i++) {
        if ('focus' in lista[i]) { lista[i].navigate(dest); return lista[i].focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(dest);
    })
  );
});
