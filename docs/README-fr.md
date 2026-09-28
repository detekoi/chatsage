[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage


ChatSage est un chatbot alimenté par l'IA, conçu pour les environnements de chat Twitch dans n'importe quelle langue. Il fournit des réponses contextuellement pertinentes basées sur l'historique du chat, les requêtes des utilisateurs et les informations du stream en temps réel (jeu actuel, titre, tags).

> Important : L'accès à la version cloud de ChatSage est actuellement limité (allow-list). Le tableau de bord en libre-service est désactivé pour les chaînes non approuvées. Si vous souhaitez essayer le bot, veuillez me contacter ici : [Formulaire de contact](https://parfaitfair.com/#contact).

**[Ajoutez ChatSage à votre chaîne Twitch →](https://bot.wildcat.chat)**

[![License](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE.md)

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

* Reçoit les messages de chat via les webhooks Twitch EventSub et envoie des réponses via l'API Twitch Helix.
* Récupère le contexte du stream en temps réel (jeu, titre, tags, images miniatures) en utilisant l'API Twitch Helix.
* Utilise le LLM Google Gemini 3 Flash pour la compréhension du langage naturel et la génération de réponses (les commandes légères comme `!lurk` et `!translate` utilisent Gemini 2.5 Flash Lite pour la vitesse et l'efficacité des coûts).
* Maintient le contexte de la conversation (historique et résumés) par chaîne.
* Prend en charge les commandes de chat personnalisées avec des niveaux de permission.
* Paramètres de langue du bot configurables pour un support multilingue des chaînes.
* Configurable via des variables d'environnement.
* Inclut une journalisation structurée adaptée aux environnements de production.
* Interface de gestion de chaînes basée sur le Web pour que les streamers ajoutent/suppriment le bot.

## Ajouter ChatSage à Votre Chaîne

Remarque : Seules les chaînes approuvées (allow-list) peuvent activer ChatSage. Si votre chaîne n'est pas encore approuvée, mais que vous souhaitez l'essayer, contactez-moi via le [Formulaire de contact](https://parfaitfair.com/#contact).

Si votre chaîne est approuvée, vous pouvez ajouter ou supprimer ChatSage via l'interface web :

1.  **Visitez le Portail de Gestion ChatSage**:
    -   Allez sur [Portail de Gestion ChatSage](https://bot.wildcat.chat) (uniquement pour les chaînes approuvées)
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
    -   Important : si le bot ne répond pas, accordez-lui le statut de modérateur avec la commande « /mod ChatSageBot »

5.  **Interaction Utilisateur**:
    -   Les spectateurs peuvent interagir avec ChatSage en le mentionnant : `@ChatSageBot bonjour` (le nom d'utilisateur sera mis à jour pour refléter le nouveau nom, ChatSage, lorsque Twitch me le permettra)
    -   Ou en utilisant diverses [commandes](https://docs.wildcat.chat/botcommands.html) comme `!ask`, `!translate`, etc.

## Exemples d'Utilisation

### Commandes de Chat

Pour une liste complète des commandes disponibles et leur utilisation, veuillez visiter la [Documentation des Commandes du Bot](https://docs.wildcat.chat/botcommands.html).

## Prérequis pour le Développement

* Node.js (Version 22.0.0 ou ultérieure recommandée)
* npm (ou yarn)

## Pour Commencer

1.  **Clonez le dépôt :**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
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
* `TWITCH_CHANNELS`: Liste des chaînes à rejoindre, séparées par des virgules, en développement local. En production, le bot charge sa liste de chaînes depuis Firestore.
* `GEMINI_API_KEY`: Votre clé API pour le service Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Identifiants pour votre application Twitch enregistrée (utilisés pour les appels à l'API Helix).
* `TWITCH_BOT_REFRESH_TOKEN`: Jeton de rafraîchissement du compte du bot. Le bot l'utilise pour envoyer des annonces de chat en son propre nom. En production, Cloud Run le charge depuis le secret `TWITCH_BOT_REFRESH_TOKEN` dans Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Fréquence de rafraîchissement des données de contexte du stream.
* `LOG_LEVEL`: Contrôle la verbosité des journaux.

Assurez-vous que toutes les variables requises sont définies dans votre environnement ou votre fichier `.env` avant de lancer le bot.

## Gestion des Jetons Twitch

ChatSage utilise un mécanisme sécurisé de renouvellement de jeton pour maintenir l'authentification avec Twitch :

### Authentification du Bot

ChatSage utilise deux types de jeton Twitch :

*   Un **jeton d'accès d'application** pour la plupart des appels Helix, y compris l'envoi de messages de chat. ChatSage l'obtient à partir de `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET`. Vous n'avez rien à configurer.
*   Un **jeton d'accès utilisateur pour le compte du bot** pour les annonces de chat. Twitch refuse les jetons d'accès d'application sur l'endpoint des annonces.

Pour configurer le jeton utilisateur du bot :

1.  **Prérequis** :
    *   Enregistrez une application sur la [Console Développeur Twitch](https://dev.twitch.tv/console/). Notez votre **ID Client** et votre **Secret Client**.
    *   Dans les paramètres de votre application Twitch, ajoutez `http://localhost:3456/callback` comme URL de redirection OAuth.
    *   Définissez `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` dans votre fichier `.env`.

2.  **Générer le jeton de rafraîchissement** :
    *   Exécutez `node scripts/get-user-token.js`.
    *   Connectez-vous à Twitch avec le compte du bot et autorisez les scopes demandés. Les scopes incluent `moderator:manage:announcements`.
    *   Le script affiche le jeton d'accès et le jeton de rafraîchissement.

3.  **Stocker le jeton de rafraîchissement** :
    *   Pour le développement local, définissez `TWITCH_BOT_REFRESH_TOKEN` dans votre fichier `.env`.
    *   Pour la production, ajoutez le jeton de rafraîchissement comme nouvelle version du secret `TWITCH_BOT_REFRESH_TOKEN` dans Google Secret Manager. Le workflow de déploiement monte ce secret comme variable d'environnement `TWITCH_BOT_REFRESH_TOKEN`. Accordez le rôle IAM `Secret Manager Secret Accessor` au compte de service qui exécute ChatSage.

4.  **Faites du bot un modérateur** dans chaque chaîne où il doit envoyer des annonces. Dans une chaîne où le bot n'est pas modérateur, ChatSage envoie les annonces avec le jeton du diffuseur ; elles apparaissent alors comme venant du diffuseur.

Quand le jeton d'accès du bot expire, ChatSage en demande un nouveau avec le jeton de rafraîchissement. Si le jeton de rafraîchissement devient invalide, exécutez à nouveau `scripts/get-user-token.js` et ajoutez une nouvelle version du secret.

### Interface Utilisateur Web de Gestion des Chaînes

L'[interface web](https://github.com/detekoi/chatsage-web-ui) utilise un flux OAuth distinct pour permettre aux streamers de gérer le bot sur leur chaîne :

1.  **Configuration des Firebase Functions** :
    *   L'interface utilisateur web est construite avec Firebase Functions et Hosting.
    *   Elle utilise Twitch OAuth pour authentifier les streamers.
    *   Lorsqu'un streamer ajoute ou supprime le bot, cela met à jour une collection Firestore.
    *   Le bot vérifie périodiquement cette collection pour déterminer quelles chaînes rejoindre ou quitter.

2.  **Variables d'Environnement pour l'Interface Utilisateur Web** :
    *   `TWITCH_CLIENT_ID` : ID client de l'application Twitch.
    *   `TWITCH_CLIENT_SECRET` : Secret client de l'application Twitch.
    *   `CALLBACK_URL` : L'URL de rappel OAuth (l'URL de votre fonction déployée).
    *   `FRONTEND_URL` : L'URL de votre interface web.
    *   `JWT_SECRET_KEY` : Secret pour signer les jetons d'authentification.
    *   `SESSION_COOKIE_SECRET` : Secret pour les cookies de session.

Cette approche offre une meilleure sécurité en utilisant des flux OAuth standard et des outils officiels, et en ne stockant pas les jetons sensibles directement dans les fichiers de configuration lorsque cela est possible. Elle donne également aux streamers le contrôle sur l'ajout ou la suppression du bot de leur chaîne.

<details>
<summary><strong>EventSub pour Déploiement Serverless (Optionnel)</strong></summary>

Ce projet prend en charge EventSub de Twitch pour permettre un déploiement "scale-to-zero" sans serveur sur des plateformes comme Google Cloud Run. Cela réduit considérablement les coûts d'hébergement en n'exécutant le bot que lorsqu'un canal dans lequel il se trouve est en direct.

### Aperçu

- **Comment ça marche :** Le bot s'abonne aux événements `stream.online`. Lorsqu'un streamer commence sa diffusion, Twitch envoie un webhook qui démarre l'instance du bot. Le bot reste actif pendant la diffusion et se met à l'échelle jusqu'à zéro instance lorsque toutes les chaînes surveillées sont hors ligne.
- **Économies de coûts :** Ce modèle peut réduire considérablement les coûts d'hébergement.

### Variables d'Environnement Requises

Pour activer cette fonctionnalité, définissez les éléments suivants dans votre environnement de déploiement (par exemple, Cloud Run) :

- `TWITCH_EVENTSUB_SECRET` : Une chaîne secrète longue et aléatoire que vous créez pour sécuriser votre point de terminaison de webhook.
- `PUBLIC_URL` : L'URL publique de votre service déployé (par exemple, `https://your-service.a.run.app`).

### Processus de Configuration

1.  **Déployer avec les Variables EventSub :**
    Déployez votre application avec les variables d'environnement listées ci-dessus. Pour Cloud Run, vous utiliseriez `gcloud run deploy` avec `--set-env-vars`.

2.  **S'abonner aux Événements :**
    Après le déploiement, exécutez le script de gestion pour abonner toutes vos chaînes à l'événement `stream.online`.
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **Vérifier les Abonnements :**
    Vous pouvez vérifier que les abonnements ont été créés avec succès :
    ```bash
    node scripts/manage-eventsub.js list
    ```

Cette configuration garantit que le bot ne consomme des ressources que lorsqu'il doit être actif dans un canal en direct.

</details>

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