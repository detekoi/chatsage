// tests/unit/components/twitch/ircClient.test.js

jest.mock('tmi.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/config/index.js');

import {
    getIrcClient
} from '../../../../src/components/twitch/ircClient.js';
import config from '../../../../src/config/index.js';

describe('ircClient', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock config
        config.app = {
            logLevel: 'info'
        };

        // Reset module state
        jest.resetModules();
    });

    describe('getIrcClient', () => {
        it('should throw error when client not created', () => {
            expect(() => getIrcClient()).toThrow('IRC client has not been created/initialized.');
        });

        it('should return the ircClient module interface', () => {
            const ircClientModule = getIrcClient;

            expect(typeof ircClientModule).toBe('function');
        });
    });
});
