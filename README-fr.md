[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)

# ChatSage

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md)

ChatSage est un chatbot alimenté par l'IA, conçu pour les environnements de chat Twitch dans n'importe quelle langue. Il fournit des réponses contextuellement pertinentes basées sur l'historique du chat, les requêtes des utilisateurs et les informations du stream en temps réel (jeu actuel, titre, tags).

**[Ajoutez ChatSage à votre chaîne Twitch →](https://streamsage-bot.web.app)**

## Table des Matières

- [Fonctionnalités (Capacités de Base)](#fonctionnalités-capacités-de-base)
- [Ajouter ChatSage à Votre Chaîne](#ajouter-chatsage-à-votre-chaîne)
- [Exemples d'Utilisation](#exemples-dutilisation)
- [Prérequis pour le Développement](#prérequis-pour-le-développement)
- [Pour Commencer](#pour-commencer)
- [Lancer le Bot](#lancer-le-bot)
- [Configuration](#configuration)
- [Gestion des Jetons Twitch](#gestion-des-jetons-twitch)
- [Docker](#docker)

## Fonctionnalités (Capacités de Base)

* Se connecte aux chaînes Twitch spécifiées via IRC.
* Récupère le contexte du stream en temps réel (jeu, titre, tags, images miniatures) en utilisant l'API Twitch Helix.
* Utilise le LLM Google Gemini 2.0 Flash pour la compréhension du langage naturel et la génération de réponses.
* Maintient le contexte de la conversation (historique et résumés) par chaîne.
* Prend en charge les commandes de chat personnalisées avec des niveaux de permission.
* Paramètres de langue du bot configurables pour un support multilingue des chaînes.
* Configurable via des variables d'environnement.
* Inclut une journalisation structurée adaptée aux environnements de production.
* Interface de gestion de chaînes basée sur le Web pour que les streamers ajoutent/suppriment le bot.

## Ajouter ChatSage à Votre Chaîne

Les streamers peuvent désormais facilement ajouter ou supprimer ChatSage de leur chaîne en utilisant l'interface web :

1.  **Visitez le Portail de Gestion ChatSage**:
    -   Allez sur [Portail de Gestion ChatSage](https://streamsage-bot.web.app)
    -   Cliquez sur "Se connecter avec Twitch"

2.  **Autorisez l'Application**:
    -   Vous serez redirigé vers Twitch pour autoriser ChatSage
    -   Accordez les permissions requises
    -   Ce processus est sécurisé et utilise le flux OAuth de Twitch

3.  **Gérez le Bot**:
    -   Une fois connecté, vous verrez votre tableau de bord
    -   Utilisez le bouton "Ajouter le Bot à Ma Chaîne" pour que ChatSage rejoigne votre chaîne
    -   Utilisez "Retirer le Bot de Ma Chaîne" si vous souhaitez le supprimer

4.  **Temps pour que le Bot Rejoigne**:
    -   Après avoir ajouté le bot, il devrait rejoindre votre chaîne en quelques minutes
    -   Si le bot ne rejoint pas après 10 minutes, veuillez essayer de le retirer et de l'ajouter à nouveau
    -   Important : si le bot ne répond pas, accordez-lui le statut de modérateur avec la commande « /mod StreamSageTheBot »

5.  **Interaction Utilisateur**:
    -   Les spectateurs peuvent interagir avec ChatSage en le mentionnant : `@StreamSageTheBot bonjour` (le nom d'utilisateur sera mis à jour pour refléter le nouveau nom, ChatSage, lorsque Twitch me le permettra)
    -   Ou en utilisant diverses [commandes](https://detekoi.github.io/botcommands.html) comme `!ask`, `!translate`, etc.

## Exemples d'Utilisation

### Commandes de Chat

Pour une liste complète des commandes disponibles et leur utilisation, veuillez visiter la [Documentation des Commandes du Bot](https://detekoi.github.io/botcommands.html).

## Prérequis pour le Développement

* Node.js (Version 22.0.0 ou ultérieure recommandée)
* npm (ou yarn)

## Pour Commencer

1.  **Clonez le dépôt :**
    ```bash
    git clone [https://github.com/your-username/chatsage.git](https://github.com/your-username/chatsage.git)
    cd chatsage
    ```

2.  **Installez les dépendances :**
    ```bash
    npm install
    ```
    *(Ou `yarn install` si vous préférez Yarn)*

3.  **Configurez les variables d'environnement :**
    * Copiez le fichier d'environnement d'exemple :
        ```bash
        cp .env.example .env
        ```
    * Modifiez le fichier `.env` et renseignez vos identifiants et paramètres. Référez-vous aux commentaires dans `.env.example` pour des détails sur chaque variable (nom d'utilisateur/jeton du bot Twitch, ID client/secret de l'application Twitch, clé API Gemini, chaînes à rejoindre, etc.). **Ne committez pas votre fichier `.env`.**

## Lancer le Bot

* **Développement :**
    Utilise le mode de surveillance intégré de Node pour des redémarrages automatiques lors des modifications de fichiers. Active par défaut les journaux lisibles par l'homme ("pretty") si `PINO_PRETTY_LOGGING=true` dans `.env`.
    ```bash
    npm run dev
    ```

* **Production :**
    Lance le bot en utilisant `node` standard. Génère des journaux JSON structurés adaptés aux systèmes d'agrégation de journaux.
    ```bash
    npm start
    ```

## Configuration

ChatSage est configuré principalement via des variables d'environnement. Les variables requises et optionnelles sont documentées dans le fichier `.env.example`. Les variables clés incluent :

* `TWITCH_BOT_USERNAME`: Nom d'utilisateur pour le compte Twitch du bot.
* `TWITCH_CHANNELS`: Liste des chaînes à rejoindre, séparées par des virgules. Utilisé comme solution de secours si la gestion des chaînes Firestore n'est pas disponible.
* `TWITCH_CHANNELS_SECRET_NAME`: Nom de la ressource pour la liste des chaînes dans Google Secret Manager. Utilisé comme solution de secours si la gestion des chaînes Firestore n'est pas disponible.
* `GEMINI_API_KEY`: Votre clé API pour le service Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Identifiants pour votre application Twitch enregistrée (utilisés pour les appels à l'API Helix).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Nom de la ressource pour le jeton de rafraîchissement dans Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Fréquence de rafraîchissement des données de contexte du stream.
* `LOG_LEVEL`: Contrôle la verbosité des journaux.

Assurez-vous que toutes les variables requises sont définies dans votre environnement ou votre fichier `.env` avant de lancer le bot.

## Gestion des Jetons Twitch

ChatSage utilise un mécanisme de rafraîchissement de jeton sécurisé pour maintenir l'authentification avec Twitch :

### Authentification IRC du Bot

1.  **Configuration Initiale pour le Jeton IRC du Bot**:
    -   Allez sur [Générateur de Jetons Twitch](https://twitchtokengenerator.com)
    -   Sélectionnez les permissions requises : `chat:read`, `chat:edit`
    -   Générez le jeton
    -   Copiez le **Jeton de Rafraîchissement** (pas le Jeton d'Accès)
    -   Stockez ce Jeton de Rafraîchissement de manière sécurisée dans Google Secret Manager

2.  **Configuration de Google Secret Manager**:
    -   Créez un projet Google Cloud si vous n'en avez pas
    -   Activez l'API Secret Manager
    -   Créez un nouveau secret pour stocker votre jeton de rafraîchissement
    -   Notez le nom de la ressource : `projects/VOTRE_ID_PROJET/secrets/VOTRE_NOM_SECRET/versions/latest`
    -   Définissez ce nom de ressource comme `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` dans votre fichier `.env`
    -   Assurez-vous que le compte de service exécutant votre application a le rôle "Accesseur de secrets du Secret Manager"

3.  **Flux d'Authentification**:
    -   Au démarrage, ChatSage récupérera le jeton de rafraîchissement depuis Secret Manager
    -   Il utilisera ce jeton de rafraîchissement pour obtenir un nouveau jeton d'accès de Twitch
    -   Si le jeton d'accès expire, il sera automatiquement rafraîchi
    -   Si le jeton de rafraîchissement lui-même devient invalide, l'application consignera une erreur nécessitant une intervention manuelle

### Interface Utilisateur Web de Gestion des Chaînes

L'interface web utilise un flux OAuth distinct pour permettre aux streamers de gérer le bot sur leur chaîne :

1.  **Configuration des Firebase Functions**:
    -   L'interface utilisateur web est construite avec Firebase Functions et Hosting
    -   Elle utilise Twitch OAuth pour authentifier les streamers
    -   Lorsqu'un streamer ajoute ou supprime le bot, cela met à jour une collection Firestore
    -   Le bot vérifie périodiquement cette collection pour déterminer quelles chaînes rejoindre ou quitter

2.  **Variables d'Environnement pour l'Interface Utilisateur Web**:
    -   `TWITCH_CLIENT_ID`: ID client de l'application Twitch
    -   `TWITCH_CLIENT_SECRET`: Secret client de l'application Twitch
    -   `CALLBACK_URL`: L'URL de rappel OAuth (l'URL de votre fonction déployée)
    -   `FRONTEND_URL`: L'URL de votre interface web
    -   `JWT_SECRET_KEY`: Secret pour signer les jetons d'authentification
    -   `SESSION_COOKIE_SECRET`: Secret pour les cookies de session

Cette approche offre une meilleure sécurité en utilisant des flux OAuth standard et en ne stockant pas les jetons directement dans les fichiers de configuration. Elle donne également aux streamers le contrôle sur l'ajout ou la suppression du bot de leur chaîne.

## Docker

Un `Dockerfile` est fourni pour construire une image conteneur de l'application.

1.  **Construisez l'image :**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Lancez le conteneur :**
    Vous devez passer les variables d'environnement au conteneur. Une façon est d'utiliser un fichier d'environnement :
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Assurez-vous que votre fichier `.env` est correctement rempli)*