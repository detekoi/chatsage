[![English](https://img.shields.io/badge/lang-English-blue?style=flat)](README.md)
[![Español (MX)](https://img.shields.io/badge/lang-Español%20(MX)-red?style=flat)](README-es-mx.md)
[![Português (BR)](https://img.shields.io/badge/lang-Português%20(BR)-green?style=flat)](README-pt-br.md)
[![Deutsch](https://img.shields.io/badge/lang-Deutsch-yellow?style=flat)](README-de.md)
[![Français](https://img.shields.io/badge/lang-Français-lightgrey?style=flat)](README-fr.md)
[![Italiano](https://img.shields.io/badge/lang-Italiano-orange?style=flat)](README-it.md)
[![日本語](https://img.shields.io/badge/lang-日本語-violet?style=flat)](README-ja.md)

# ChatSage

ChatSage es un chatbot impulsado por IA diseñado para entornos de chat de Twitch en cualquier idioma. Proporciona respuestas contextualmente relevantes basadas en el historial del chat, las consultas de los usuarios y la información del stream en tiempo real (juego actual, título, etiquetas).

**[Agrega ChatSage a tu canal de Twitch →](https://streamsage-bot.web.app)**

[![Licencia](https://img.shields.io/badge/License-BSD%202--Clause-blue.svg)](LICENSE.md) 

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

* Se conecta a los canales de Twitch especificados a través de IRC.
* Obtiene el contexto del stream en tiempo real (juego, título, etiquetas, imágenes en miniatura) utilizando la API Helix de Twitch.
* Utiliza el LLM Google Gemini 2.0 Flash para la comprensión del lenguaje natural y la generación de respuestas.
* Mantiene el contexto de la conversación (historial y resúmenes) por canal.
* Admite comandos de chat personalizados con niveles de permiso.
* Configuraciones de idioma del bot ajustables para soporte de canales multilingües.
* Configurable a través de variables de entorno.
* Incluye registro estructurado adecuado para entornos de producción.
* Interfaz de gestión de canales basada en web para que los streamers agreguen/eliminen el bot.

## Agregar ChatSage a Tu Canal

Los streamers ahora pueden agregar o eliminar fácilmente ChatSage de su canal utilizando la interfaz web:

1. **Visita el Portal de Gestión de ChatSage**:
   - Ve al [Portal de Gestión de ChatSage](https://streamsage-bot.web.app)
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
   - Importante: si el bot no responde, asígnale el estado de moderador con el comando "/mod StreamSageTheBot"

5. **Interacción del Usuario**:
   - Los espectadores pueden interactuar con ChatSage mencionándolo: `@StreamSageTheBot hola` (el nombre de usuario se actualizará para reflejar el nuevo nombre, ChatSage, cuando Twitch me lo permita).
   - O usando varios [comandos](https://detekoi.github.io/botcommands.html) como `!ask`, `!translate`, etc.

## Ejemplos de Uso

### Comandos de Chat

Para obtener una lista completa de los comandos disponibles y su uso, visita la [Documentación de Comandos del Bot](https://detekoi.github.io/botcommands.html).

## Prerrequisitos de Desarrollo

* Node.js (Se recomienda la Versión 22.0.0 o posterior)
* npm (o yarn)

## Primeros Pasos

1.  **Clona el repositorio:**
    ```bash
    git clone [https://github.com/your-username/chatsage.git](https://github.com/your-username/chatsage.git)
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
* `TWITCH_CHANNELS`: Lista de canales a los que unirse, separados por comas. Se utiliza como alternativa si la gestión de canales de Firestore no está disponible.
* `TWITCH_CHANNELS_SECRET_NAME`: Nombre del recurso para la lista de canales en Google Secret Manager. Se utiliza como alternativa si la gestión de canales de Firestore no está disponible.
* `GEMINI_API_KEY`: Tu clave API para el servicio Google Gemini.
* `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`: Credenciales para tu aplicación de Twitch registrada (utilizadas para llamadas a la API Helix).
* `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME`: Nombre del recurso para el token de actualización en Google Secret Manager.
* `STREAM_INFO_FETCH_INTERVAL_SECONDS`: Con qué frecuencia actualizar los datos del contexto del stream.
* `LOG_LEVEL`: Controla la verbosidad de los registros.

Asegúrate de que todas las variables requeridas estén configuradas en tu entorno o en el archivo `.env` antes de ejecutar el bot.

## Gestión de Tokens de Twitch

ChatSage utiliza un mecanismo seguro de actualización de tokens para mantener la autenticación con Twitch:

### Autenticación IRC del Bot

1. **Configuración Inicial para el Token IRC del Bot**:
   - Ve al [Generador de Tokens de Twitch](https://twitchtokengenerator.com)
   - Selecciona los alcances (scopes) requeridos: `chat:read`, `chat:edit`
   - Genera el token
   - Copia el **Token de Actualización** (no el Token de Acceso)
   - Almacena este Token de Actualización de forma segura en Google Secret Manager

2. **Configuración de Google Secret Manager**:
   - Crea un Proyecto de Google Cloud si no tienes uno
   - Habilita la API de Secret Manager
   - Crea un nuevo secreto para almacenar tu token de actualización
   - Anota el nombre del recurso: `projects/TU_ID_DE_PROYECTO/secrets/TU_NOMBRE_DE_SECRETO/versions/latest`
   - Establece este nombre de recurso como `TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME` en tu archivo `.env`
   - Asegúrate de que la cuenta de servicio que ejecuta tu aplicación tenga el rol "Accesor de Secretos de Secret Manager" (Secret Manager Secret Accessor)

3. **Flujo de Autenticación**:
   - Al iniciar, ChatSage obtendrá el token de actualización de Secret Manager
   - Usará este token de actualización para obtener un token de acceso nuevo de Twitch
   - Si el token de acceso expira, se actualizará automáticamente
   - Si el propio token de actualización se invalida, la aplicación registrará un error que requerirá intervención manual

### Interfaz de Usuario Web para la Gestión de Canales

La interfaz web utiliza un flujo OAuth separado para permitir a los streamers gestionar el bot en su canal:

1. **Configuración de Firebase Functions**:
   - La interfaz de usuario web está construida con Firebase Functions y Hosting
   - Utiliza OAuth de Twitch para autenticar a los streamers
   - Cuando un streamer agrega o elimina el bot, actualiza una colección de Firestore
   - El bot verifica periódicamente esta colección para determinar a qué canales unirse o de cuáles salir

2. **Variables de Entorno para la Interfaz de Usuario Web**:
   - `TWITCH_CLIENT_ID`: ID de cliente de la aplicación de Twitch
   - `TWITCH_CLIENT_SECRET`: Secreto de cliente de la aplicación de Twitch 
   - `CALLBACK_URL`: La URL de devolución de llamada de OAuth (la URL de tu función desplegada)
   - `FRONTEND_URL`: La URL de tu interfaz web
   - `JWT_SECRET_KEY`: Secreto para firmar tokens de autenticación
   - `SESSION_COOKIE_SECRET`: Secreto para las cookies de sesión

Este enfoque proporciona mayor seguridad al utilizar flujos OAuth estándar y no almacenar tokens directamente en archivos de configuración. También otorga a los streamers control sobre la adición o eliminación del bot de su canal.

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