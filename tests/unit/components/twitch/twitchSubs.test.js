// tests/unit/components/twitch/twitchSubs.test.js

jest.mock('../../../../src/components/twitch/helixClient.js');
jest.mock('../../../../src/lib/logger.js');
jest.mock('../../../../src/config/index.js');
jest.mock('../../../../src/components/twitch/channelManager.js');

import {
    subscribeChannelSubscriptionGift,
    subscribeAllManagedChannels
} from '../../../../src/components/twitch/twitchSubs.js';
import { getHelixClient, getUsersByLogin } from '../../../../src/components/twitch/helixClient.js';
import { getActiveManagedChannels } from '../../../../src/components/twitch/channelManager.js';
import config from '../../../../src/config/index.js';
import logger from '../../../../src/lib/logger.js';

describe('twitchSubs', () => {
    let mockHelixClient;

    beforeEach(() => {
        jest.clearAllMocks();

        config.twitch = {
            publicUrl: 'https://mock-public-url.com',
            eventSubSecret: 'mock-secret',
            clientId: 'mock-client-id'
        };

        // mockHelixClient must be a callable mock function because makeHelixRequest calls it directly as: helixClient(axiosConfig)
        mockHelixClient = jest.fn().mockResolvedValue({ data: { data: [{ id: 'sub-id' }] } });
        getHelixClient.mockReturnValue(mockHelixClient);
    });

    describe('subscribeChannelSubscriptionGift', () => {
        test('should make Helix request with correct payload', async () => {
            const result = await subscribeChannelSubscriptionGift('12345');

            expect(mockHelixClient).toHaveBeenCalledWith({
                method: 'post',
                url: '/eventsub/subscriptions',
                data: {
                    type: 'channel.subscription.gift',
                    version: '1',
                    condition: { broadcaster_user_id: '12345' },
                    transport: {
                        method: 'webhook',
                        callback: 'https://mock-public-url.com/twitch/event',
                        secret: 'mock-secret'
                    }
                }
            });
            expect(result).toEqual({ success: true, data: { data: [{ id: 'sub-id' }] } });
        });

        test('should return configuration error when missing publicUrl or secret', async () => {
            config.twitch = {};

            const result = await subscribeChannelSubscriptionGift('12345');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Missing configuration');
            expect(logger.error).toHaveBeenCalledWith('Missing PUBLIC_URL or TWITCH_EVENTSUB_SECRET in config');
        });
    });

    describe('subscribeAllManagedChannels', () => {
        test('should subscribe to all events for managed channels', async () => {
            getActiveManagedChannels.mockResolvedValue([{ name: 'testchannel', twitchUserId: null }]);
            getUsersByLogin.mockResolvedValue([{ id: '12345', login: 'testchannel' }]);

            const results = await subscribeAllManagedChannels();

            expect(getActiveManagedChannels).toHaveBeenCalled();
            expect(getUsersByLogin).toHaveBeenCalledWith(['testchannel']);
            expect(results.successful).toContainEqual({ channel: 'testchannel', userId: '12345' });
            expect(results.failed).toHaveLength(0);

            // Verify our channel.subscription.gift was subscribed
            expect(mockHelixClient).toHaveBeenCalledWith(expect.objectContaining({
                method: 'post',
                url: '/eventsub/subscriptions',
                data: expect.objectContaining({
                    type: 'channel.subscription.gift',
                    condition: { broadcaster_user_id: '12345' }
                })
            }));
        });

        test('should report warning if celebration subscriptions fail but core succeeds', async () => {
            getActiveManagedChannels.mockResolvedValue([{ name: 'testchannel', twitchUserId: '12345' }]);

            // Core endpoints succeed, celebration endpoints fail
            mockHelixClient.mockImplementation((axiosConfig) => {
                const body = axiosConfig.data;
                const coreTypes = ['stream.online', 'stream.offline', 'channel.chat.message', 'channel.channel_points_custom_reward_redemption.add'];
                if (coreTypes.includes(body.type)) {
                    return Promise.resolve({ data: { data: [{ id: 'sub-id', status: 'enabled' }] } });
                }
                return Promise.reject(new Error('Missing OAuth scope'));
            });

            const results = await subscribeAllManagedChannels();

            // Core success is still true
            expect(results.successful).toContainEqual({ channel: 'testchannel', userId: '12345' });
            expect(results.failed).toHaveLength(0);

            // Warning was logged about failed celebration subscriptions
            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    channelName: 'testchannel',
                    failed: expect.arrayContaining(['channel.follow', 'channel.subscribe', 'channel.subscription.gift', 'channel.raid'])
                }),
                expect.stringContaining('Some celebration EventSub subscriptions failed')
            );
        });
    });
});
