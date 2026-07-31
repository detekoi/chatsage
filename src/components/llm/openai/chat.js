import logger from '../../../lib/logger.js';
import { getOpenAiInstance, getConfiguredModelId, getConfiguredReasoningEffort } from './core.js';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from '../gemini/prompts.js';
import { searchTool } from './tools.js';
import { retryWithBackoff } from '../retryUtils.js';
import { safeExtractText } from './utils.js';

const channelChatSessions = new Map();
const MAX_HISTORY_MESSAGES = 30;

function _convertChatHistoryToOpenAiHistory(chatHistory, maxMessages = 15) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return [];
    const recent = chatHistory.slice(-maxMessages);
    return recent.map(msg => ({
        role: 'user',
        content: `${msg.username}: ${msg.message}`
    }));
}

export class OpenAiChatSession {
    constructor(channelName, systemInstruction, initialHistory = [], options = {}) {
        this.channelName = channelName;
        this.systemInstruction = systemInstruction;
        this.history = [...initialHistory];
        this.options = options;
    }

    async sendMessage(messageText) {
        const openai = getOpenAiInstance();
        const model = getConfiguredModelId();

        // Push new user message
        this.history.push({
            role: 'user',
            content: typeof messageText === 'string' ? messageText : JSON.stringify(messageText)
        });

        // Trim history to sliding window
        if (this.history.length > MAX_HISTORY_MESSAGES) {
            this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
        }

        try {
            const response = await retryWithBackoff(async () => {
                return await openai.responses.create({
                    model,
                    input: this.history,
                    instructions: this.systemInstruction,
                    tools: searchTool,
                    reasoning: { effort: getConfiguredReasoningEffort() }
                });
            }, `chat.sendMessage[${this.channelName}]`);

            const responseText = safeExtractText(response, `chat[${this.channelName}]`) || '';

            if (responseText) {
                this.history.push({
                    role: 'assistant',
                    content: responseText
                });
            }

            // Return Gemini-compatible wrapper object so existing callers can use response.text() or candidate inspection
            return {
                text: () => responseText,
                candidates: [
                    {
                        content: { parts: [{ text: responseText }] },
                        groundingMetadata: response.output?.find(i => i.type === 'web_search_call') ? { usedWebSearch: true } : null
                    }
                ]
            };
        } catch (error) {
            logger.error({ err: error, channelName: this.channelName }, 'Error sending chat message in OpenAI session');
            throw error;
        }
    }
}

export function getOrCreateChatSession(channelName, initialContext = null, chatHistory = null, botLanguage = null) {
    if (!channelName || typeof channelName !== 'string') {
        throw new Error('getOrCreateChatSession requires a valid channelName');
    }
    if (channelChatSessions.has(channelName)) {
        return channelChatSessions.get(channelName);
    }

    let finalSystemInstruction = CHAT_SAGE_SYSTEM_INSTRUCTION;

    if (botLanguage) {
        finalSystemInstruction += `\n\nCRITICAL LANGUAGE REQUIREMENT: You MUST write every response entirely in ${botLanguage}, even though the stream context and chat history are in another language.`;
    }

    if (initialContext) {
        finalSystemInstruction += `

--- IMPORTANT SESSION CONTEXT ---
${initialContext}`;
    }

    const initialHistory = Array.isArray(chatHistory) && chatHistory.length > 0
        ? _convertChatHistoryToOpenAiHistory(chatHistory, 15)
        : [];

    const session = new OpenAiChatSession(channelName, finalSystemInstruction, initialHistory);
    channelChatSessions.set(channelName, session);

    logger.info({
        channelName,
        toolsEnabled: ['web_search'],
        hasInitialContext: !!initialContext,
        hasInitialHistory: initialHistory.length > 0,
        historyMessageCount: initialHistory.length,
        botLanguage: botLanguage || 'English (default)'
    }, 'Created new OpenAI chat session for channel');

    return session;
}

export function resetChatSession(channelName) {
    if (!channelName || typeof channelName !== 'string') return;
    if (channelChatSessions.has(channelName)) {
        channelChatSessions.delete(channelName);
        logger.info({ channelName }, 'Reset OpenAI chat session for channel');
    }
}

export function clearChatSession(channelOrSessionId) {
    resetChatSession(channelOrSessionId);
}
