# Hub

Sito personale in forma di app per telefono: all'apertura chiede un PIN, poi mostra
un menu di servizi. Sono attivi **Bilancio** (entrate e uscite) e **Calendario**
(appuntamenti, compleanni, promemoria); gli altri tre sono segnaposto pronti da riempire.

**Tutti i dati restano sul dispositivo.** Nessun server, nessun account, nessun
database online: tutto vive nella memoria locale del browser.

---

## Il PIN

Il PIN è **210306**.

### Cosa protegge davvero

Da essere chiari: il controllo avviene nel browser, quindi è una **barriera contro chi
prende in mano il telefono**, non una misura di sicurezza vera. Il PIN non è scritto in
chiaro nel codice (si confronta tramite hash), ma chi sa leggere il codice può aggirare
il blocco. Non è un difetto risolvibile senza un server: qualunque controllo eseguito
sul dispositivo si può scavalcare.

Il punto è che non c'è molto da proteggere da remoto: i dati non sono su internet, sono
solo sul tuo telefono. Il vero rischio è che qualcuno apra l'app dal tuo telefono
sbloccato, ed è esattamente lo scenario che il PIN copre.

Ci sono anche: **riblocco automatico** dopo 5 minuti in secondo piano, un pulsante
lucchetto per bloccare subito, e una **pausa di 15 secondi dopo 5 tentativi sbagliati**.

### Cambiare il PIN

Apri il sito, premi F12 → scheda *Console*, incolla questo (cambiando `210306` con il
PIN nuovo) e premi Invio:

```js
(async p => { const s = 'hub.v1.' + p;
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  let d = 5381; for (let i = 0; i < s.length; i++) d = ((d * 33) ^ s.charCodeAt(i)) >>> 0;
  console.log('PIN_SHA = ' + h + '\nPIN_DJB = ' + d.toString(16));
})('210306')
```

Ti stampa due valori: copiali in `js/shell.js`, nelle righe `var PIN_SHA` e `var PIN_DJB`.
Servono entrambi (il secondo è la riserva per quando apri il file senza server).

---

## Metterlo online (GitHub Pages)

Serve un repo **nuovo**, separato dagli altri progetti.

1. Su GitHub: **New repository** → nome `hub` → **Public** → Create.
2. **Add file → Upload files**: trascina dentro **tutto il contenuto** di questa cartella,
   sottocartelle comprese. Deve risultare così:

   ```
   index.html
   manifest.json
   sw.js
   README.md
   css/base.css
   css/bilancio.css
   css/calendario.css
   js/shell.js
   js/bilancio.js
   js/calendario.js
   icons/favicon.svg
   icons/icon-192.png
   icons/icon-512.png
   icons/icon-maskable-512.png
   icons/apple-touch-icon.png
   ```

   `index.html` deve stare nella **radice**, non dentro una sottocartella.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, cartella `/ (root)` → Save.
4. Dopo un minuto il sito è su `https://<tuo-utente>.github.io/hub/`.

> Il repo è pubblico ma contiene **solo il codice**: i tuoi movimenti non ci finiscono mai.

## Installarlo come app

- **iPhone/iPad** — apri il sito in **Safari** → Condividi → *Aggiungi a Home*.
- **Android** — apri in Chrome → menu ⋮ → *Installa app*.
- **PC** — in Chrome/Edge, l'icona di installazione appare nella barra degli indirizzi.

Parte a schermo intero, con la sua icona, e **funziona anche offline**.

---

## Il servizio Bilancio

- **Riepilogo**: saldo del mese, entrate, uscite, tasso di risparmio, grafico a 12 mesi
  (tocca una colonna per saltare a quel mese) e ripartizione per categoria.
- **Movimenti**: elenco con filtri e ricerca; tocca una riga per modificarla o eliminarla.
- **Opzioni**: categorie personalizzate, backup, cancellazione totale.
- Il pulsante **Aggiungi** apre il modulo. L'importo accetta sia `1234.56` che `1.234,56`.
- Ogni grafico ha il pulsante **Tabella** per leggere gli stessi numeri in forma testuale.

### Backup (importante)

PC e telefono hanno archivi separati. Per allinearli:
**Opzioni → Esporta backup (.json)**, passa il file all'altro dispositivo, poi
**Importa backup** (chiede se unire o sostituire; unendo non crea doppioni).

**Esporta un backup ogni tanto.** Se cancelli i dati di navigazione o disinstalli l'app,
i movimenti si perdono: il backup è l'unica rete di sicurezza. C'è anche l'esportazione
in **CSV** per Excel.

---

## Il servizio Calendario

- **Mese**: griglia con un pallino colorato per ogni evento (blu appuntamenti, arancione
  compleanni, verde promemoria). Tocca un giorno per vedere cosa c'è.
- **Agenda**: cosa arriva nei prossimi 30 giorni / 3 mesi / anno, con filtri e ricerca.
- **Opzioni**: esportazione, orario predefinito, backup.
- Ogni evento può **ripetersi** ogni settimana, mese o anno. I compleanni impostati su
  "ogni anno" mostrano da soli quanti anni compie la persona.
