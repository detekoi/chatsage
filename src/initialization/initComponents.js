import logger from '../lib/logger.js';
import config from '../config/index.js';
import { initializeSecretManager, validateSecretManager } from '../lib/secretManager.js';
import { initializeChannelManager, getActiveManagedChannels } from '../components/twitch/channelManager.js';
import { initializeStorage } from '../components/geo/geoStorage.js';
import { initializeStorage as initializeTriviaStorage } from '../components/trivia/triviaStorage.js';
import { initializeRiddleStorage } from '../components/riddle/riddleStorage.js';
import { initializeLanguageStorage } from '../components/context/languageStorage.js';
import { initializeAutoChatStorage } from '../components/context/autoChatStorage.js';
import { initializeQuotesStorage } from '../components/quotes/quoteStorage.js';
import { initializeCommandStateManager } from '../components/context/commandStateManager.js';
import { initializeGeminiClient } from '../components/llm/geminiClient.js';
import { initializeHelixClient } from '../components/twitch/helixClient.js';
import { initializeContextManager } from '../components/context/contextManager.js';
import { cleanupKeepAliveTasks } from '../components/twitch/eventsub.js';
import { initializeCommandProcessor } from '../components/commands/commandProcessor.js';
import { initializeIrcSender } from '../lib/ircSender.js';
import { initializeGeoGameManager } from '../components/geo/geoGameManager.js';
import { initializeTriviaGameManager } from '../components/trivia/triviaGameManager.js';
import { initializeRiddleGameManager } from '../components/riddle/riddleGameManager.js';
import { startAdSchedulePoller } from '../components/twitch/adSchedulePoller.js';

/**
 * Initialize Secret Manager and validate it
 * @returns {Promise<void>}
 */
export async function initializeSecrets() {
    logger.info('Initializing Secret Manager...');
    initializeSecretManager();

    logger.info('Validating Secret Manager initialization...');
    if (!validateSecretManager()) {
        logger.fatal('Secret Manager validation failed. Cannot continue safely.');
        process.exit(1);
    }
}

/**
 * Initialize channels from environment or Firestore
 * @returns {Promise<void>}
 */
export async function initializeChannels() {
    logger.info('Initializing Channel Manager...');
    await initializeChannelManager();

    // Load Twitch Channels
    // Use env-based channels locally (development) and Firestore when deployed on Cloud Run.
    const isCloudRun = !!(process.env.K_SERVICE || process.env.K_REVISION || process.env.K_CONFIGURATION);
    if (!isCloudRun && config.app.nodeEnv === 'development') {
        logger.info('Local development detected. Using TWITCH_CHANNELS from .env');
        const envChannels = (process.env.TWITCH_CHANNELS || '')
            .split(',')
            .map(ch => ch.trim().toLowerCase())
            .filter(Boolean);
        if (envChannels.length === 0) {
            logger.fatal('TWITCH_CHANNELS is empty or not set in .env for development. Please set it.');
            process.exit(1);
        }
        config.twitch.channels = envChannels;
        logger.info(`Loaded ${config.twitch.channels.length} channels from .env: [${config.twitch.channels.join(', ')}]`);
    } else {
        logger.info('Cloud environment detected or not development. Loading channels from Firestore.');
        const managedChannels = await getActiveManagedChannels();
        if (managedChannels && managedChannels.length > 0) {
            config.twitch.channels = managedChannels.map(ch => ch.toLowerCase());
            logger.info(`Loaded ${config.twitch.channels.length} channels from Firestore.`);
        } else {
            logger.fatal('No active channels found in Firestore managedChannels collection. Cannot proceed.');
            process.exit(1);
        }
    }

    // Ensure channels are populated before proceeding
    if (!config.twitch.channels || config.twitch.channels.length === 0) {
        logger.fatal('FATAL: No Twitch channels configured to join. Exiting.');
        process.exit(1);
    }
}

/**
 * Initialize all storage components
 * @returns {Promise<void>}
 */
export async function initializeStorageComponents() {
    logger.info('Initializing Firebase Storage...');
    await initializeStorage();

    logger.info('Initializing Trivia Storage...');
    await initializeTriviaStorage();

    logger.info('Initializing Riddle Storage...');
    await initializeRiddleStorage();

    logger.info('Initializing Language Storage...');
    await initializeLanguageStorage();

    logger.info('Initializing Auto-Chat Storage...');
    await initializeAutoChatStorage();

    logger.info('Initializing Quotes Storage...');
    await initializeQuotesStorage();

    logger.info('Initializing Command State Manager...');
    await initializeCommandStateManager();
}

/**
 * Initialize Twitch and LLM clients
 * @returns {Promise<void>}
 */
export async function initializeClients() {
    logger.info('Initializing Gemini Client...');
    initializeGeminiClient(config.gemini);

    logger.info('Initializing Twitch Helix Client...');
    await initializeHelixClient(config.twitch);
}

/**
 * Initialize context and command processing
 * @returns {Promise<void>}
 */
export async function initializeContextAndCommands() {
    logger.info('Initializing Context Manager...');
    await initializeContextManager(config.twitch.channels);

    logger.info('Cleaning up any orphaned keep-alive tasks...');
    await cleanupKeepAliveTasks();

    logger.info('Initializing Command Processor...');
    initializeCommandProcessor();

    logger.info('Initializing IRC Sender...');
    initializeIrcSender();
}

/**
 * Initialize all game managers
 * @returns {Promise<void>}
 */
export async function initializeGameManagers() {
    logger.info('Initializing GeoGame Manager...');
    await initializeGeoGameManager();

    logger.info('Initializing Trivia Game Manager...');
    await initializeTriviaGameManager();

    logger.info('Initializing Riddle Game Manager...');
    await initializeRiddleGameManager();
}

/**
 * Initialize ad schedule poller
 * @returns {Promise<void>}
 */
export async function initializeAdSchedule() {
    try {
        await startAdSchedulePoller();
        logger.info('Ad Schedule Poller started (pre-IRC).');
    } catch (err) {
        logger.error({ err }, 'Failed to start Ad Schedule Poller (pre-IRC)');
    }
}

/**
 * Run all component initialization in the correct order
 * @returns {Promise<void>}
 */
export async function initializeAllComponents() {
    await initializeSecrets();
    await initializeChannels();
    await initializeStorageComponents();
    await initializeClients();
    await initializeContextAndCommands();
    await initializeGameManagers();
    await initializeAdSchedule();
}
