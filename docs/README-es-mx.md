[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](../README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)
[![Русский](https://img.shields.io/badge/lang-Русский-lightcoral?style=flat)](README-ru.md)

# ChatSage

ChatSage es un chatbot impulsado por IA diseñado para entornos de chat de Twitch en cualquier idioma. Proporciona respuestas contextualmente relevantes basadas en el historial del chat, las consultas de los usuarios y la información del stream en tiempo real (juego actual, título, etiquetas).

> Importante: El acceso a la versión en la nube de ChatSage actualmente es solo por invitación mediante una lista de permitidos (allow-list). El panel de autoservicio está desactivado para canales no aprobados. Si deseas probar el bot, contáctame aquí: [Formulario de contacto](https://parfaitfair.com/#contact).

**[Agrega ChatSage a tu canal de Twitch →](https://bot.wildcat.chat)**

[![Licencia](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../LICENSE.md)

## Tabla de Contenidos

- [Características (Capacidades Principales)](#características-capacidades-principales)
- [Agregar ChatSage a Tu Canal](#agregar-chatsage-a-tu-canal)
- [Ejemplos de Uso](#ejemplos-de-uso)
- [Prerrequisitos de Desarrollo](#prerrequisitos-de-desarrollo)
- [Primeros Pasos](#primeros-pasos)
- [Ejecutar el Bot](#ejecutar-el-bot)
- [Configuración](#configuración)
- [Gestión de Tokens de Twitch](#gestión-de-tokens-de-twitch)
- [Docker](#docker)

## Características (Capacidades Principales)

* Recibe mensajes de chat a través de webhooks de Twitch EventSub y envía respuestas mediante la API Helix de Twitch.
* Obtiene el contexto del stream en tiempo real (juego, título, etiquetas, imágenes en miniatura) utilizando la API Helix de Twitch.
* Utiliza el LLM Google Gemini 3 Flash para la comprensión del lenguaje natural y la generación de respuestas (los comandos ligeros como `!lurk` y `!translate` usan Gemini 2.5 Flash Lite para mayor velocidad y eficiencia de costos).
* Mantiene el contexto de la conversación (historial y resúmenes) por canal.
* Admite comandos de chat personalizados con niveles de permiso.
* Configuraciones de idioma del bot ajustables para soporte de canales multilingües.
* Configurable a través de variables de entorno.
* Incluye registro estructurado adecuado para entornos de producción.
* Interfaz de gestión de canales basada en web para que los streamers agreguen/eliminen el bot.

## Agregar ChatSage a Tu Canal

Nota: Solo los canales aprobados en la allow-list pueden habilitar ChatSage. Si tu canal aún no está aprobado pero quieres probarlo, escríbeme por el [Formulario de contacto](https://parfaitfair.com/#contact).

Si tu canal está aprobado, puedes agregar o quitar ChatSage usando la interfaz web:

1. **Visita el Portal de Gestión de ChatSage**:
   - Ve al [Portal de Gestión de ChatSage](https://bot.wildcat.chat) (solo canales aprobados)
   - Haz clic en "Iniciar sesión con Twitch"

2. **Autoriza la Aplicación**:
   - Serás redirigido a Twitch para autorizar a ChatSage.
   - Otorga los permisos requeridos.
   - Este proceso es seguro y utiliza el flujo OAuth de Twitch.

3. **Gestiona el Bot**:
   - Una vez iniciada la sesión, verás tu panel de control.
   - Usa el botón "Agregar Bot a Mi Canal" para que ChatSage se una a tu canal.
   - Usa "Eliminar Bot de Mi Canal" si deseas quitarlo.

4. **Tiempo para que el Bot se Una**:
   - Después de agregar el bot, debería unirse a tu canal en unos pocos minutos.
   - Si el bot no se une después de 10 minutos, intenta eliminarlo y agregarlo nuevamente.
   - Importante: si el bot no responde, asígnale el estado de moderador con el comando "/mod ChatSageBot"

5. **Interacción del Usuario**:
   - Los espectadores pueden interactuar con ChatSage mencionándolo: `@ChatSageBot hola` (el nombre de usuario se actualizará para reflejar el nuevo nombre, ChatSage, cuando Twitch me lo permita).
   - O usando varios [comandos](https://docs.wildcat.chat/botcommands.html) como `!ask`, `!translate`, etc.

## Ejemplos de Uso

### Comandos de Chat

Para obtener una lista completa de los comandos disponibles y su uso, visita la [Documentación de Comandos del Bot](https://docs.wildcat.chat/botcommands.html).

## Prerrequisitos de Desarrollo

* Node.js (Se recomienda la Versión 22.0.0 o posterior)
* npm (o yarn)

## Primeros Pasos

1.  **Clona el repositorio:**
    ```bash
    git clone https://github.com/detekoi/chatsage.git
    cd chatsage
    ```

2.  **Instala las dependencias:**
    ```bash
    npm install
    ```
    *(O `yarn install` si prefieres Yarn)*

3.  **Configura las variables de entorno:**
    * Copia el archivo de ejemplo de entorno:
        ```bash
        cp .env.example .env
        ```
    * Edita el archivo `.env` y completa tus credenciales y configuraciones. Consulta los comentarios dentro de `.env.example` para obtener detalles sobre cada variable (nombre de usuario/token del bot de Twitch, ID de cliente/secreto de la aplicación de Twitch, clave API de Gemini, canales a los que unirse, etc.). **No subas tu archivo `.env` al repositorio.**

## Ejecutar el Bot

* **Desarrollo:**
    Usa el modo de vigilancia incorporado de Node para reinicios automáticos al cambiar archivos. Habilita registros legibles por humanos ("pretty") de forma predeterminada si `PINO_PRETTY_LOGGING=true` está en `.env`.
    ```bash
    npm run dev
    ```

* **Producción:**
    Ejecuta el bot usando `node` estándar. Genera registros JSON estructurados adecuados para sistemas de agregación de registros.
    ```bash
    npm start
    ```

## Configuración

ChatSage se configura principalmente a través de variables de entorno. Las variables requeridas y opcionales están documentadas en el archivo `.env.example`. Las variables clave incluyen:

* `TWITCH_BOT_USERNAME`: Nombre de usuario para la cuenta de Twitch del bot.
* `TWITCH_CHANNELS`: Lista de canales a los que unirse, separados por comas, para el desarrollo local. En producción, el bot carga su lista de canales desde Firestore.
* `GEMINI_API_KEY`: Tu clave API para el servicio Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenciales para tu aplicación de Twitch registrada (utilizadas para llamadas a la API Helix).
* `TWITCH_BOT_REFRESH_TOKEN`: Token de actualización de la cuenta del bot. El bot lo usa para enviar anuncios de chat en su propio nombre. En producción, Cloud Run lo carga desde el secreto `TWITCH_BOT_REFRESH_TOKEN` en Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Con qué frecuencia actualizar los datos del contexto del stream.
* `LOG_LEVEL`: Controla la verbosidad de los registros.

Asegúrate de que todas las variables requeridas estén configuradas en tu entorno o en el archivo `.env` antes de ejecutar el bot.

## Gestión de Tokens de Twitch

ChatSage utiliza un mecanismo seguro de actualización de tokens para mantener la autenticación con Twitch:

### Autenticación del Bot

ChatSage usa dos tipos de token de Twitch:

*   Un **token de acceso de aplicación** para la mayoría de las llamadas a Helix, incluido el envío de mensajes de chat. ChatSage lo obtiene con `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET`. No necesitas configurarlo.
*   Un **token de acceso de usuario para la cuenta del bot** para los anuncios de chat. Twitch rechaza los tokens de acceso de aplicación en el endpoint de anuncios.

Para configurar el token de usuario del bot:

1.  **Prerrequisitos**:
    *   Registra una aplicación en la [Consola de Desarrolladores de Twitch](https://dev.twitch.tv/console/). Anota tu **ID de Cliente** y tu **Secreto de Cliente**.
    *   En la configuración de tu aplicación de Twitch, agrega `http://localhost:3456/callback` como URL de redirección OAuth.
    *   Define `TWITCH_CLIENT_ID` y `TWITCH_CLIENT_SECRET` en tu archivo `.env`.

2.  **Generar el token de actualización**:
    *   Ejecuta `node scripts/get-user-token.js`.
    *   Inicia sesión en Twitch con la cuenta del bot y autoriza los permisos solicitados. Los permisos incluyen `moderator:manage:announcements`.
    *   El script muestra el token de acceso y el token de actualización.

3.  **Guardar el token de actualización**:
    *   Para desarrollo local, define `TWITCH_BOT_REFRESH_TOKEN` en tu archivo `.env`.
    *   Para producción, agrega el token de actualización como una nueva versión del secreto `TWITCH_BOT_REFRESH_TOKEN` en Google Secret Manager. El flujo de trabajo de despliegue monta ese secreto como la variable de entorno `TWITCH_BOT_REFRESH_TOKEN`. Otorga el rol de IAM `Secret Manager Secret Accessor` a la cuenta de servicio que ejecuta ChatSage.

4.  **Haz que el bot sea moderador** en cada canal donde deba enviar anuncios. En un canal donde el bot no es moderador, ChatSage envía los anuncios con el token del broadcaster, así que aparecen como enviados por el broadcaster.

Cuando el token de acceso del bot expira, ChatSage solicita uno nuevo con el token de actualización. Si el token de actualización deja de ser válido, vuelve a ejecutar `scripts/get-user-token.js` y agrega una nueva versión del secreto.

### Interfaz de Usuario Web para la Gestión de Canales

La [interfaz web](https://github.com/detekoi/chatsage-web-ui) utiliza un flujo OAuth separado para permitir a los streamers gestionar el bot en su canal:

1.  **Configuración de Firebase Functions**:
    *   La interfaz de usuario web está construida con Firebase Functions y Hosting.
    *   Utiliza OAuth de Twitch para autenticar a los streamers.
    *   Cuando un streamer agrega o elimina el bot, actualiza una colección de Firestore.
    *   El bot verifica periódicamente esta colección para determinar a qué canales unirse o de cuáles salir.

2.  **Variables de Entorno para la Interfaz de Usuario Web**:
    *   `TWITCH_CLIENT_ID`: ID de cliente de la aplicación de Twitch.
    *   `TWITCH_CLIENT_SECRET`: Secreto de cliente de la aplicación de Twitch.
    *   `CALLBACK_URL`: La URL de devolución de llamada de OAuth (la URL de tu función desplegada).
    *   `FRONTEND_URL`: La URL de tu interfaz web.
    *   `JWT_SECRET_KEY`: Secreto para firmar tokens de autenticación.
    *   `SESSION_COOKIE_SECRET`: Secreto para las cookies de sesión.

Este enfoque proporciona mayor seguridad al utilizar flujos OAuth estándar y herramientas oficiales, y no almacenar tokens sensibles directamente en archivos de configuración cuando sea posible. También otorga a los streamers control sobre la adición o eliminación del bot de su canal.

<details>
<summary><strong>EventSub para Despliegue sin Servidor (Opcional)</strong></summary>

Este proyecto es compatible con EventSub de Twitch para permitir un despliegue sin servidor de "escalado a cero" en plataformas como Google Cloud Run. Esto reduce significativamente los costos de alojamiento al ejecutar el bot solo cuando un canal en el que se encuentra está en vivo.

### Resumen

- **Cómo funciona:** El bot se suscribe a los eventos `stream.online`. Cuando un streamer inicia una transmisión, Twitch envía un webhook que inicia la instancia del bot. El bot permanece activo mientras la transmisión está en vivo y se reduce a cero instancias cuando todos los canales monitoreados están desconectados.
- **Ahorro de costos:** Este modelo puede reducir significativamente los costos de alojamiento.

### Variables de Entorno Requeridas

Para habilitar esta función, configure lo siguiente в su entorno de despliegue (por ejemplo, Cloud Run):

- `TWITCH_EVENTSUB_SECRET`: Una cadena secreta larga y aleatoria que usted crea para asegurar su punto de conexión de webhook.
- `PUBLIC_URL`: La URL pública de su servicio desplegado (por ejemplo, `https://your-service.a.run.app`).

### Proceso de Configuración

1.  **Desplegar con Variables de EventSub:**
    Despliegue su aplicación con las variables de entorno mencionadas anteriormente. Para Cloud Run, usaría `gcloud run deploy` con `--set-env-vars`.

2.  **Suscribirse a Eventos:**
    Después de desplegar, ejecute el script de gestión para suscribir todos sus canales al evento `stream.online`.
    ```bash
    node scripts/manage-eventsub.js subscribe-all
    ```

3.  **Verificar Suscripciones:**
    Puede verificar que las suscripciones se crearon correctamente:
    ```bash
    node scripts/manage-eventsub.js list
    ```

Esta configuración garantiza que el bot solo consuma recursos cuando necesite estar activo en un canal en vivo.

</details>

## Docker

Se proporciona un `Dockerfile` para construir una imagen de contenedor de la aplicación.

1.  **Construye la imagen:**
    ```bash
    docker build -t chatsage:latest .
    ```

2.  **Ejecuta el contenedor:**
    Necesitas pasar las variables de entorno al contenedor. Una forma es usando un archivo de entorno:
    ```bash
    docker run --rm --env-file ./.env -it chatsage:latest
    ```
    *(Asegúrate de que tu archivo `.env` esté correctamente completado)*