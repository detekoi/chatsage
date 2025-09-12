// tests/unit/components/twitch/helixClient.test.js

jest.mock('axios');
jest.mock('../../../../src/components/twitch/auth');
jest.mock('../../../../src/lib/logger');

import {
    initializeHelixClient,
    getHelixClient,
    getChannelInformation,
    getUsersByLogin
} from '../../../../src/components/twitch/helixClient.js';
import axios from 'axios';
import { getAppAccessToken, clearCachedAppAccessToken } from '../../../../src/components/twitch/auth.js';
import logger from '../../../../src/lib/logger.js';
import mockHelixResponses from '../../../fixtures/helixResponses.json' with { type: 'json' };

describe('Helix Client Unit Tests', () => {
    let mockAxiosInstance;

    // Setup mock before each test
    beforeEach(() => {
        jest.clearAllMocks();
        mockAxiosInstance = {
            get: jest.fn(), post: jest.fn(),
            interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
            defaults: { headers: { common: {} } }
        };
        axios.create.mockReturnValue(mockAxiosInstance);
        getAppAccessToken.mockResolvedValue('mock-app-token-123');
    });

    test('initializeHelixClient should create instance and attach interceptors', async () => {
        await initializeHelixClient();
        expect(axios.create).toHaveBeenCalledTimes(1);
        expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
        expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
    });

    // --- Tests for specific functions ---

    test('getUsersByLogin should call endpoint and check auth', async () => {
        // Arrange: Initialize FIRST to attach interceptors to the mock
        await initializeHelixClient();
        const client = getHelixClient(); // This should be our mockAxiosInstance
        const logins = ['user1', 'user2'];
        const mockApiResponse = { data: { data: mockHelixResponses.getUsers.success }, config: {meta:{}}};
        client.get.mockResolvedValue(mockApiResponse); // Mock the 'get' call

        // Act
        const users = await getUsersByLogin(logins);

        // Assert API Call
        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith('/users', { params: expect.any(URLSearchParams) });
        expect(users).toEqual(mockHelixResponses.getUsers.success);
        // Assert Implicit Interceptor Effect
        expect(getAppAccessToken).toHaveBeenCalled(); // Trust initialize attached an interceptor that calls this
    });

    test('getChannelInformation should call endpoint and check auth', async () => {
        await initializeHelixClient(); // Initialize FIRST
        const client = getHelixClient();
        const ids = ['123', '456'];
        const mockApiResponse = { data: { data: mockHelixResponses.getChannelInformation.success }, config: {meta:{}}};
        client.get.mockResolvedValue(mockApiResponse);

        const channels = await getChannelInformation(ids);

        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get).toHaveBeenCalledWith('/channels', { params: expect.any(URLSearchParams) });
        expect(channels).toEqual(mockHelixResponses.getChannelInformation.success);
        // Assert Implicit Interceptor Effect
        expect(getAppAccessToken).toHaveBeenCalled();
    });

    test('should handle 401 error and trigger clearCachedAppAccessToken via interceptor', async () => {
        await initializeHelixClient(); // Initialize FIRST
        const client = getHelixClient();

        const logins = ['user1'];
        const authError = new Error('Request failed with status code 401');
        authError.response = { status: 401, data:{}, headers:{}, config: { url: '/users', method: 'GET', meta: { requestStartedAt: Date.now() - 100 } } };
        authError.config = authError.response.config;
        client.get.mockRejectedValue(authError); // Mock the rejection

        // Act - Call the function, the rejection SHOULD trigger the real interceptor
        const users = await getUsersByLogin(logins);

        // Assert outcome
        expect(client.get).toHaveBeenCalledTimes(1);
        expect(users).toEqual([]); // Expect graceful failure return

        // Assert Implicit Interceptor Effect
        expect(clearCachedAppAccessToken).toHaveBeenCalledTimes(1); // Trust initialize attached interceptor that calls this on 401
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Received 401 Unauthorized'));
    });

    test('getChannelInformation should truncate broadcaster IDs if more than 100', async () => {
        await initializeHelixClient(); // Initialize FIRST
        const client = getHelixClient();
        const ids = Array.from({ length: 105 }, (_, i) => `id${i + 1}`);
        const mockApiResponse = { data: { data: [] }, config: {meta:{}}};
        client.get.mockResolvedValue(mockApiResponse);

        await getChannelInformation(ids);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Truncating'));
        expect(client.get).toHaveBeenCalledTimes(1);
        const actualParams = client.get.mock.calls[0][1].params;
        expect(actualParams.getAll('broadcaster_id').length).toBe(100);
    });
});