- Ogni evento può avere **più sveglie**: all'ora, 15/30 minuti, 1/2 ore, 1/2 giorni,
  1 settimana prima. Le scegli toccando le etichette, quante ne vuoi.

### Come far suonare davvero le sveglie

Questo è il punto importante, ed è bene essere chiari.

**Un sito web non può far scattare un promemoria a telefono chiuso.** Non è un limite
dell'app: su iPhone le notifiche programmate in locale non esistono per i siti web, e su
Android il sistema spegne il processo dopo pochi minuti. Nessuna riga di codice aggira
questa cosa.

La via che funziona è passare l'evento al **calendario del telefono**:

1. Apri l'evento nell'app.
2. Premi **"Aggiungi al calendario del telefono"**: scarica un file `.ics`.
3. Aprilo: iPhone e Android lo propongono al calendario di sistema, **con le sveglie già
   dentro**.

Da quel momento suona il calendario del telefono: affidabile, anche offline, anche a
telefono bloccato. Da Opzioni puoi anche esportare tutti gli eventi in un colpo solo.

Dentro l'app restano comunque due aiuti: gli **avvisi mentre l'app è aperta** (vanno
attivati da Opzioni) e l'**elenco dei promemoria scaduti** che compare quando riapri.

> Nota: sia le notifiche sia le sveglie del calendario rispettano la modalità silenziosa
> del telefono. Nessuna app web può scavalcarla.

---

## Aggiungere un servizio nuovo

I segnaposto rimasti si chiamano `scelta3`, `scelta4` e `scelta5`. Per attivarne uno servono due passi.

**1. Rinominalo** in `js/shell.js`, nella lista `SERVIZI` (nome, descrizione, colore, icona).

**2. Crea `js/ilmioservizio.js`** su questo schema:

```js
(function () {
  'use strict';

  function mount(host) {
    host.innerHTML = '<div style="padding:16px">Ciao!</div>';
    // qui costruisci il servizio
  }

  function unmount() {
    // opzionale: qui liberi timer e listener su window/document
  }

  function stat() {
    // opzionale: la riga che compare sulla scheda in home
    return { text: '3 attivi', tone: '' };   // tone: 'pos' | 'neg' | ''
  }

  Hub.register({ id: 'scelta3', nome: 'Il mio servizio', mount: mount, unmount: unmount, stat: stat });
})();
```

**3. Collegalo** in fondo a `index.html`:

```html
<script src="js/ilmioservizio.js"></script>
```

e aggiungi il file alla lista `ASSETS` in `sw.js`, così funziona anche offline.

Finché un `id` non ha un modulo registrato, la sua scheda resta grigia con l'etichetta
"In arrivo" e non è cliccabile: nessun errore.

### Rinominare l'app

"Hub" compare in: `index.html` (il tag `<title>`, `.lock-title`, i meta di Apple) e
`manifest.json` (`name` e `short_name`).

---

## Note tecniche

HTML, CSS e JavaScript puri: nessuna libreria, nessuna dipendenza, nessuna chiamata di rete.
I grafici sono SVG generati a mano.

**Scelte verificate, non a occhio:**

- I colori delle serie (entrate `#2a78d6`, uscite `#e34948`) passano il controllo per
  daltonismo con ΔE OKLab 21.6 sotto simulazione protanopia/deuteranopia, contro una
  soglia minima di 8. La classica coppia verde/rosso è stata scartata perché si ferma a 6.9.
  In più il tipo di movimento è indicato anche dal segno `+`/`−`, mai dal solo colore.
- Testo e accenti rispettano il contrasto WCAG AA in entrambi i temi (in tema scuro il
  testo sui pulsanti d'accento è scuro, non bianco: con il bianco si fermava a 3.7:1).
- Tutti i bersagli toccabili sono almeno 44×44px, come richiesto dalle linee guida iOS.

| Cartella / file | Cosa fa |
|---|---|
| `index.html` | struttura del guscio e modello del servizio Bilancio |
| `css/base.css` | token di colore, blocco PIN, home, primitive comuni |
| `css/bilancio.css` | stili del tracker |
| `css/calendario.css` | stili del calendario |
| `js/shell.js` | PIN, navigazione, tema, registro dei servizi |
| `js/bilancio.js` | dati, calcoli, grafici, backup del tracker |
| `js/calendario.js` | eventi, ricorrenze, sveglie, generazione `.ics` |
| `sw.js` | funzionamento offline |
| `manifest.json` | dati per l'installazione come app |

### Aprire l'app senza metterla online

Doppio clic su `index.html`: funziona tutto, PIN compreso, tranne l'installazione come
app e la modalità offline, che richiedono un indirizzo `http://` o `https://`.

### Se avevi già usato la versione precedente

I movimenti sono salvati sotto la stessa chiave (`bilancio.v1`) e la memoria locale è
legata al dominio, non alla cartella: se pubblichi su `<tuo-utente>.github.io`, i dati
già inseriti restano al loro posto anche cambiando il nome del repo.
