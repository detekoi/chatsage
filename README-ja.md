[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)

# ChatSage

ChatSageは、あらゆる言語のTwitchチャット環境向けに設計されたAI搭載チャットボットです。チャット履歴、ユーザーのクエリ、リアルタイムの配信情報（現在のゲーム、タイトル、タグ）に基づいて、文脈に応じた適切な応答を提供します。

**[ChatSageをあなたのTwitchチャンネルに追加 →](https://streamsage-bot.web.app)**

[![ライセンス](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md)

## 目次 {#table-of-contents}

- [主な機能（コア機能）](#features-core-capabilities)
- [ChatSageをチャンネルに追加する方法](#adding-chatsage-to-your-channel)
- [使用例](#usage-examples)
- [開発の前提条件](#development-prerequisites)
- [はじめに](#getting-started)
- [ボットの実行](#running-the-bot)
- [設定](#configuration)
- [Twitchトークン管理](#twitch-token-management)
- [Docker](#docker)

## 主な機能（コア機能） {#features-core-capabilities}

*   指定されたTwitchチャンネルにIRC経由で接続します。
*   Twitch Helix APIを使用して、リアルタイムの配信コンテキスト（ゲーム、タイトル、タグ、サムネイル画像）を取得します。
*   自然言語理解と応答生成のために、GoogleのGemini 2.0 Flash LLMを利用します。
*   チャンネルごとに会話のコンテキスト（履歴と要約）を維持します。
*   権限レベル付きのカスタムチャットコマンドをサポートします。
*   多言語チャンネルをサポートするための、設定可能なボット言語設定。
*   環境変数を通じて設定可能です。
*   本番環境に適した構造化ロギングを含みます。
*   配信者がボットを追加/削除するためのウェブベースのチャンネル管理インターフェース。

## ChatSageをチャンネルに追加する方法 {#adding-chatsage-to-your-channel}

配信者はウェブインターフェースを使用して、自分のチャンネルからChatSageを簡単に追加または削除できるようになりました。

1.  **ChatSage管理ポータルにアクセスします**：
    -   [ChatSage管理ポータル](https://streamsage-bot.web.app) にアクセスします
    -   「Twitchでログイン」をクリックします

2.  **アプリケーションを認証します**：
    -   ChatSageを認証するためにTwitchにリダイレクトされます
    -   必要な権限を付与します
    -   このプロセスは安全で、TwitchのOAuthフローを使用します

3.  **ボットを管理します**：
    -   ログインすると、ダッシュボードが表示されます
    -   「ボットを自分のチャンネルに追加」ボタンを使用して、ChatSageをあなたのチャンネルに参加させます
    -   削除したい場合は、「ボットを自分のチャンネルから削除」を使用します

4.  **ボットの参加時間**：
    -   ボット追加後、数分以内にあなたのチャンネルに参加するはずです
    -   10分経ってもボットが参加しない場合は、一度削除してから再度追加してみてください

5.  **ユーザーインタラクション**：
    -   視聴者はChatSageにメンションすることで対話できます：`@StreamSageTheBot hello` （Twitchが許可すれば、ユーザー名は新しい名前ChatSageを反映するように更新されます）
    -   または、`!ask`や`!translate`などの様々な[コマンド](https://detekoi.github.io/botcommands.html)を使用します。

## 使用例 {#usage-examples}

### チャットコマンド {#chat-commands}

利用可能なコマンドとその使用方法の完全なリストについては、[ボットコマンドドキュメント](https://detekoi.github.io/botcommands.html)をご覧ください。

## 開発の前提条件 {#development-prerequisites}

*   Node.js（バージョン22.0.0以降を推奨）
*   npm（またはyarn）

## はじめに {#getting-started}

1.  **リポジトリをクローンします：**
    ```bash
    git clone https://github.com/your-username/chatsage.git
    cd chatsage
    ```

2.  **依存関係をインストールします：**
    ```bash
    npm install
    ```
    *（Yarnを使用する場合は `yarn install`）*

3.  **環境変数を設定します：**
    *   環境ファイルの例をコピーします：
        ```bash
        cp .env.example .env
        ```
    *   `.env`ファイルを編集し、認証情報と設定を記入します。各変数の詳細については、`.env.example`内のコメントを参照してください（Twitchボットのユーザー名/トークン、TwitchアプリケーションのクライアントID/シークレット、Gemini APIキー、参加するチャンネルなど）。**`.env`ファイルはコミットしないでください。**

## ボットの実行 {#running-the-bot}

*   **開発：**
    Node.jsの組み込みウォッチモードを使用して、ファイル変更時に自動的に再起動します。`.env`で`PINO_PRETTY_LOGGING=true`が設定されている場合、デフォルトで人間が読める形式（「pretty」）のログが有効になります。
    ```bash
    npm run dev
    ```

*   **本番：**
    標準の`node`を使用してボットを実行します。ログ集約システムに適した構造化JSONログを出力します。
    ```bash
    npm start
    ```

## 設定 {#configuration}

ChatSageは主に環境変数を通じて設定されます。必須およびオプションの変数は、`.env.example`ファイルに記載されています。主要な変数には以下が含まれます：

*   `TWITCH_BOT_USERNAME`: ボットのTwitchアカウントのユーザー名。
*   `TWITCH_CHANNELS`: 参加するチャンネルのコンマ区切りリスト。Firestoreチャンネル管理が利用できない場合のフォールバックとして使用されます。
*   `TWITCH_CHANNELS_SECRET_NAME`: Google Secret Manager内のチャンネルリストのリソース名。Firestoreチャンネル管理が利用できない場合のフォールバックとして使用されます。
*   `GEMINI_API_KEY`: Google GeminiサービスのAPIキー。
*   `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: 登録済みのTwitchアプリケーションの認証情報（Helix API呼び出しに使用）。
*   `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Google Secret Manager内のリフレッシュトークンのリソース名。
*   `STREAM_INFO_FETCH_INTERVAL_SECONDS`: 配信コンテキストデータを更新する頻度（秒単位）。
*   `LOG_LEVEL`: ログの詳細度を制御します。

ボットを実行する前に、必要なすべての変数が環境または`.env`ファイルに設定されていることを確認してください。

## Twitchトークン管理 {#twitch-token-management}

ChatSageは、Twitchとの認証を維持するために安全なトークン更新メカニズムを使用します：

### ボットIRC認証 {#bot-irc-authentication}

1.  **ボットIRCトークンの初期設定**：
    -   [Twitch Token Generator](https://twitchtokengenerator.com) にアクセスします
    -   必要なスコープを選択します：`chat:read`, `chat:edit`
    -   トークンを生成します
    -   **リフレッシュトークン**（アクセストークンではない）をコピーします
    -   このリフレッシュトークンをGoogle Secret Managerに安全に保存します

2.  **Google Secret Managerの設定**：
    -   Google Cloudプロジェクトがない場合は作成します
    -   Secret Manager APIを有効にします
    -   リフレッシュトークンを保存するための新しいシークレットを作成します
    -   リソース名をメモします：`projects/YOUR_PROJECT_ID/secrets/YOUR_SECRET_NAME/versions/latest`
    -   このリソース名を`.env`ファイルの`TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`として設定します
    -   アプリケーションを実行するサービスアカウントに「Secret Managerのシークレットアクセサー」ロールがあることを確認します

3.  **認証フロー**：
    -   起動時、ChatSageはSecret Managerからリフレッシュトークンを取得します
    -   このリフレッシュトークンを使用して、Twitchから新しいアクセストークンを取得します
    -   アクセストークンが期限切れになると、自動的に更新されます
    -   リフレッシュトークン自体が無効になった場合、アプリケーションは手動介入が必要なエラーをログに記録します

### チャンネル管理ウェブUI {#channel-management-web-ui}

ウェブインターフェースは、配信者が自分のチャンネルでボットを管理できるように、別のOAuthフローを使用します：

1.  **Firebase Functionsの設定**：
    -   ウェブUIはFirebase FunctionsとHostingで構築されています
    -   配信者を認証するためにTwitch OAuthを使用します
    -   配信者がボットを追加または削除すると、Firestoreコレクションが更新されます
    -   ボットはこのコレクションを定期的にチェックして、参加または退出するチャンネルを決定します

2.  **ウェブUIの環境変数**：
    -   `TWITCH_CLIENT_ID`: TwitchアプリケーションのクライアントID
    -   `TWITCH_CLIENT_SECRET`: Twitchアプリケーションのクライアントシークレット
    -   `CALLBACK_URL`: OAuthコールバックURL（デプロイされた関数のURL）
    -   `FRONTEND_URL`: ウェブインターフェースのURL
    -   `JWT_SECRET_KEY`: 認証トークン署名用のシークレット
    -   `SESSION_COOKIE_SECRET`: セッションクッキー用のシークレット

このアプローチは、標準のOAuthフローを使用し、トークンを設定ファイルに直接保存しないことで、セキュリティを向上させます。また、配信者が自分のチャンネルからボットを追加または削除する制御も可能にします。

## Docker {#docker}

アプリケーションのコンテナイメージをビルドするための`Dockerfile`が提供されています。

1.  **イメージをビルドします：**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **コンテナを実行します：**
    環境変数をコンテナに渡す必要があります。一つの方法は環境ファイルを使用することです：
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *（`.env`ファイルが正しく設定されていることを確認してください）*