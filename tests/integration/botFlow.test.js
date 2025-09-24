// tests/integration/botFlow.test.js

// --- Imports ---
// ... keep necessary imports for components UNDER TEST and their DIRECT dependencies ...
import { createIrcClient, connectIrcClient } from '../../src/components/twitch/ircClient';
// Removed helix client imports here
import { initializeGeminiClient, decideSearchWithFunctionCalling, generateStandardResponse, generateSearchResponse } from '../../src/components/llm/geminiClient';
import { initializeContextManager } from '../../src/components/context/contextManager';
import { initializeCommandProcessor } from '../../src/components/commands/commandProcessor';
import { initializeIrcSender, enqueueMessage } from '../../src/lib/ircSender';
import { getValidIrcToken } from '../../src/components/twitch/ircAuthHelper';
import config from '../../src/config/index.js';
import { initializeSecretManager, getSecretValue } from '../../src/lib/secretManager';
import { getAppAccessToken } from '../../src/components/twitch/auth'; // Keep for mocking auth setup if needed by other modules

// --- Mocks ---
jest.mock('tmi.js');
// jest.mock('axios'); // REMOVE - No longer mocking axios directly here
jest.mock('@google/generative-ai');
jest.mock('../../src/lib/logger');
jest.mock('../../src/lib/ircSender');
jest.mock('../../src/components/twitch/auth');
jest.mock('../../src/lib/secretManager');
jest.mock('../../src/components/twitch/streamInfoPoller');
jest.mock('../../src/components/twitch/ircAuthHelper');
// --- ADD MOCK FOR HELIX CLIENT ---
jest.mock('../../src/components/twitch/helixClient'); // Mock the entire module

// --- Mock tmi.js Client ---
const mockTmiClient = {
    on: jest.fn(),
    emit: jest.fn(),
    say: jest.fn(),
    raw: jest.fn(),
    connect: jest.fn().mockResolvedValue(),
    disconnect: jest.fn().mockResolvedValue(),
};
const TmiClient = require('tmi.js').Client;
TmiClient.mockImplementation(() => mockTmiClient);

describe('ChatSage Integration Tests', () => {
    beforeAll(async () => {
        // Mock secrets/auth needed by OTHER initializers
        getSecretValue.mockImplementation(async (_secretName) => { /* ... */ });
        getValidIrcToken.mockResolvedValue('oauth:mock-irc-token');
        getAppAccessToken.mockResolvedValue('mock-app-token'); // Keep if needed by e.g., ircClient init

        // Initialize components EXCEPT helix client
        initializeSecretManager();
        // REMOVED: await initializeHelixClient(config.twitch);
        initializeContextManager(config.twitch.channels);
        initializeGeminiClient(config.gemini);
        initializeCommandProcessor();
        initializeIrcSender();
        await createIrcClient(config.twitch);
        await connectIrcClient();
    });

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();
        // You might need to explicitly reset the mocked helixClient functions here if needed
        // e.g., getChannelInformation.mockClear(); (importing it from the mocked module)
        enqueueMessage.mockClear();
        decideSearchWithFunctionCalling.mockClear();
        generateStandardResponse.mockClear();
        generateSearchResponse.mockClear();
    });

    // Tests should now run without the helixClient initialization error
    test('should process a !ping command and enqueue response', async () => { /* ... same ... */ });
    test('should trigger non-search LLM call...', async () => { /* ... same ... */ });
    test('should trigger search LLM call...', async () => { /* ... same ... */ });
});