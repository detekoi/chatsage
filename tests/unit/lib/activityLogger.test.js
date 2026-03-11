// tests/unit/lib/activityLogger.test.js

// We re-import the module for each test to reset the lazy singleton.
// This avoids issues with module-level caching of the child logger.

let logger;
let logCommand;
let logInteraction;
let logBotResponse;
let mockChildLogger;

beforeEach(() => {
    jest.resetModules();

    // Set up a fresh child logger mock BEFORE importing activityLogger
    mockChildLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };

    // Mock logger with a child that returns our mock
    jest.mock('../../../src/lib/logger.js', () => ({
        __esModule: true,
        default: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(() => mockChildLogger),
        },
    }));

    // Now import the modules fresh
    logger = require('../../../src/lib/logger.js').default;
    const activityLogger = require('../../../src/lib/activityLogger.js');
    logCommand = activityLogger.logCommand;
    logInteraction = activityLogger.logInteraction;
    logBotResponse = activityLogger.logBotResponse;
});

describe('activityLogger', () => {
    describe('logCommand', () => {
        test('should log builtin command with correct fields', () => {
            logCommand('testchannel', 'trivia', 'builtin');

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', action: 'command', command: 'trivia', source: 'builtin' },
                'Command !trivia executed'
            );
        });

        test('should log custom command with correct fields', () => {
            logCommand('somechannel', 'mycommand', 'custom');

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                { channel: 'somechannel', action: 'command', command: 'mycommand', source: 'custom' },
                'Command !mycommand executed'
            );
        });

        test('should not include any user-identifiable information', () => {
            logCommand('testchannel', 'ping', 'builtin');

            const loggedData = mockChildLogger.info.mock.calls[0][0];
            const loggedMessage = mockChildLogger.info.mock.calls[0][1];
            const combined = JSON.stringify(loggedData) + loggedMessage;

            expect(loggedData).not.toHaveProperty('user');
            expect(loggedData).not.toHaveProperty('username');
            expect(loggedData).not.toHaveProperty('userId');
            expect(loggedData).not.toHaveProperty('displayName');
            expect(loggedData).not.toHaveProperty('message');
            expect(combined).not.toMatch(/user/i);
        });
    });

    describe('logInteraction', () => {
        test('should log mention interaction', () => {
            logInteraction('testchannel', 'mention');

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', action: 'mention' },
                'Bot mention detected'
            );
        });

        test('should log reply interaction', () => {
            logInteraction('testchannel', 'reply');

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', action: 'reply' },
                'Bot reply detected'
            );
        });
    });

    describe('logBotResponse', () => {
        test('should log response with all metadata', () => {
            logBotResponse('testchannel', 'mention', {
                latencyMs: 420,
                responseLength: 312,
                summarized: true,
            });

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                {
                    channel: 'testchannel',
                    action: 'bot_response',
                    trigger: 'mention',
                    latencyMs: 420,
                    responseLength: 312,
                    summarized: true,
                },
                'Bot response sent'
            );
        });

        test('should log response without optional metadata', () => {
            logBotResponse('testchannel', 'command');

            expect(mockChildLogger.info).toHaveBeenCalledWith(
                { channel: 'testchannel', action: 'bot_response', trigger: 'command' },
                'Bot response sent'
            );
        });

        test('should include latencyMs of 0', () => {
            logBotResponse('testchannel', 'reply', { latencyMs: 0 });

            const loggedData = mockChildLogger.info.mock.calls[0][0];
            expect(loggedData.latencyMs).toBe(0);
        });

        test('should not include any user-identifiable information', () => {
            logBotResponse('testchannel', 'mention', {
                latencyMs: 100,
                responseLength: 200,
                summarized: false,
            });

            const loggedData = mockChildLogger.info.mock.calls[0][0];
            expect(loggedData).not.toHaveProperty('user');
            expect(loggedData).not.toHaveProperty('username');
            expect(loggedData).not.toHaveProperty('message');
        });
    });

    describe('child logger setup', () => {
        test('should create child logger with type: activity', () => {
            logCommand('ch', 'test', 'builtin');
            expect(logger.child).toHaveBeenCalledWith({ type: 'activity' });
        });
    });
});
