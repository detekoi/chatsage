// tests/unit/components/llm/gemini/chat.test.js

jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/components/llm/gemini/core.js');

import {
    getOrCreateChatSession,
    resetChatSession,
    clearChatSession
} from '../../../../../src/components/llm/gemini/chat.js';
import { getGeminiClient } from '../../../../../src/components/llm/gemini/core.js';

describe('gemini/chat.js', () => {
    let mockStartChat;

    beforeEach(() => {
        jest.clearAllMocks();
        mockStartChat = jest.fn().mockReturnValue({ sendMessage: jest.fn() });
        getGeminiClient.mockReturnValue({
            startChat: mockStartChat
        });
        // Clear internal map state by resetting potentially used channels
        resetChatSession('testchannel');
    });

    describe('getOrCreateChatSession', () => {
        it('should create a new session if one does not exist', () => {
            const session = getOrCreateChatSession('testchannel');
            expect(mockStartChat).toHaveBeenCalled();
            expect(session).toBeDefined();
        });

        it('should return existing session if one exists', () => {
            const session1 = getOrCreateChatSession('testchannel');
            const session2 = getOrCreateChatSession('testchannel');

            expect(mockStartChat).toHaveBeenCalledTimes(1); // Only called once
            expect(session1).toBe(session2);
        });

        it('should initialize with history if provided', () => {
            const history = [{ username: 'user', message: 'hi' }];
            getOrCreateChatSession('testchannel', null, history);

            expect(mockStartChat).toHaveBeenCalledWith(expect.objectContaining({
                history: expect.arrayContaining([
                    expect.objectContaining({ role: 'user' })
                ])
            }));
        });
    });

    describe('resetChatSession', () => {
        it('should remove the session', () => {
            getOrCreateChatSession('testchannel');
            resetChatSession('testchannel');

            // Should create a NEW session now
            getOrCreateChatSession('testchannel');
            expect(mockStartChat).toHaveBeenCalledTimes(2);
        });
    });
});
