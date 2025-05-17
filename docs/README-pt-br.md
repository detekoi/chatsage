[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage

ChatSage é um chatbot alimentado por IA projetado para ambientes de chat da Twitch em qualquer idioma. Ele fornece respostas contextualmente relevantes com base no histórico do chat, consultas de usuários e informações da transmissão em tempo real (jogo atual, título, tags).

**[Adicione o ChatSage ao seu canal da Twitch →](https://streamsage-bot.web.app)**

[![Licença](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](../LICENSE.md)

## Índice

- [Recursos (Capacidades Principais)](#recursos-capacidades-principais)
- [Adicionando o ChatSage ao Seu Canal](#adicionando-o-chatsage-ao-seu-canal)
- [Exemplos de Uso](#exemplos-de-uso)
- [Pré-requisitos de Desenvolvimento](#pré-requisitos-de-desenvolvimento)
- [Começando](#começando)
- [Executando o Bot](#executando-o-bot)
- [Configuração](#configuração)
- [Gerenciamento de Tokens da Twitch](#gerenciamento-de-tokens-da-twitch)
- [Docker](#docker)

## Recursos (Capacidades Principais)

* Conecta-se aos canais especificados da Twitch via IRC.
* Busca contexto da transmissão em tempo real (jogo, título, tags, imagens de miniatura) usando a API Twitch Helix.
* Utiliza o LLM Gemini 2.0 Flash do Google para compreensão de linguagem natural e geração de respostas.
* Mantém o contexto da conversa (histórico e resumos) por canal.
* Suporta comandos de chat personalizados com níveis de permissão.
* Configurações de idioma do bot configuráveis para suporte a canais multilíngues.
* Configurável através de variáveis de ambiente.
* Inclui logging estruturado adequado para ambientes de produção.
* Interface de gerenciamento de canais baseada na web para streamers adicionarem/removerem o bot.

## Adicionando o ChatSage ao Seu Canal

Streamers agora podem adicionar ou remover facilmente o ChatSage de seu canal usando a interface web:

1.  **Visite o Portal de Gerenciamento do ChatSage**:
    * Vá para [Portal de Gerenciamento do ChatSage](https://streamsage-bot.web.app)
    * Clique em "Login com a Twitch"

2.  **Autorize o Aplicativo**:
    * Você será redirecionado para a Twitch para autorizar o ChatSage
    * Conceda as permissões necessárias
    * Este processo é seguro e usa o fluxo OAuth da Twitch

3.  **Gerencie o Bot**:
    * Uma vez logado, você verá seu painel
    * Use o botão "Adicionar Bot ao Meu Canal" para que o ChatSage entre no seu canal
    * Use "Remover Bot do Meu Canal" se quiser removê-lo

4.  **Tempo para o Bot Entrar**:
    * Após adicionar o bot, ele deve entrar no seu canal em alguns minutos
    * Se o bot não entrar após 10 minutos, por favor, tente remover e adicionar novamente
    * Importante: se o bot não responder, conceda status de moderador com o comando "/mod StreamSageTheBot"

5.  **Interação do Usuário**:
    * Os espectadores podem interagir com o ChatSage mencionando-o: `@StreamSageTheBot olá` (o nome de usuário será atualizado para refletir o novo nome, ChatSage, quando a Twitch me permitir)
    * Ou usando vários [comandos](https://detekoi.github.io/botcommands.html) como `!ask`, `!translate`, etc.

## Exemplos de Uso

### Comandos de Chat

Para uma lista completa dos comandos disponíveis e seu uso, visite a [Documentação dos Comandos do Bot](https://detekoi.github.io/botcommands.html).

## Pré-requisitos de Desenvolvimento

* Node.js (Versão 22.0.0 ou posterior recomendada)
* npm (ou yarn)

## Começando

1.  **Clone o repositório:**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
    cd chatsage
    ```

2.  **Instale as dependências:**
    ```bash
    npm install
    ```
    *(Ou `yarn install` se você preferir o Yarn)*

3.  **Configure as variáveis de ambiente:**
    * Copie o arquivo de ambiente de exemplo:
        ```bash
        cp .env.example .env
        ```
    * Edite o arquivo `.env` e preencha suas credenciais e configurações. Consulte os comentários dentro de `.env.example` para detalhes sobre cada variável (nome de usuário/token do bot da Twitch, ID de cliente/segredo do aplicativo Twitch, chave da API Gemini, canais para entrar, etc.). **Não envie seu arquivo `.env` para o controle de versão.**

## Executando o Bot

* **Desenvolvimento:**
    Usa o modo de observação integrado do Node para reinícios automáticos em alterações de arquivo. Habilita logs legíveis por humanos ("pretty") por padrão se `PINO_PRETTY_LOGGING=true` em `.env`.
    ```bash
    npm run dev
    ```

* **Produção:**
    Executa o bot usando `node` padrão. Emite logs JSON estruturados adequados para sistemas de agregação de logs.
    ```bash
    npm start
    ```

## Configuração

O ChatSage é configurado principalmente através de variáveis de ambiente. As variáveis obrigatórias e opcionais estão documentadas no arquivo `.env.example`. As variáveis chave incluem:

* `TWITCH_BOT_USERNAME`: Nome de usuário para a conta Twitch do bot.
* `TWITCH_CHANNELS`: Lista de canais separados por vírgula para entrar. Usado como fallback se o gerenciamento de canais do Firestore não estiver disponível.
* `TWITCH_CHANNELS_SECRET_NAME`: Nome do recurso para a lista de canais no Google Secret Manager. Usado como fallback se o gerenciamento de canais do Firestore não estiver disponível.
* `GEMINI_API_KEY`: Sua chave de API para o serviço Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenciais para seu aplicativo Twitch registrado (usado para chamadas da API Twitch Helix).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Nome do recurso para o token de atualização no Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Com que frequência atualizar os dados de contexto da transmissão.
* `LOG_LEVEL`: Controla a verbosidade dos logs.

Certifique-se de que todas as variáveis obrigatórias estejam definidas em seu ambiente ou arquivo `.env` antes de executar o bot.

## Gerenciamento de Tokens da Twitch

O ChatSage usa um mecanismo seguro de atualização de token para manter a autenticação com a Twitch:

### Autenticação IRC do Bot

1.  **Pré-requisitos para Geração de Token**:
    *   **Aplicativo Twitch**: Certifique-se de ter registrado um aplicativo no [Console do Desenvolvedor Twitch](https://dev.twitch.tv/console/). Anote seu **ID de Cliente** e gere um **Segredo do Cliente**.
    *   **URI de Redirecionamento OAuth**: Nas configurações do seu Aplicativo Twitch, adicione `http://localhost:3000` como um URL de Redirecionamento OAuth. A CLI da Twitch usa especificamente este como o primeiro URL de redirecionamento por padrão.
    *   **CLI da Twitch**: Instale a [CLI da Twitch](https://dev.twitch.tv/docs/cli/install) em sua máquina local.

2.  **Configurar a CLI da Twitch**:
    *   Abra seu terminal ou prompt de comando.
    *   Execute `twitch configure`.
    *   Quando solicitado, insira o **ID de Cliente** e o **Segredo do Cliente** do seu Aplicativo Twitch.

3.  **Gerar Token de Acesso do Usuário e Token de Atualização usando a CLI da Twitch**:
    *   Execute o seguinte comando em seu terminal. Substitua `<seus_escopos>` por uma lista de escopos necessários para o seu bot, separados por espaço. Para o ChatSage, você precisa de pelo menos `chat:read` e `chat:edit`.
        ```bash
        twitch token -u -s 'chat:read chat:edit'
        ```
        *(Você pode adicionar outros escopos se os comandos personalizados do seu bot precisarem deles, por exemplo, `channel:manage:polls channel:read:subscriptions`)*
    *   A CLI exibirá uma URL. Copie esta URL e cole-a em seu navegador da web.
    *   Faça login na Twitch usando a **conta da Twitch que você deseja que o bot use**.
    *   Autorize seu aplicativo para os escopos solicitados.
    *   Após a autorização, a Twitch redirecionará seu navegador para `http://localhost:3000`. A CLI, que executa temporariamente um servidor local, capturará o código de autorização e o trocará por tokens.
    *   A CLI então imprimirá o `Token de Acesso do Usuário`, o `Token de Atualização`, `Expira Em` (para o token de acesso) e os `Escopos` concedidos.

4.  **Armazenar o Token de Atualização com Segurança**:
    *   Na saída da CLI da Twitch, copie o **Token de Atualização**. Este é o token crucial que seu bot precisa para autenticação de longo prazo.
    *   Armazene este Token de Atualização com segurança no Google Secret Manager.

5.  **Configuração do Google Secret Manager**:
    *   Crie um Projeto Google Cloud se você não tiver um.
    *   Ative a API Secret Manager em seu projeto.
    *   Crie um novo segredo no Secret Manager para armazenar o Token de Atualização da Twitch que você acabou de obter.
    *   Anote o **Nome do Recurso** deste segredo. Ele será parecido com `projects/SEU_ID_DO_PROJETO/secrets/SEU_NOME_DO_SEGREDO/versions/latest`.
    *   Defina este nome de recurso completo como o valor para a variável de ambiente `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` na configuração do seu bot (por exemplo, em seu arquivo `.env` ou variáveis de ambiente do Cloud Run).
    *   Certifique-se de que a conta de serviço que executa seu aplicativo ChatSage (seja localmente via ADC ou no Cloud Run) tenha a função IAM "Acessor de Segredos do Secret Manager" para este segredo.

6.  **Fluxo de Autenticação no ChatSage**:
    *   Na inicialização, o ChatSage (especificamente `ircAuthHelper.js`) usará o `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` para buscar o token de atualização armazenado do Google Secret Manager.
    *   Ele então usará este token de atualização, juntamente com o `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET` do seu aplicativo, para obter um novo Token de Acesso OAuth de curta duração da Twitch.
    *   Este token de acesso é usado para conectar-se ao IRC da Twitch.
    *   Se o token de acesso expirar ou se tornar inválido, o bot usará o token de atualização para obter um novo automaticamente.
    *   Se o próprio token de atualização se tornar inválido (por exemplo, revogado pela Twitch, alteração da senha do usuário), o aplicativo registrará um erro crítico e você precisará repetir o processo de geração de token (Passos 3-4) para obter um novo token de atualização.

### Interface Web de Gerenciamento de Canais

A [interface web](https://github.com/detekoi/chatsage-web-ui) usa um fluxo OAuth separado para permitir que os streamers gerenciem o bot em seu canal:

1.  **Configuração do Firebase Functions**:
    *   A interface do usuário da web é construída com Firebase Functions e Hosting.
    *   Usa o OAuth da Twitch para autenticar streamers.
    *   Quando um streamer adiciona ou remove o bot, ele atualiza uma coleção do Firestore.
    *   O bot verifica periodicamente esta coleção para determinar em quais canais entrar ou sair.

2.  **Variáveis de Ambiente para a Interface Web**:
    *   `TWITCH_CLIENT_ID`: ID de cliente do aplicativo Twitch.
    *   `TWITCH_CLIENT_SECRET`: Segredo do cliente do aplicativo Twitch.
    *   `CALLBACK_URL`: A URL de retorno de chamada OAuth (URL da sua função implantada).
    *   `FRONTEND_URL`: A URL da sua interface web.
    *   `JWT_SECRET_KEY`: Segredo para assinar tokens de autenticação.
    *   `SESSION_COOKIE_SECRET`: Segredo para cookies de sessão.

Esta abordagem fornece melhor segurança usando fluxos OAuth padrão e ferramentas oficiais, e não armazenando tokens sensíveis diretamente em arquivos de configuração quando possível. Também dá aos streamers controle sobre adicionar ou remover o bot de seu canal.

## Docker

Um `Dockerfile` é fornecido para construir uma imagem de contêiner da aplicação.

1.  **Construa a imagem:**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Execute o contêiner:**
    Você precisa passar as variáveis de ambiente para o contêiner. Uma maneira é usando um arquivo de ambiente:
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Certifique-se de que seu arquivo `.env` esteja preenchido corretamente)*