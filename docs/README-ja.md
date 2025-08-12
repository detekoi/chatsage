[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage

ChatSageは、あらゆる言語のTwitchチャット環境向けに設計されたAI搭載チャットボットです。チャット履歴、ユーザーのクエリ、リアルタイムの配信情報（現在のゲーム、タイトル、タグ）に基づいて、文脈に応じた適切な応答を提供します。

> 重要: 現在、ChatSageへのアクセスは招待制（許可リスト）です。未承認のチャンネル向けのセルフサービスダッシュボードは無効になっています。ボットを試したい場合は、こちらからご連絡ください: [お問い合わせフォーム](https://detekoi.github.io/#contact-me)。

**[ChatSageをあなたのTwitchチャンネルに追加 →](https://streamsage-bot.web.app)**

[![ライセンス](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](../LICENSE.md)

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

注意: 許可リストにある承認済みチャンネルのみがChatSageを有効にできます。まだ承認されていないが試したい場合は、[お問い合わせフォーム](https://detekoi.github.io/#contact-me)からご連絡ください。

承認済みのチャンネルは、以下の手順でWebインターフェースから追加/削除できます。

1.  **ChatSage管理ポータルにアクセスします**：
    -   [ChatSage管理ポータル](https://streamsage-bot.web.app) にアクセスします（承認済みチャンネルのみ）
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
    -   重要: ボットが反応しない場合、「/mod ChatSageBot」コマンドでモデレーター権限を付与してください

5.  **ユーザーインタラクション**：
    -   視聴者はChatSageにメンションすることで対話できます：`@ChatSageBot hello` （Twitchが許可すれば、ユーザー名は新しい名前ChatSageを反映するように更新されます）
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
    git clone https://github.com/detekoi/chatsage.git
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

ChatSageは、Twitchとの認証を維持するために安全なトークン更新メカニズムを使用します。

### ボットIRC認証 {#bot-irc-authentication}

1.  **トークン生成の前提条件**：
    *   **Twitchアプリケーション**：[Twitch開発者コンソール](https://dev.twitch.tv/console/)でアプリケーションを登録していることを確認してください。**クライアントID**をメモし、**クライアントシークレット**を生成します。
    *   **OAuthリダイレクトURI**：Twitchアプリケーション設定で、OAuthリダイレクトURLとして`http://localhost:3000`を追加します。Twitch CLIは、デフォルトでこれを最初のリダイレクトURLとして具体的に使用します。
    *   **Twitch CLI**：ローカルマシンに[Twitch CLI](https://dev.twitch.tv/docs/cli/install)をインストールします。

2.  **Twitch CLIの設定**：
    *   ターミナルまたはコマンドプロンプトを開きます。
    *   `twitch configure`を実行します。
    *   プロンプトが表示されたら、Twitchアプリケーションの**クライアントID**と**クライアントシークレット**を入力します。

3.  **Twitch CLIを使用したユーザーアクセストークンと更新トークンの生成**：
    *   ターミナルで次のコマンドを実行します。`<your_scopes>`を、ボットに必要なスコープのスペース区切りリストに置き換えます。ChatSageの場合、少なくとも`chat:read`と`chat:edit`が必要です。
        ```bash
        twitch token -u -s 'chat:read chat:edit'
        ```
        *（ボットのカスタムコマンドで他のスコープが必要な場合は追加できます。例：`channel:manage:polls channel:read:subscriptions`）*
    *   CLIはURLを出力します。このURLをコピーしてウェブブラウザに貼り付けます。
    *   **ボットが使用するTwitchアカウント**でTwitchにログインします。
    *   要求されたスコープに対してアプリケーションを承認します。
    *   承認後、Twitchはブラウザを`http://localhost:3000`にリダイレクトします。一時的にローカルサーバーを実行するCLIが認証コードをキャプチャし、トークンと交換します。
    *   その後、CLIは`ユーザーアクセストークン`、`更新トークン`、`有効期限`（アクセストークン用）、および付与された`スコープ`を出力します。

4.  **更新トークンの安全な保存**：
    *   Twitch CLIの出力から**更新トークン**をコピーします。これは、ボットが長期的な認証に必要とする重要なトークンです。
    *   この更新トークンをGoogle Secret Managerに安全に保存します。

5.  **Google Secret Managerの設定**：
    *   Google Cloudプロジェクトがない場合は作成します。
    *   プロジェクトでSecret Manager APIを有効にします。
    *   取得したTwitch更新トークンを保存するために、Secret Managerで新しいシークレットを作成します。
    *   このシークレットの**リソース名**をメモします。`projects/YOUR_PROJECT_ID/secrets/YOUR_SECRET_NAME/versions/latest`のようになります。
    *   ボットの設定（`.env`ファイルやCloud Runの環境変数など）で、この完全なリソース名を`TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`環境変数の値として設定します。
    *   ChatSageアプリケーションを実行しているサービスアカウント（ローカルのADC経由またはCloud Run内）が、このシークレットに対する「Secret Managerのシークレットアクセサー」IAMロールを持っていることを確認します。

6.  **ChatSageでの認証フロー**：
    *   起動時、ChatSage（具体的には`ircAuthHelper.js`）は`TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`を使用して、Google Secret Managerから保存されている更新トークンを取得します。
    *   次に、この更新トークンをアプリケーションの`TWITCH_CLIENT_ID`および`TWITCH_CLIENT_SECRET`とともに使用して、Twitchから新しい短命のOAuthアクセストークンを取得します。
    *   このアクセストークンはTwitch IRCへの接続に使用されます。
    *   アクセストークンが期限切れになったり無効になったりした場合、ボットは更新トークンを使用して自動的に新しいトークンを取得します。
    *   更新トークン自体が無効になった場合（例：Twitchによる取り消し、ユーザーパスワードの変更）、アプリケーションは重大なエラーをログに記録し、新しい更新トークンを取得するためにトークン生成プロセス（手順3〜4）を繰り返す必要があります。

### チャンネル管理ウェブUI {#channel-management-web-ui}

[ウェブインターフェース](https://github.com/detekoi/chatsage-web-ui)は、配信者が自分のチャンネルでボットを管理できるように、別のOAuthフローを使用します：

1.  **Firebase Functionsの設定**：
    *   ウェブUIはFirebase FunctionsとHostingで構築されています。
    *   配信者を認証するためにTwitch OAuthを使用します。
    *   配信者がボットを追加または削除すると、Firestoreコレクションが更新されます。
    *   ボットはこのコレクションを定期的にチェックして、参加または退出するチャンネルを決定します。

2.  **ウェブUIの環境変数**：
    *   `TWITCH_CLIENT_ID`: TwitchアプリケーションのクライアントID。
    *   `TWITCH_CLIENT_SECRET`: Twitchアプリケーションのクライアントシークレット。
    *   `CALLBACK_URL`: OAuthコールバックURL（デプロイされた関数のURL）。
    *   `FRONTEND_URL`: ウェブインターフェースのURL。
    *   `JWT_SECRET_KEY`: 認証トークン署名用のシークレット。
    *   `SESSION_COOKIE_SECRET`: セッションクッキー用のシークレット。

このアプローチは、標準のOAuthフローと公式ツールを使用し、可能な場合は機密性の高いトークンを設定ファイルに直接保存しないことで、セキュリティを向上させます。また、配信者が自分のチャンネルからボットを追加または削除する制御も可能にします。

<details>
<summary><strong>サーバーレスデプロイメントのためのEventSub（オプション）</strong></summary>

このプロジェクトは、TwitchのEventSubをサポートしており、Google Cloud Runなどのプラットフォームで「スケールトゥゼロ」のサーバーレスデプロイメントを可能にします。これにより、ボットが参加しているチャンネルがライブのときだけボットを実行することで、ホスティングコストを大幅に削減します。

### 概要

- **仕組み：** ボットは`stream.online`イベントを購読します。ストリーマーがライブを開始すると、Twitchはボットインスタンスを起動するWebhookを送信します。ボットはストリームがライブの間アクティブであり、監視対象のすべてのチャンネルがオフラインになるとゼロインスタンスにスケールダウンします。
- **コスト削減：** このモデルは、ホスティングコストを大幅に削減できます。

### 必要な環境変数

この機能を有効にするには、デプロイメント環境（例：Cloud Run）で以下を設定します。

- `LAZY_CONNECT=true`：スケールトゥゼロのロジックを有効にします。
- `TWITCH_EVENTSUB_SECRET`：Webhookエンドポイントを保護するために作成する、長くてランダムな秘密の文字列。
- `PUBLIC_URL`：デプロイされたサービスの公開URL（例：`https://your-service.a.run.app`）。

### セットアッププロセス

1.  **EventSub変数を使用してデプロイ：**
    上記の環境変数を使用してアプリケーションをデプロイします。Cloud Runの場合、`gcloud run deploy`と`--set-env-vars`を使用します。

2.  **イベントを購読：**
    デプロイ後、管理スクリプトを実行して、すべてのチャンネルを`stream.online`イベントに購読します。
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **購読を確認：**
    購読が正常に作成されたことを確認できます。
    ```bash
    node scripts/manage-eventsub.js list
    ```

この設定により、ボットはライブチャンネルでアクティブになる必要がある場合にのみリソースを消費するようになります。

</details>

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