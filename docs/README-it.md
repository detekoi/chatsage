[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage


ChatSage è un chatbot potenziato dall'IA progettato per gli ambienti chat di Twitch in qualsiasi lingua. Fornisce risposte contestualmente pertinenti basate sulla cronologia della chat, sulle query degli utenti e sulle informazioni dello streaming in tempo reale (gioco corrente, titolo, tag).

> Importante: L'accesso alla versione cloud di ChatSage è attualmente su invito (allow-list). Il pannello self-service è disabilitato per i canali non approvati. Se desideri provare il bot, contattami qui: [Modulo di contatto](https://parfaitfair.com/#contact).

**[Aggiungi ChatSage al tuo canale Twitch →](https://bot.wildcat.chat)**

[![Licenza](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE.md)

## Sommario

- [Funzionalità (Capacità Fondamentali)](#funzionalità-capacità-fondamentali)
- [Aggiungere ChatSage al Tuo Canale](#aggiungere-chatsage-al-tuo-canale)
- [Esempi di Utilizzo](#esempi-di-utilizzo)
- [Prerequisiti di Sviluppo](#prerequisiti-di-sviluppo)
- [Per Iniziare](#per-iniziare)
- [Esecuzione del Bot](#esecuzione-del-bot)
- [Configurazione](#configurazione)
- [Gestione dei Token Twitch](#gestione-dei-token-twitch)
- [Docker](#docker)

## Funzionalità (Capacità Fondamentali)

* Riceve i messaggi della chat tramite webhook Twitch EventSub e invia risposte tramite l'API Twitch Helix.
* Recupera il contesto dello streaming in tempo reale (gioco, titolo, tag, immagini di anteprima) utilizzando l'API Twitch Helix.
* Utilizza il LLM Google Gemini 3 Flash per la comprensione del linguaggio naturale e la generazione di risposte (i comandi leggeri come `!lurk` e `!translate` usano Gemini 2.5 Flash Lite per velocità ed efficienza dei costi).
* Mantiene il contesto della conversazione (cronologia e riassunti) per canale.
* Supporta comandi chat personalizzati con livelli di autorizzazione.
* Impostazioni della lingua del bot configurabili per il supporto di canali multilingue.
* Configurabile tramite variabili d'ambiente.
* Include logging strutturato adatto per ambienti di produzione.
* Interfaccia di gestione canali basata sul web per consentire agli streamer di aggiungere/rimuovere il bot.

## Aggiungere ChatSage al Tuo Canale

Nota: Solo i canali approvati nella allow-list possono abilitare ChatSage. Se non sei ancora approvato ma vuoi provarlo, contattami tramite il [Modulo di contatto](https://parfaitfair.com/#contact).

Se il tuo canale è approvato, puoi aggiungere o rimuovere ChatSage tramite l'interfaccia web:

1.  **Visita il Portale di Gestione ChatSage**:
    -   Vai al [Portale di Gestione ChatSage](https://bot.wildcat.chat) (solo canali approvati)
    -   Fai clic su "Accedi con Twitch"

2.  **Autorizza l'Applicazione**:
    -   Sarai reindirizzato su Twitch per autorizzare ChatSage
    -   Concedi le autorizzazioni richieste
    -   Questo processo è sicuro e utilizza il flusso OAuth di Twitch

3.  **Gestisci il Bot**:
    -   Una volta effettuato l'accesso, vedrai la tua dashboard
    -   Usa il pulsante "Aggiungi Bot al Mio Canale" per far entrare ChatSage nel tuo canale
    -   Usa "Rimuovi Bot dal Mio Canale" se desideri rimuoverlo

4.  **Tempo di Ingresso del Bot**:
    -   Dopo aver aggiunto il bot, dovrebbe entrare nel tuo canale entro pochi minuti
    -   Se il bot non entra dopo 10 minuti, prova a rimuoverlo e aggiungerlo di nuovo
    -   Importante: se il bot non risponde, concedigli lo stato di moderatore con il comando "/mod ChatSageBot"

5.  **Interazione Utente**:
    -   Gli spettatori possono interagire con ChatSage menzionandolo: `@ChatSageBot ciao` (il nome utente verrà aggiornato per riflettere il nuovo nome, ChatSage, quando Twitch me lo consentirà)
    -   Oppure utilizzando vari [comandi](https://docs.wildcat.chat/botcommands.html) come `!ask`, `!translate`, ecc.

## Esempi di Utilizzo

### Comandi Chat

Per un elenco completo dei comandi disponibili e il loro utilizzo, visita la [Documentazione dei Comandi del Bot](https://docs.wildcat.chat/botcommands.html).

## Prerequisiti di Sviluppo

* Node.js (versione 22.0.0 o successiva raccomandata)
* npm (o yarn)

## Per Iniziare

1.  **Clona il repository:**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
    cd chatsage
    ```

2.  **Installa le dipendenze:**
    ```bash
    npm install
    ```
    *(Oppure `yarn install` se preferisci Yarn)*

3.  **Configura le variabili d'ambiente:**
    * Copia il file d'ambiente di esempio:
        ```bash
        cp .env.example .env
        ```
    * Modifica il file `.env` e inserisci le tue credenziali e impostazioni. Fai riferimento ai commenti all'interno di `.env.example` per i dettagli su ciascuna variabile (nome utente/token del bot Twitch, ID client/segreto dell'applicazione Twitch, chiave API Gemini, canali a cui unirsi, ecc.). **Non committare il tuo file `.env`.**

## Esecuzione del Bot

* **Sviluppo:**
    Utilizza la modalità watch integrata di Node per riavvii automatici in caso di modifiche ai file. Abilita i log leggibili dall'uomo ("pretty") per impostazione predefinita se `PINO_PRETTY_LOGGING=true` nel file `.env`.
    ```bash
    npm run dev
    ```

* **Produzione:**
    Esegue il bot utilizzando `node` standard. Emette log JSON strutturati adatti per sistemi di aggregazione dei log.
    ```bash
    npm start
    ```

## Configurazione

ChatSage è configurato principalmente tramite variabili d'ambiente. Le variabili richieste e opzionali sono documentate nel file `.env.example`. Le variabili chiave includono:

* `TWITCH_BOT_USERNAME`: Nome utente per l'account Twitch del bot.
* `TWITCH_CHANNELS`: Elenco di canali separati da virgola a cui unirsi in sviluppo locale. In produzione il bot carica il proprio elenco di canali da Firestore.
* `GEMINI_API_KEY`: La tua chiave API per il servizio Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenziali per la tua applicazione Twitch registrata (utilizzate per le chiamate API Helix).
* `TWITCH_BOT_REFRESH_TOKEN`: Token di aggiornamento dell'account del bot. Il bot lo usa per inviare annunci in chat a proprio nome. In produzione, Cloud Run lo carica dal secret `TWITCH_BOT_REFRESH_TOKEN` in Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Frequenza di aggiornamento dei dati di contesto dello streaming.
* `LOG_LEVEL`: Controlla la verbosità dei log.

Assicurati che tutte le variabili richieste siano impostate nel tuo ambiente o nel file `.env` prima di eseguire il bot.

## Gestione dei Token Twitch

ChatSage utilizza un meccanismo sicuro di aggiornamento dei token per mantenere l'autenticazione con Twitch:

### Autenticazione del Bot

ChatSage usa due tipi di token Twitch:

*   Un **token di accesso dell'app** per la maggior parte delle chiamate Helix, incluso l'invio dei messaggi in chat. ChatSage lo ottiene da `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET`. Non devi configurarlo.
*   Un **token di accesso utente per l'account del bot** per gli annunci in chat. Twitch rifiuta i token di accesso dell'app sull'endpoint degli annunci.

Per configurare il token utente del bot:

1.  **Prerequisiti**:
    *   Registra un'applicazione sulla [Console Sviluppatori Twitch](https://dev.twitch.tv/console/). Annota il tuo **ID Client** e il tuo **Segreto Client**.
    *   Nelle impostazioni della tua applicazione Twitch, aggiungi `http://localhost:3456/callback` come URL di reindirizzamento OAuth.
    *   Imposta `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET` nel tuo file `.env`.

2.  **Genera il token di aggiornamento**:
    *   Esegui `node scripts/get-user-token.js`.
    *   Accedi a Twitch con l'account del bot e autorizza gli scope richiesti. Gli scope includono `moderator:manage:announcements`.
    *   Lo script stampa il token di accesso e il token di aggiornamento.

3.  **Salva il token di aggiornamento**:
    *   Per lo sviluppo locale, imposta `TWITCH_BOT_REFRESH_TOKEN` nel tuo file `.env`.
    *   Per la produzione, aggiungi il token di aggiornamento come nuova versione del secret `TWITCH_BOT_REFRESH_TOKEN` in Google Secret Manager. Il workflow di deploy monta quel secret come variabile d'ambiente `TWITCH_BOT_REFRESH_TOKEN`. Assegna il ruolo IAM `Secret Manager Secret Accessor` all'account di servizio che esegue ChatSage.

4.  **Rendi il bot moderatore** in ogni canale in cui deve inviare annunci. In un canale in cui il bot non è moderatore, ChatSage invia gli annunci con il token del broadcaster, quindi appaiono come inviati dal broadcaster.

Quando il token di accesso del bot scade, ChatSage ne richiede uno nuovo con il token di aggiornamento. Se il token di aggiornamento non è più valido, esegui di nuovo `scripts/get-user-token.js` e aggiungi una nuova versione del secret.

### UI Web per la Gestione dei Canali

L'[interfaccia web](https://github.com/detekoi/chatsage-web-ui) utilizza un flusso OAuth separato per consentire agli streamer di gestire il bot nel loro canale:

1.  **Configurazione di Firebase Functions**:
    *   L'UI web è costruita con Firebase Functions e Hosting.
    *   Utilizza Twitch OAuth per autenticare gli streamer.
    *   Quando uno streamer aggiunge o rimuove il bot, aggiorna una collezione Firestore.
    *   Il bot controlla periodicamente questa collezione per determinare a quali canali unirsi o da quali uscire.

2.  **Variabili d'Ambiente per l'UI Web**:
    *   `TWITCH_CLIENT_ID`: ID client dell'applicazione Twitch.
    *   `TWITCH_CLIENT_SECRET`: Segreto client dell'applicazione Twitch.
    *   `CALLBACK_URL`: L'URL di callback OAuth (l'URL della tua funzione deployata).
    *   `FRONTEND_URL`: L'URL della tua interfaccia web.
    *   `JWT_SECRET_KEY`: Segreto per la firma dei token di autenticazione.
    *   `SESSION_COOKIE_SECRET`: Segreto per i cookie di sessione.

Questo approccio fornisce una maggiore sicurezza utilizzando flussi OAuth standard e strumenti ufficiali, e non memorizzando token sensibili direttamente nei file di configurazione ove possibile. Offre inoltre agli streamer il controllo sull'aggiunta o la rimozione del bot dal loro canale.

<details>
<summary><strong>EventSub per il Deployment Serverless (Opzionale)</strong></summary>

Questo progetto supporta EventSub di Twitch per abilitare un deployment serverless "scale-to-zero" su piattaforme come Google Cloud Run. Ciò riduce significativamente i costi di hosting eseguendo il bot solo quando un canale in cui si trova è in diretta.

### Panoramica

- **Come funziona:** Il bot si iscrive agli eventi `stream.online`. Quando uno streamer va in diretta, Twitch invia un webhook che avvia l'istanza del bot. Il bot rimane attivo mentre lo streaming è in diretta e si ridimensiona a zero istanze quando tutti i canali monitorati sono offline.
- **Risparmio sui costi:** Questo modello può ridurre significativamente i costi di hosting.

### Variabili d'Ambiente Richieste

Per abilitare questa funzione, imposta quanto segue nel tuo ambiente di deployment (ad es. Cloud Run):

- `TWITCH_EVENTSUB_SECRET`: Una stringa segreta lunga e casuale che crei per proteggere il tuo endpoint webhook.
- `PUBLIC_URL`: L'URL pubblico del tuo servizio distribuito (ad es. `https://your-service.a.run.app`).

### Processo di Configurazione

1.  **Eseguire il deploy con le Variabili EventSub:**
    Distribuisci la tua applicazione con le variabili d'ambiente sopra elencate. Per Cloud Run, useresti `gcloud run deploy` con `--set-env-vars`.

2.  **Iscriversi agli Eventi:**
    Dopo la distribuzione, esegui lo script di gestione per iscrivere tutti i tuoi canali all'evento `stream.online`.
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **Verificare le Iscrizioni:**
    Puoi verificare che le iscrizioni siano state create con successo:
    ```bash
    node scripts/manage-eventsub.js list
    ```

Questa configurazione garantisce che il bot consumi risorse solo quando deve essere attivo in un canale in diretta.

</details>

## Docker

Viene fornito un `Dockerfile` per la creazione di un'immagine container dell'applicazione.

1.  **Costruisci l'immagine:**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Esegui il container:**
    È necessario passare le variabili d'ambiente al container. Un modo è utilizzare un file di ambiente:
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Assicurati che il tuo file `.env` sia popolato correttamente)*