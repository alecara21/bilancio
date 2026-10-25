/* =========================================================================
   Nuvola — collegamento a Firestore (progetto Firebase "alecara").

   PERCHE' ESISTE: i dati tenuti solo nel browser possono sparire senza
   preavviso — su iPhone Safari cancella la memoria dei siti dopo 7 giorni,
   ed e' successo davvero. Firestore li conserva fuori dal dispositivo e li
   allinea fra PC e telefono.

   COME FUNZIONA: il telefono resta la copia di lavoro (localStorage), la
   nuvola e' la verita'. Chi si collega vede solo il proprio ramo
   `utenti/<identificativo>/...`: lo impongono le regole di sicurezza del
   database, non il codice qui dentro, che chiunque puo' leggere.

   Senza accesso l'app continua a funzionare in locale, come prima.
   ========================================================================= */
(function () {
  'use strict';

  var CONFIG = {
    apiKey: 'AIzaSyBWvkasrT449SvCL9wZGe0n61TQiW2Inhk',
    authDomain: 'alecara.firebaseapp.com',
    projectId: 'alecara',
    storageBucket: 'alecara.firebasestorage.app',
    messagingSenderId: '180024895890',
    appId: '1:180024895890:web:f631c9bede29e96f1d394b'
  };

  var SCELTA_KEY = 'hub.nuvolaAttiva';

  var pronto = false, db = null, auth = null;
  var utente = null;
  var ascoltatori = [];      // chi vuole sapere quando lo stato cambia

  function avvisa() {
    ascoltatori.forEach(function (fn) {
      try { fn(stato(), utente); } catch (e) {}
    });
  }

  function stato() {
    if (!pronto) return 'non disponibile';
    if (!attiva()) return 'spenta';
    return utente ? 'connessa' : 'disconnessa';
  }

  function attiva() {
    try { return localStorage.getItem(SCELTA_KEY) === '1'; } catch (e) { return false; }
  }

  function segnaAttiva(v) {
    try { localStorage.setItem(SCELTA_KEY, v ? '1' : '0'); } catch (e) {}
  }

  /* ─────────────────────────── avvio ─────────────────────────── */
  function inizializza() {
    if (pronto) return true;
    if (typeof firebase === 'undefined' || !firebase.initializeApp) return false;

    try {
      firebase.initializeApp(CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();

      // La cache locale di Firestore tiene l'app viva anche senza rete e
      // manda in coda le scritture fatte offline.
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {
        /* piu' schede aperte o browser non compatibile: si lavora comunque online */
      });

      auth.onAuthStateChanged(function (u) {
        utente = u ? { uid: u.uid, email: u.email || '', nome: u.displayName || '' } : null;
        if (u) segnaAttiva(true);
        avvisa();
      });

      // ritorno da un accesso avvenuto con reindirizzamento (tipico su iPhone)
      auth.getRedirectResult().catch(function () {});

      pronto = true;
      return true;
    } catch (e) {
      pronto = false;
      return false;
    }
  }

  /* ─────────────────────────── accesso ─────────────────────────── */
  function accedi() {
    if (!inizializza()) return Promise.reject(new Error('Firebase non disponibile'));
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    return auth.signInWithPopup(provider).catch(function (err) {
      var codice = err && err.code ? err.code : '';
      // Nelle app installate la finestra a comparsa spesso viene bloccata:
      // in quel caso si passa dal reindirizzamento.
      if (codice.indexOf('popup') > -1 || codice.indexOf('cancelled') > -1) {
        segnaAttiva(true);
        return auth.signInWithRedirect(provider);
      }
      throw err;
    });
  }

  function esci() {
    segnaAttiva(false);
    if (!auth) { utente = null; avvisa(); return Promise.resolve(); }
    return auth.signOut().then(function () { utente = null; avvisa(); });
  }

  /* ─────────────────────────── dati ─────────────────────────── */
  function radice() {
    if (!db || !utente) return null;
    return db.collection('utenti').doc(utente.uid);
  }

  // Resta in ascolto su una collezione: la richiamata scatta a ogni modifica,
  // compresa quella fatta da un altro dispositivo.
  function ascoltaCollezione(nome, callback) {
    var r = radice();
    if (!r) return function () {};
    return r.collection(nome).onSnapshot(function (istantanea) {
      var fuori = [];
      istantanea.forEach(function (doc) {
        var d = doc.data() || {};
        d.id = doc.id;
        fuori.push(d);
      });
      callback(fuori, istantanea.metadata.fromCache);
    }, function () { /* errore di rete: si continua con la copia locale */ });
  }

  function scriviDocumento(collezione, id, dati) {
    var r = radice();
    if (!r) return Promise.resolve(false);
    return r.collection(collezione).doc(id).set(dati, { merge: false })
      .then(function () { return true; }).catch(function () { return false; });
  }

  // Scrive molti documenti in un colpo solo (serve alla prima migrazione).
  function scriviMolti(collezione, elementi) {
    var r = radice();
    if (!r || !elementi.length) return Promise.resolve(0);

    var pezzi = [], i;
    for (i = 0; i < elementi.length; i += 400) pezzi.push(elementi.slice(i, i + 400));

    return pezzi.reduce(function (catena, pezzo) {
      return catena.then(function (contati) {
        var lotto = db.batch();
        pezzo.forEach(function (el) {
          var copia = {};
          Object.keys(el).forEach(function (k) { if (k !== 'id') copia[k] = el[k]; });
          lotto.set(r.collection(collezione).doc(el.id), copia);
        });
        return lotto.commit().then(function () { return contati + pezzo.length; });
      });
    }, Promise.resolve(0)).catch(function () { return 0; });
  }

  function eliminaDocumento(collezione, id) {
    var r = radice();
    if (!r) return Promise.resolve(false);
    return r.collection(collezione).doc(id).delete()
      .then(function () { return true; }).catch(function () { return false; });
  }

  function ascoltaDocumento(collezione, id, callback) {
    var r = radice();
    if (!r) return function () {};
    return r.collection(collezione).doc(id).onSnapshot(function (doc) {
      callback(doc.exists ? doc.data() : null);
    }, function () {});
  }

  function scriviMeta(collezione, id, dati) {
    return scriviDocumento(collezione, id, dati);
  }

  /* ─────────────────────────── interfaccia ─────────────────────────── */
  window.Nuvola = {
    inizializza: inizializza,
    stato: stato,
    attiva: attiva,
    utente: function () { return utente; },
    accedi: accedi,
    esci: esci,
    osserva: function (fn) { ascoltatori.push(fn); fn(stato(), utente); },
    ascoltaCollezione: ascoltaCollezione,
    ascoltaDocumento: ascoltaDocumento,
    scriviDocumento: scriviDocumento,
    scriviMolti: scriviMolti,
    eliminaDocumento: eliminaDocumento,
    scriviMeta: scriviMeta
  };

  inizializza();
})();
