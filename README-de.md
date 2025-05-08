[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)

# ChatSage

[![Lizenz](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md)

ChatSage ist ein KI-gestützter Chatbot, der für Twitch-Chat-Umgebungen in jeder Sprache entwickelt wurde. Er liefert kontextrelevante Antworten basierend auf dem Chat-Verlauf, Benutzeranfragen und Echtzeit-Stream-Informationen (aktuelles Spiel, Titel, Tags).

**[ChatSage zu deinem Twitch-Kanal hinzufügen →](https://streamsage-bot.web.app)**

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

Streamer können ChatSage jetzt einfach über die Weboberfläche zu ihrem Kanal hinzufügen oder daraus entfernen:

1.  **Besuche das ChatSage-Verwaltungsportal**:
    -   Gehe zum [ChatSage-Verwaltungsportal](https://streamsage-bot.web.app)
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

5.  **Benutzerinteraktion**:
    -   Zuschauer können mit ChatSage interagieren, indem sie ihn erwähnen: `@StreamSageTheBot hallo` (der Benutzername wird aktualisiert, um den neuen Namen, ChatSage, widerzuspiegeln, sobald Twitch es mir erlaubt)
    -   Oder durch die Verwendung verschiedener [Befehle](https://detekoi.github.io/botcommands.html) wie `!ask`, `!translate`, etc.

## Anwendungsbeispiele

### Chat-Befehle

Eine vollständige Liste der verfügbaren Befehle und deren Verwendung findest du unter [Bot-Befehlsdokumentation](https://detekoi.github.io/botcommands.html).

## Entwicklungsvoraussetzungen

* Node.js (Version 22.0.0 oder höher empfohlen)
* npm (oder yarn)

## Erste Schritte

1.  **Klone das Repository:**
    ```bash
    git clone [https://github.com/your-username/chatsage.git](https://github.com/your-username/chatsage.git)
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

1.  **Ersteinrichtung für Bot-IRC-Token**:
    -   Gehe zum [Twitch Token Generator](https://twitchtokengenerator.com)
    -   Wähle die erforderlichen Bereiche aus: `chat:read`, `chat:edit`
    -   Generiere das Token
    -   Kopiere das **Aktualisierungstoken** (nicht das Zugriffstoken)
    -   Speichere dieses Aktualisierungstoken sicher im Google Secret Manager

2.  **Google Secret Manager-Einrichtung**:
    -   Erstelle ein Google Cloud-Projekt, falls du noch keines hast
    -   Aktiviere die Secret Manager API
    -   Erstelle ein neues Secret, um dein Aktualisierungstoken zu speichern
    -   Notiere dir den Ressourcennamen: `projects/DEINE_PROJEKT_ID/secrets/DEIN_SECRET_NAME/versions/latest`
    -   Lege diesen Ressourcennamen als `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` in deiner `.env`-Datei fest
    -   Stelle sicher, dass das Dienstkonto, das deine Anwendung ausführt, die Rolle "Secret Manager Secret Accessor" hat

3.  **Authentifizierungsablauf**:
    -   Beim Start ruft ChatSage das Aktualisierungstoken vom Secret Manager ab
    -   Es verwendet dieses Aktualisierungstoken, um ein neues Zugriffstoken von Twitch zu erhalten
    -   Wenn das Zugriffstoken abläuft, wird es automatisch aktualisiert
    -   Wenn das Aktualisierungstoken selbst ungültig wird, protokolliert die Anwendung einen Fehler, der manuelles Eingreifen erfordert

### Kanalverwaltungs-Web-UI

Die Weboberfläche verwendet einen separaten OAuth-Flow, damit Streamer den Bot in ihrem Kanal verwalten können:

1.  **Firebase Functions-Einrichtung**:
    -   Die Web-UI basiert auf Firebase Functions und Hosting
    -   Sie verwendet Twitch OAuth zur Authentifizierung von Streamern
    -   Wenn ein Streamer den Bot hinzufügt oder entfernt, wird eine Firestore-Sammlung aktualisiert
    -   Der Bot überprüft diese Sammlung regelmäßig, um festzustellen, welchen Kanälen er beitreten oder welche er verlassen soll

2.  **Umgebungsvariablen für Web-UI**:
    -   `TWITCH_CLIENT_ID`: Twitch-Anwendungs-Client-ID
    -   `TWITCH_CLIENT_SECRET`: Twitch-Anwendungs-Client-Secret
    -   `CALLBACK_URL`: Die OAuth-Callback-URL (deine bereitgestellte Funktions-URL)
    -   `FRONTEND_URL`: Die URL deiner Weboberfläche
    -   `JWT_SECRET_KEY`: Secret zum Signieren von Authentifizierungstoken
    -   `SESSION_COOKIE_SECRET`: Secret für Sitzungscookies

Dieser Ansatz bietet eine bessere Sicherheit durch die Verwendung von Standard-OAuth-Flows und die Vermeidung der direkten Speicherung von Token in Konfigurationsdateien. Er gibt Streamern auch die Kontrolle über das Hinzufügen oder Entfernen des Bots aus ihrem Kanal.

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