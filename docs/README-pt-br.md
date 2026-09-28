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

> Importante: O acesso à versão em nuvem do ChatSage é, no momento, somente por convite (lista de permitidos/allow-list). O painel de autoatendimento está desativado para canais não aprovados. Se você deseja testar o bot, entre em contato aqui: [Formulário de contato](https://parfaitfair.com/#contact).

**[Adicione o ChatSage ao seu canal da Twitch →](https://bot.wildcat.chat)**

[![Licença](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE.md)

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

* Recebe mensagens de chat via webhooks do Twitch EventSub e envia respostas pela API Twitch Helix.
* Busca contexto da transmissão em tempo real (jogo, título, tags, imagens de miniatura) usando a API Twitch Helix.
* Utiliza o LLM Gemini 3 Flash do Google para compreensão de linguagem natural e geração de respostas (comandos leves como `!lurk` e `!translate` usam o Gemini 2.5 Flash Lite para velocidade e eficiência de custos).
* Mantém o contexto da conversa (histórico e resumos) por canal.
* Suporta comandos de chat personalizados com níveis de permissão.
* Configurações de idioma do bot configuráveis para suporte a canais multilíngues.
* Configurável através de variáveis de ambiente.
* Inclui logging estruturado adequado para ambientes de produção.
* Interface de gerenciamento de canais baseada na web para streamers adicionarem/removerem o bot.

## Adicionando o ChatSage ao Seu Canal

Observação: Apenas canais aprovados na allow-list podem habilitar o ChatSage. Se o seu canal ainda não foi aprovado mas você quer testar, fale comigo pelo [Formulário de contato](https://parfaitfair.com/#contact).

Se o seu canal é aprovado, você pode adicionar ou remover o ChatSage usando a interface web:

1.  **Visite o Portal de Gerenciamento do ChatSage**:
    * Vá para [Portal de Gerenciamento do ChatSage](https://bot.wildcat.chat) (apenas canais aprovados)
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
    * Importante: se o bot não responder, conceda status de moderador com o comando "/mod ChatSageBot"

5.  **Interação do Usuário**:
    * Os espectadores podem interagir com o ChatSage mencionando-o: `@ChatSageBot olá` (o nome de usuário será atualizado para refletir o novo nome, ChatSage, quando a Twitch me permitir)
    * Ou usando vários [comandos](https://docs.wildcat.chat/botcommands.html) como `!ask`, `!translate`, etc.

## Exemplos de Uso

### Comandos de Chat

Para uma lista completa dos comandos disponíveis e seu uso, visite a [Documentação dos Comandos do Bot](https://docs.wildcat.chat/botcommands.html).

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
* `TWITCH_CHANNELS`: Lista de canais separados por vírgula para entrar, no desenvolvimento local. Em produção, o bot carrega sua lista de canais do Firestore.
* `GEMINI_API_KEY`: Sua chave de API para o serviço Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenciais para seu aplicativo Twitch registrado (usado para chamadas da API Twitch Helix).
* `TWITCH_BOT_REFRESH_TOKEN`: Token de atualização da conta do bot. O bot o usa para enviar anúncios no chat em seu próprio nome. Em produção, o Cloud Run o carrega do secret `TWITCH_BOT_REFRESH_TOKEN` no Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Com que frequência atualizar os dados de contexto da transmissão.
* `LOG_LEVEL`: Controla a verbosidade dos logs.

Certifique-se de que todas as variáveis obrigatórias estejam definidas em seu ambiente ou arquivo `.env` antes de executar o bot.

## Gerenciamento de Tokens da Twitch

O ChatSage usa um mecanismo seguro de atualização de token para manter a autenticação com a Twitch:

### Autenticação do Bot

O ChatSage usa dois tipos de token da Twitch:

*   Um **token de acesso de aplicativo** para a maioria das chamadas Helix, incluindo o envio de mensagens no chat. O ChatSage o obtém a partir de `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET`. Você não precisa configurá-lo.
*   Um **token de acesso de usuário para a conta do bot** para os anúncios no chat. A Twitch rejeita tokens de acesso de aplicativo no endpoint de anúncios.

Para configurar o token de usuário do bot:

1.  **Pré-requisitos**:
    *   Registre um aplicativo no [Console do Desenvolvedor Twitch](https://dev.twitch.tv/console/). Anote seu **ID de Cliente** e seu **Segredo do Cliente**.
    *   Nas configurações do seu aplicativo Twitch, adicione `http://localhost:3456/callback` como URL de Redirecionamento OAuth.
    *   Defina `TWITCH_CLIENT_ID` e `TWITCH_CLIENT_SECRET` no seu arquivo `.env`.

2.  **Gerar o token de atualização**:
    *   Execute `node scripts/get-user-token.js`.
    *   Entre na Twitch com a conta do bot e autorize os escopos solicitados. Os escopos incluem `moderator:manage:announcements`.
    *   O script exibe o token de acesso e o token de atualização.

3.  **Armazenar o token de atualização**:
    *   Para desenvolvimento local, defina `TWITCH_BOT_REFRESH_TOKEN` no seu arquivo `.env`.
    *   Para produção, adicione o token de atualização como uma nova versão do secret `TWITCH_BOT_REFRESH_TOKEN` no Google Secret Manager. O workflow de deploy monta esse secret como a variável de ambiente `TWITCH_BOT_REFRESH_TOKEN`. Conceda o papel do IAM `Secret Manager Secret Accessor` à conta de serviço que executa o ChatSage.

4.  **Torne o bot moderador** em cada canal onde ele deve enviar anúncios. Em um canal onde o bot não é moderador, o ChatSage envia os anúncios com o token do broadcaster, então eles aparecem como enviados pelo broadcaster.

Quando o token de acesso do bot expira, o ChatSage solicita um novo com o token de atualização. Se o token de atualização se tornar inválido, execute `scripts/get-user-token.js` novamente e adicione uma nova versão do secret.

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

<details>
<summary><strong>EventSub para Implantação sem Servidor (Opcional)</strong></summary>

Este projeto suporta o EventSub da Twitch para permitir uma implantação "scale-to-zero" sem servidor em plataformas como o Google Cloud Run. Isso reduz significativamente os custos de hospedagem, executando o bot apenas quando um canal em que ele está está ao vivo.

### Visão geral

- **Como funciona:** O bot se inscreve nos eventos `stream.online`. Quando um streamer entra ao vivo, a Twitch envia um webhook que inicia a instância do bot. O bot permanece ativo enquanto a transmissão está ao vivo e escala para zero instâncias quando todos os canais monitorados estão offline.
- **Economia de custos:** Este modelo pode reduzir significativamente os custos de hospedagem.

### Variáveis de Ambiente Necessárias

Para habilitar este recurso, defina o seguinte em seu ambiente de implantação (por exemplo, Cloud Run):

- `TWITCH_EVENTSUB_SECRET`: Uma string secreta longa e aleatória que você cria para proteger seu endpoint de webhook.
- `PUBLIC_URL`: A URL pública do seu serviço implantado (por exemplo, `https://your-service.a.run.app`).

### Processo de Configuração

1.  **Implantar com Variáveis EventSub:**
    Implante sua aplicação com as variáveis de ambiente listadas acima. Para o Cloud Run, você usaria `gcloud run deploy` com `--set-env-vars`.

2.  **Inscrever-se em Eventos:**
    Após a implantação, execute o script de gerenciamento para inscrever todos os seus canais no evento `stream.online`.
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **Verificar Inscrições:**
    Você pode verificar se as inscrições foram criadas com sucesso:
    ```bash
    node scripts/manage-eventsub.js list
    ```

Esta configuração garante que o bot consuma recursos apenas quando precisar estar ativo em um canal ao vivo.

</details>

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