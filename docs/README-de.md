[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage


ChatSage ist ein KI-gestützter Chatbot, der für Twitch-Chat-Umgebungen in jeder Sprache entwickelt wurde. Er liefert kontextrelevante Antworten basierend auf dem Chat-Verlauf, Benutzeranfragen und Echtzeit-Stream-Informationen (aktuelles Spiel, Titel, Tags).

> Wichtig: Der Zugang zur Cloud-Version von ChatSage ist derzeit nur über eine Allowlist (Einladung) möglich. Das Self-Service-Web-Dashboard ist für nicht genehmigte Kanäle deaktiviert. Wenn du den Bot ausprobieren möchtest, kontaktiere mich bitte hier: [Kontaktformular](https://detekoi.github.io/#contact-me).

**[ChatSage zu deinem Twitch-Kanal hinzufügen →](https://streamsage-bot.web.app)**

[![Lizenz](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](../LICENSE.md)

## Inhaltsverzeichnis

- [Funktionen (Kernfunktionen)](#funktionen-kernfunktionen)
- [ChatSage zu deinem Kanal hinzufügen](#chatsage-zu-deinem-kanal-hinzufügen)
- [Anwendungsbeispiele](#anwendungsbeispiele)
- [Entwicklungsvoraussetzungen](#entwicklungsvoraussetzungen)
- [Erste Schritte](#erste-schritte)
- [Den Bot ausführen](#den-bot-ausführen)
- [Konfiguration](#konfiguration)
- [Twitch-Token-Verwaltung](#twitch-token-verwaltung)
- [Docker](#docker)

## Funktionen (Kernfunktionen)

* Verbindet sich über IRC mit den angegebenen Twitch-Kanälen.
* Ruft Echtzeit-Stream-Kontext (Spiel, Titel, Tags, Vorschaubilder) über die Twitch Helix API ab.
* Verwendet Google Gemini 2.0 Flash LLM für das Verstehen natürlicher Sprache und die Generierung von Antworten.
* Pflegt den Gesprächskontext (Verlauf und Zusammenfassungen) pro Kanal.
* Unterstützt benutzerdefinierte Chat-Befehle mit Berechtigungsstufen.
* Konfigurierbare Bot-Spracheinstellungen für mehrsprachige Kanalunterstützung.
* Konfigurierbar über Umgebungsvariablen.
* Enthält strukturierte Protokollierung, die für Produktionsumgebungen geeignet ist.
* Webbasierte Kanalverwaltungsoberfläche für Streamer zum Hinzufügen/Entfernen des Bots.

## ChatSage zu deinem Kanal hinzufügen

Hinweis: Nur vorab genehmigte Kanäle auf der Allowlist können ChatSage aktivieren. Wenn dein Kanal noch nicht freigeschaltet ist, du den Bot aber testen möchtest, melde dich bitte über das [Kontaktformular](https://detekoi.github.io/#contact-me).

Wenn dein Kanal genehmigt ist, kannst du ChatSage über die Weboberfläche hinzufügen oder entfernen:

1.  **Besuche das ChatSage-Verwaltungsportal**:
    -   Gehe zum [ChatSage-Verwaltungsportal](https://streamsage-bot.web.app) (nur für freigeschaltete Kanäle)
    -   Klicke auf "Mit Twitch anmelden"

2.  **Autorisiere die Anwendung**:
    -   Du wirst zu Twitch weitergeleitet, um ChatSage zu autorisieren
    -   Erteile die erforderlichen Berechtigungen
    -   Dieser Vorgang ist sicher und verwendet den OAuth-Flow von Twitch

3.  **Verwalte den Bot**:
    -   Sobald du angemeldet bist, siehst du dein Dashboard
    -   Verwende die Schaltfläche "Bot zu meinem Kanal hinzufügen", damit ChatSage deinem Kanal beitritt
    -   Verwende "Bot von meinem Kanal entfernen", wenn du ihn entfernen möchtest

4.  **Beitrittszeit des Bots**:
    -   Nach dem Hinzufügen des Bots sollte er deinem Kanal innerhalb weniger Minuten beitreten
    -   Wenn der Bot nach 10 Minuten nicht beitritt, versuche bitte, ihn zu entfernen und erneut hinzuzufügen
    -   Wichtig: Falls der Bot nicht reagiert, gib ihm Mod-Status mit dem Befehl „/mod ChatSageBot“

5.  **Benutzerinteraktion**:
    -   Zuschauer können mit ChatSage interagieren, indem sie ihn erwähnen: `@ChatSageBot hallo` (der Benutzername wird aktualisiert, um den neuen Namen, ChatSage, widerzuspiegeln, sobald Twitch es mir erlaubt)
    -   Oder durch die Verwendung verschiedener [Befehle](https://docs.wildcat.chat/botcommands.html) wie `!ask`, `!translate`, etc.

## Anwendungsbeispiele

### Chat-Befehle

Eine vollständige Liste der verfügbaren Befehle und deren Verwendung findest du unter [Bot-Befehlsdokumentation](https://docs.wildcat.chat/botcommands.html).

## Entwicklungsvoraussetzungen

* Node.js (Version 22.0.0 oder höher empfohlen)
* npm (oder yarn)

## Erste Schritte

1.  **Klone das Repository:**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
    cd chatsage
    ```

2.  **Installiere Abhängigkeiten:**
    ```bash
    npm install
    ```
    *(Oder `yarn install`, wenn du Yarn bevorzugst)*

3.  **Konfiguriere Umgebungsvariablen:**
    * Kopiere die Beispiel-Umgebungsdatei:
        ```bash
        cp .env.example .env
        ```
    * Bearbeite die `.env`-Datei und gib deine Anmeldeinformationen und Einstellungen ein. Beachte die Kommentare in `.env.example` für Details zu jeder Variablen (Twitch-Bot-Benutzername/-Token, Twitch-Anwendungs-Client-ID/-Secret, Gemini-API-Schlüssel, beizutretende Kanäle usw.). **Commite deine `.env`-Datei nicht.**

## Den Bot ausführen

* **Entwicklung:**
    Verwendet den integrierten Watch-Modus von Node für automatische Neustarts bei Dateiänderungen. Aktiviert standardmäßig menschenlesbare ("pretty") Protokolle, wenn `PINO_PRETTY_LOGGING=true` in `.env` gesetzt ist.
    ```bash
    npm run dev
    ```

* **Produktion:**
    Führt den Bot mit Standard-`node` aus. Gibt strukturierte JSON-Protokolle aus, die für Protokollaggregationssysteme geeignet sind.
    ```bash
    npm start
    ```

## Konfiguration

ChatSage wird hauptsächlich über Umgebungsvariablen konfiguriert. Die erforderlichen und optionalen Variablen sind in der Datei `.env.example` dokumentiert. Wichtige Variablen sind:

* `TWITCH_BOT_USERNAME`: Benutzername für das Twitch-Konto des Bots.
* `TWITCH_CHANNELS`: Durch Kommas getrennte Liste der Kanäle, denen beigetreten werden soll. Wird als Fallback verwendet, wenn die Firestore-Kanalverwaltung nicht verfügbar ist.
* `TWITCH_CHANNELS_SECRET_NAME`: Ressourcenname für die Kanalliste im Google Secret Manager. Wird als Fallback verwendet, wenn die Firestore-Kanalverwaltung nicht verfügbar ist.
* `GEMINI_API_KEY`: Dein API-Schlüssel für den Google Gemini-Dienst.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Anmeldeinformationen für deine registrierte Twitch-Anwendung (verwendet für Helix-API-Aufrufe).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Ressourcenname für das Aktualisierungstoken im Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Wie oft Stream-Kontextdaten aktualisiert werden sollen.
* `LOG_LEVEL`: Steuert die Ausführlichkeit der Protokolle.

Stelle sicher, dass alle erforderlichen Variablen in deiner Umgebung oder `.env`-Datei festgelegt sind, bevor du den Bot ausführst.

## Twitch-Token-Verwaltung

ChatSage verwendet einen sicheren Token-Aktualisierungsmechanismus, um die Authentifizierung mit Twitch aufrechtzuerhalten:

### Bot-IRC-Authentifizierung

1.  **Voraussetzungen für die Token-Generierung**:
    *   **Twitch-Anwendung**: Stellen Sie sicher, dass Sie eine Anwendung in der [Twitch Developer Console](https://dev.twitch.tv/console/) registriert haben. Notieren Sie Ihre **Client-ID** und generieren Sie ein **Client-Secret**.
    *   **OAuth Redirect URI**: Fügen Sie in Ihren Twitch-Anwendungseinstellungen `http://localhost:3000` als OAuth Redirect URL hinzu. Die Twitch CLI verwendet dies standardmäßig als erste Redirect-URL.
    *   **Twitch CLI**: Installieren Sie die [Twitch CLI](https://dev.twitch.tv/docs/cli/install) auf Ihrem lokalen Rechner.

2.  **Twitch CLI konfigurieren**:
    *   Öffnen Sie Ihr Terminal oder Ihre Eingabeaufforderung.
    *   Führen Sie `twitch configure` aus.
    *   Geben Sie bei Aufforderung die **Client-ID** und das **Client-Secret** Ihrer Twitch-Anwendung ein.

3.  **Benutzerzugriffstoken und Aktualisierungstoken mit der Twitch CLI generieren**:
    *   Führen Sie den folgenden Befehl in Ihrem Terminal aus. Ersetzen Sie `<your_scopes>` durch eine durch Leerzeichen getrennte Liste der für Ihren Bot erforderlichen Bereiche. Für ChatSage benötigen Sie mindestens `chat:read` und `chat:edit`.
        ```bash
        twitch token -u -s 'chat:read chat:edit'
        ```
        *(Sie können weitere Bereiche hinzufügen, wenn die benutzerdefinierten Befehle Ihres Bots diese benötigen, z. B. `channel:manage:polls channel:read:subscriptions`)*
    *   Die CLI gibt eine URL aus. Kopieren Sie diese URL und fügen Sie sie in Ihren Webbrowser ein.
    *   Melden Sie sich bei Twitch mit dem **Twitch-Konto an, das der Bot verwenden soll**.
    *   Autorisieren Sie Ihre Anwendung für die angeforderten Bereiche.
    *   Nach der Autorisierung leitet Twitch Ihren Browser zu `http://localhost:3000` weiter. Die CLI, die vorübergehend einen lokalen Server ausführt, erfasst den Autorisierungscode und tauscht ihn gegen Token aus.
    *   Die CLI gibt dann das `Benutzerzugriffstoken`, das `Aktualisierungstoken`, `Läuft ab am` (für das Zugriffstoken) und die gewährten `Bereiche` aus.

4.  **Aktualisierungstoken sicher speichern**:
    *   Kopieren Sie aus der Twitch CLI-Ausgabe das **Aktualisierungstoken**. Dies ist das entscheidende Token, das Ihr Bot für die langfristige Authentifizierung benötigt.
    *   Speichern Sie dieses Aktualisierungstoken sicher im Google Secret Manager.

5.  **Google Secret Manager-Einrichtung**:
    *   Erstellen Sie ein Google Cloud-Projekt, falls Sie noch keines haben.
    *   Aktivieren Sie die Secret Manager API in Ihrem Projekt.
    *   Erstellen Sie ein neues Secret im Secret Manager, um das gerade erhaltene Twitch-Aktualisierungstoken zu speichern.
    *   Notieren Sie sich den **Ressourcennamen** dieses Secrets. Er sieht etwa so aus: `projects/IHR_PROJEKT_ID/secrets/IHR_SECRET_NAME/versions/latest`.
    *   Legen Sie diesen vollständigen Ressourcennamen als Wert für die Umgebungsvariable `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` in der Konfiguration Ihres Bots fest (z. B. in Ihrer `.env`-Datei oder den Umgebungsvariablen von Cloud Run).
    *   Stellen Sie sicher, dass das Dienstkonto, das Ihre ChatSage-Anwendung ausführt (entweder lokal über ADC oder in Cloud Run), die IAM-Rolle "Secret Manager Secret Accessor" für dieses Secret hat.

6.  **Authentifizierungsablauf in ChatSage**:
    *   Beim Start verwendet ChatSage (insbesondere `ircAuthHelper.js`) den `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`, um das gespeicherte Aktualisierungstoken vom Google Secret Manager abzurufen.
    *   Anschließend verwendet es dieses Aktualisierungstoken zusammen mit der `TWITCH_CLIENT_ID` und dem `TWITCH_CLIENT_SECRET` Ihrer Anwendung, um ein neues, kurzlebiges OAuth-Zugriffstoken von Twitch zu erhalten.
    *   Dieses Zugriffstoken wird verwendet, um eine Verbindung zum Twitch IRC herzustellen.
    *   Wenn das Zugriffstoken abläuft oder ungültig wird, verwendet der Bot das Aktualisierungstoken, um automatisch ein neues zu erhalten.
    *   Wenn das Aktualisierungstoken selbst ungültig wird (z. B. von Twitch widerrufen, Benutzerpasswortänderung), protokolliert die Anwendung einen kritischen Fehler, und Sie müssen den Token-Generierungsprozess (Schritte 3-4) wiederholen, um ein neues Aktualisierungstoken zu erhalten.

### Kanalverwaltungs-Web-UI

Die [Weboberfläche](https://github.com/detekoi/chatsage-web-ui) verwendet einen separaten OAuth-Flow, damit Streamer den Bot in ihrem Kanal verwalten können:

1.  **Firebase Functions-Einrichtung**:
    -   Die Web-UI basiert auf Firebase Functions und Hosting.
    -   Sie verwendet Twitch OAuth zur Authentifizierung von Streamern.
    -   Wenn ein Streamer den Bot hinzufügt oder entfernt, wird eine Firestore-Sammlung aktualisiert.
    -   Der Bot überprüft diese Sammlung regelmäßig, um festzustellen, welchen Kanälen er beitreten oder welche er verlassen soll.

2.  **Umgebungsvariablen für Web-UI**:
    -   `TWITCH_CLIENT_ID`: Twitch-Anwendungs-Client-ID.
    -   `TWITCH_CLIENT_SECRET`: Twitch-Anwendungs-Client-Secret.
    -   `CALLBACK_URL`: Die OAuth-Callback-URL (Ihre bereitgestellte Funktions-URL).
    -   `FRONTEND_URL`: Die URL Ihrer Weboberfläche.
    -   `JWT_SECRET_KEY`: Secret zum Signieren von Authentifizierungstoken.
    -   `SESSION_COOKIE_SECRET`: Secret für Sitzungscookies.

Dieser Ansatz bietet eine bessere Sicherheit durch die Verwendung von Standard-OAuth-Flows und offiziellen Tools und vermeidet die direkte Speicherung sensibler Token in Konfigurationsdateien, wo immer möglich. Er gibt Streamern auch die Kontrolle über das Hinzufügen oder Entfernen des Bots aus ihrem Kanal.

<details>
<summary><strong>EventSub für Serverless-Bereitstellung (Optional)</strong></summary>

Dieses Projekt unterstützt Twitchs EventSub, um eine "Scale-to-Zero"-Serverless-Bereitstellung auf Plattformen wie Google Cloud Run zu ermöglichen. Dies reduziert die Hosting-Kosten erheblich, da der Bot nur ausgeführt wird, wenn ein Kanal, in dem er sich befindet, live ist.

### Übersicht

- **Wie es funktioniert:** Der Bot abonniert `stream.online`-Events. Wenn ein Streamer live geht, sendet Twitch einen Webhook, der die Bot-Instanz startet. Der Bot bleibt aktiv, während der Stream live ist, und skaliert auf null Instanzen herunter, wenn alle überwachten Kanäle offline sind.
- **Kostenersparnis:** Dieses Modell kann die Hosting-Kosten erheblich senken.

### Erforderliche Umgebungsvariablen

Um diese Funktion zu aktivieren, setzen Sie Folgendes in Ihrer Bereitstellungsumgebung (z. B. Cloud Run):

- `LAZY_CONNECT=true`: Aktiviert die Scale-to-Zero-Logik.
- `TWITCH_EVENTSUB_SECRET`: Eine lange, zufällige, geheime Zeichenfolge, die Sie erstellen, um Ihren Webhook-Endpunkt zu sichern.
- `PUBLIC_URL`: Die öffentlich zugängliche URL Ihres bereitgestellten Dienstes (z. B. `https://your-service.a.run.app`).

### Einrichtungsprozess

1.  **Mit EventSub-Variablen bereitstellen:**
    Stellen Sie Ihre Anwendung mit den oben aufgeführten Umgebungsvariablen bereit. Für Cloud Run würden Sie `gcloud run deploy` mit `--set-env-vars` verwenden.

2.  **Events abonnieren:**
    Führen Sie nach der Bereitstellung das Verwaltungsskript aus, um alle Ihre Kanäle für das `stream.online`-Event zu abonnieren.
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **Abonnements überprüfen:**
    Sie können überprüfen, ob die Abonnements erfolgreich erstellt wurden:
    ```bash
    node scripts/manage-eventsub.js list
    ```

Diese Einrichtung stellt sicher, dass der Bot nur dann Ressourcen verbraucht, wenn er in einem Live-Kanal aktiv sein muss.

</details>

## Docker

Eine `Dockerfile` wird zum Erstellen eines Container-Images der Anwendung bereitgestellt.

1.  **Erstelle das Image:**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Führe den Container aus:**
    Du musst die Umgebungsvariablen an den Container übergeben. Eine Möglichkeit ist die Verwendung einer Umgebungsdatei:
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Stelle sicher, dass deine `.env`-Datei korrekt ausgefüllt ist)*