[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)

# ChatSage

[![Licenza](https://img.shields.io/badge/Licenza-BSD%202--Clausole-blue.svg)](LICENSE.MD)

ChatSage è un chatbot potenziato dall'IA progettato per gli ambienti chat di Twitch in qualsiasi lingua. Fornisce risposte contestualmente pertinenti basate sulla cronologia della chat, sulle query degli utenti e sulle informazioni dello streaming in tempo reale (gioco corrente, titolo, tag).

**[Aggiungi ChatSage al tuo canale Twitch →](https://streamsage-bot.web.app)**

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

* Si connette ai canali Twitch specificati tramite IRC.
* Recupera il contesto dello streaming in tempo reale (gioco, titolo, tag, immagini di anteprima) utilizzando l'API Twitch Helix.
* Utilizza il LLM Google Gemini 2.0 Flash per la comprensione del linguaggio naturale e la generazione di risposte.
* Mantiene il contesto della conversazione (cronologia e riassunti) per canale.
* Supporta comandi chat personalizzati con livelli di autorizzazione.
* Impostazioni della lingua del bot configurabili per il supporto di canali multilingue.
* Configurabile tramite variabili d'ambiente.
* Include logging strutturato adatto per ambienti di produzione.
* Interfaccia di gestione canali basata sul web per consentire agli streamer di aggiungere/rimuovere il bot.

## Aggiungere ChatSage al Tuo Canale

Gli streamer possono ora aggiungere o rimuovere facilmente ChatSage dal loro canale utilizzando l'interfaccia web:

1.  **Visita il Portale di Gestione ChatSage**:
    -   Vai al [Portale di Gestione ChatSage](https://streamsage-bot.web.app)
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

5.  **Interazione Utente**:
    -   Gli spettatori possono interagire con ChatSage menzionandolo: `@StreamSageTheBot ciao` (il nome utente verrà aggiornato per riflettere il nuovo nome, ChatSage, quando Twitch me lo consentirà)
    -   Oppure utilizzando vari [comandi](https://detekoi.github.io/botcommands.html) come `!ask`, `!translate`, ecc.

## Esempi di Utilizzo

### Comandi Chat

Per un elenco completo dei comandi disponibili e il loro utilizzo, visita la [Documentazione dei Comandi del Bot](https://detekoi.github.io/botcommands.html).

## Prerequisiti di Sviluppo

* Node.js (versione 22.0.0 o successiva raccomandata)
* npm (o yarn)

## Per Iniziare

1.  **Clona il repository:**
    ```bash
    git clone [https://github.com/your-username/chatsage.git](https://github.com/your-username/chatsage.git)
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
* `TWITCH_CHANNELS`: Elenco di canali separati da virgola a cui unirsi. Utilizzato come fallback se la gestione dei canali Firestore non è disponibile.
* `TWITCH_CHANNELS_SECRET_NAME`: Nome della risorsa per l'elenco dei canali in Google Secret Manager. Utilizzato come fallback se la gestione dei canali Firestore non è disponibile.
* `GEMINI_API_KEY`: La tua chiave API per il servizio Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenziali per la tua applicazione Twitch registrata (utilizzate per le chiamate API Helix).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Nome della risorsa per il token di aggiornamento in Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Frequenza di aggiornamento dei dati di contesto dello streaming.
* `LOG_LEVEL`: Controlla la verbosità dei log.

Assicurati che tutte le variabili richieste siano impostate nel tuo ambiente o nel file `.env` prima di eseguire il bot.

## Gestione dei Token Twitch

ChatSage utilizza un meccanismo sicuro di aggiornamento dei token per mantenere l'autenticazione con Twitch:

### Autenticazione IRC del Bot

1.  **Configurazione Iniziale per il Token IRC del Bot**:
    -   Vai su [Twitch Token Generator](https://twitchtokengenerator.com)
    -   Seleziona gli scope richiesti: `chat:read`, `chat:edit`
    -   Genera il token
    -   Copia il **Refresh Token** (non l'Access Token)
    -   Conserva questo Refresh Token in modo sicuro in Google Secret Manager

2.  **Configurazione di Google Secret Manager**:
    -   Crea un progetto Google Cloud se non ne hai uno
    -   Abilita l'API Secret Manager
    -   Crea un nuovo segreto per archiviare il tuo token di aggiornamento
    -   Annota il nome della risorsa: `projects/ID_TUO_PROGETTO/secrets/NOME_TUO_SEGRETO/versions/latest`
    -   Imposta questo nome della risorsa come `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` nel tuo file `.env`
    -   Assicurati che l'account di servizio che esegue la tua applicazione abbia il ruolo "Accessor segreti di Secret Manager"

3.  **Flusso di Autenticazione**:
    -   All'avvio, ChatSage recupererà il token di aggiornamento da Secret Manager
    -   Utilizzerà questo token di aggiornamento per ottenere un nuovo token di accesso da Twitch
    -   Se il token di accesso scade, verrà aggiornato automaticamente
    -   Se il token di aggiornamento stesso diventa non valido, l'applicazione registrerà un errore che richiederà un intervento manuale

### UI Web per la Gestione dei Canali

L'interfaccia web utilizza un flusso OAuth separato per consentire agli streamer di gestire il bot nel loro canale:

1.  **Configurazione di Firebase Functions**:
    -   L'UI web è costruita con Firebase Functions e Hosting
    -   Utilizza Twitch OAuth per autenticare gli streamer
    -   Quando uno streamer aggiunge o rimuove il bot, aggiorna una collezione Firestore
    -   Il bot controlla periodicamente questa collezione per determinare a quali canali unirsi o da quali uscire

2.  **Variabili d'Ambiente per l'UI Web**:
    -   `TWITCH_CLIENT_ID`: ID client dell'applicazione Twitch
    -   `TWITCH_CLIENT_SECRET`: Segreto client dell'applicazione Twitch
    -   `CALLBACK_URL`: L'URL di callback OAuth (l'URL della tua funzione deployata)
    -   `FRONTEND_URL`: L'URL della tua interfaccia web
    -   `JWT_SECRET_KEY`: Segreto per la firma dei token di autenticazione
    -   `SESSION_COOKIE_SECRET`: Segreto per i cookie di sessione

Questo approccio fornisce una maggiore sicurezza utilizzando flussi OAuth standard e non memorizzando i token direttamente nei file di configurazione. Offre inoltre agli streamer il controllo sull'aggiunta o la rimozione del bot dal loro canale.

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