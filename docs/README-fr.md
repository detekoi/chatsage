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

> Important : L'accès à la version cloud de ChatSage est actuellement limité (allow-list). Le tableau de bord en libre-service est désactivé pour les chaînes non approuvées. Si vous souhaitez essayer le bot, veuillez me contacter ici : [Formulaire de contact](https://detekoi.github.io/#contact-me).

**[Ajoutez ChatSage à votre chaîne Twitch →](https://streamsage-bot.web.app)**

[![License](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](../LICENSE.md)

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

Remarque : Seules les chaînes approuvées (allow-list) peuvent activer ChatSage. Si votre chaîne n'est pas encore approuvée, mais que vous souhaitez l'essayer, contactez-moi via le [Formulaire de contact](https://detekoi.github.io/#contact-me).

Si votre chaîne est approuvée, vous pouvez ajouter ou supprimer ChatSage via l'interface web :

1.  **Visitez le Portail de Gestion ChatSage**:
    -   Allez sur [Portail de Gestion ChatSage](https://streamsage-bot.web.app) (uniquement pour les chaînes approuvées)
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
* `TWITCH_CHANNELS`: Liste des chaînes à rejoindre, séparées par des virgules. Utilisé comme solution de secours si la gestion des chaînes Firestore n'est pas disponible.
* `TWITCH_CHANNELS_SECRET_NAME`: Nom de la ressource pour la liste des chaînes dans Google Secret Manager. Utilisé comme solution de secours si la gestion des chaînes Firestore n'est pas disponible.
* `GEMINI_API_KEY`: Votre clé API pour le service Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Identifiants pour votre application Twitch enregistrée (utilisés pour les appels à l'API Helix).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Nom de la ressource pour le jeton de rafraîchissement dans Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Fréquence de rafraîchissement des données de contexte du stream.
* `LOG_LEVEL`: Contrôle la verbosité des journaux.

Assurez-vous que toutes les variables requises sont définies dans votre environnement ou votre fichier `.env` avant de lancer le bot.

## Gestion des Jetons Twitch

ChatSage utilise un mécanisme sécurisé de renouvellement de jeton pour maintenir l'authentification avec Twitch :

### Authentification IRC du Bot

1.  **Prérequis pour la Génération de Jeton** :
    *   **Application Twitch** : Assurez-vous d'avoir enregistré une application sur la [Console Développeur Twitch](https://dev.twitch.tv/console/). Notez votre **ID Client** et générez un **Secret Client**.
    *   **URI de Redirection OAuth** : Dans les paramètres de votre application Twitch, ajoutez `http://localhost:3000` comme URL de redirection OAuth. La CLI Twitch l'utilise spécifiquement comme première URL de redirection par défaut.
    *   **CLI Twitch** : Installez la [CLI Twitch](https://dev.twitch.tv/docs/cli/install) sur votre machine locale.

2.  **Configurer la CLI Twitch** :
    *   Ouvrez votre terminal ou invite de commandes.
    *   Exécutez `twitch configure`.
    *   Lorsque vous y êtes invité, entrez l'**ID Client** et le **Secret Client** de votre application Twitch.

3.  **Générer un Jeton d'Accès Utilisateur et un Jeton de Rafraîchissement à l'aide de la CLI Twitch** :
    *   Exécutez la commande suivante dans votre terminal. Remplacez `<vos_scopes>` par une liste d'autorisations requises pour votre bot, séparées par des espaces. Pour ChatSage, vous avez besoin au minimum de `chat:read` et `chat:edit`.
        ```bash
        twitch token -u -s 'chat:read chat:edit'
        ```
        *(Vous pouvez ajouter d'autres autorisations si les commandes personnalisées de votre bot en ont besoin, par exemple, `channel:manage:polls channel:read:subscriptions`)*
    *   La CLI affichera une URL. Copiez cette URL et collez-la dans votre navigateur web.
    *   Connectez-vous à Twitch en utilisant le **compte Twitch que vous souhaitez que le bot utilise**.
    *   Autorisez votre application pour les autorisations demandées.
    *   Après autorisation, Twitch redirigera votre navigateur vers `http://localhost:3000`. La CLI, qui exécute temporairement un serveur local, capturera le code d'autorisation et l'échangera contre des jetons.
    *   La CLI affichera alors le `Jeton d'Accès Utilisateur`, le `Jeton de Rafraîchissement`, la `Date d'Expiration` (pour le jeton d'accès) et les `Autorisations` accordées.

4.  **Stocker le Jeton de Rafraîchissement en Toute Sécurité** :
    *   Depuis la sortie de la CLI Twitch, copiez le **Jeton de Rafraîchissement**. C'est le jeton crucial dont votre bot a besoin pour une authentification à long terme.
    *   Stockez ce Jeton de Rafraîchissement en toute sécurité dans Google Secret Manager.

5.  **Configuration de Google Secret Manager** :
    *   Créez un projet Google Cloud si vous n'en avez pas.
    *   Activez l'API Secret Manager dans votre projet.
    *   Créez un nouveau secret dans Secret Manager pour stocker le Jeton de Rafraîchissement Twitch que vous venez d'obtenir.
    *   Notez le **Nom de Ressource** de ce secret. Il ressemblera à `projects/VOTRE_ID_PROJET/secrets/VOTRE_NOM_SECRET/versions/latest`.
    *   Définissez ce nom de ressource complet comme valeur pour la variable d'environnement `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` dans la configuration de votre bot (par exemple, dans votre fichier `.env` ou les variables d'environnement de Cloud Run).
    *   Assurez-vous que le compte de service exécutant votre application ChatSage (que ce soit localement via ADC ou dans Cloud Run) dispose du rôle IAM "Accesseur de secrets du Secret Manager" pour ce secret.

6.  **Flux d'Authentification dans ChatSage** :
    *   Au démarrage, ChatSage (plus précisément `ircAuthHelper.js`) utilisera `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` pour récupérer le jeton de rafraîchissement stocké depuis Google Secret Manager.
    *   Il utilisera ensuite ce jeton de rafraîchissement, ainsi que l'`TWITCH_CLIENT_ID` et le `TWITCH_CLIENT_SECRET` de votre application, pour obtenir un nouveau Jeton d'Accès OAuth de courte durée auprès de Twitch.
    *   Ce jeton d'accès est utilisé pour se connecter à l'IRC Twitch.
    *   Si le jeton d'accès expire ou devient invalide, le bot utilisera le jeton de rafraîchissement pour en obtenir automatiquement un nouveau.
    *   Si le jeton de rafraîchissement lui-même devient invalide (par exemple, révoqué par Twitch, changement de mot de passe utilisateur), l'application enregistrera une erreur critique, et vous devrez répéter le processus de génération de jeton (Étapes 3-4) pour obtenir un nouveau jeton de rafraîchissement.

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

- `LAZY_CONNECT=true` : Active la logique de mise à l'échelle à zéro.
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