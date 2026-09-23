/* Service worker: rende l'app utilizzabile anche senza rete.
   HTML: prima la rete (così un aggiornamento arriva subito), cache come riserva.
   Asset statici: prima la cache, più veloce.
   Nessun dato personale passa di qui: i movimenti vivono in localStorage,
   che il service worker non vede e non tocca. */

var CACHE = 'hub-v1';
var ASSETS = [
  './',
  './index.html',
  './css/base.css',
  './css/bilancio.css',
  './js/shell.js',
  './js/bilancio.js',
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

  if (isDoc) {
    ev.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
      })
    );
    return;
  }

  ev.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
