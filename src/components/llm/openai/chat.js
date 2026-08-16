import logger from '../../../lib/logger.js';
import { getOpenAiInstance, getConfiguredModelId, getConfiguredReasoningEffort, formatOpenAiContent } from './core.js';
import { buildSystemInstruction, buildSharedSystemInstruction } from '../gemini/prompts.js';
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

        // Callers use the Gemini chat convention: a bare string, a parts array,
        // or an envelope { message: parts } where parts are {text}/{inlineData}
        // objects (llmUtils.js sends emote images this way). Convert image parts
        // to input_image content instead of serializing them as JSON text.
        let content;
        if (typeof messageText === 'string') {
            content = messageText;
        } else if (typeof messageText?.message === 'string') {
            content = messageText.message;
        } else {
            const parts = Array.isArray(messageText) ? messageText
                : Array.isArray(messageText?.message) ? messageText.message
                    : [messageText];
            content = formatOpenAiContent(null, parts);
        }

        this.history.push({ role: 'user', content });

        // Trim history to sliding window
        if (this.history.length > MAX_HISTORY_MESSAGES) {
            this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
        }

        try {
            // Snapshot the history — the live array gets the assistant turn
            // pushed after the call, and the request must not be mutated.
            const inputSnapshot = [...this.history];
            const response = await retryWithBackoff(async () => {
                return await openai.responses.create({
                    model,
                    input: inputSnapshot,
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

/**
 * @param {string} sessionKey - Cache key. A channel name for a normal session,
 *   or a Twitch shared-chat sessionId when several channels share one chat.
 * @param {string|null} initialContext
 * @param {Array|null} chatHistory
 * @param {string|null} botLanguage
 * @param {object} [personaScope] - Which channel(s) the persona comes from. This
 *   is deliberately separate from sessionKey: for a shared session the key is a
 *   sessionId, not a channel, so it cannot be used to look up a persona.
 * @param {string|null} [personaScope.channelName] - Single-channel persona source.
 * @param {string|null} [personaScope.hostChannelId] - Shared session host broadcaster ID.
 * @param {Array|null} [personaScope.participants] - Shared session participants.
 */
export function getOrCreateChatSession(sessionKey, initialContext = null, chatHistory = null, botLanguage = null, personaScope = {}) {
    if (!sessionKey || typeof sessionKey !== 'string') {
        throw new Error('getOrCreateChatSession requires a valid sessionKey');
    }
    if (channelChatSessions.has(sessionKey)) {
        return channelChatSessions.get(sessionKey);
    }

    const { channelName = null, hostChannelId = null, participants = null } = personaScope || {};
    let finalSystemInstruction = participants
        ? buildSharedSystemInstruction(hostChannelId, participants)
        : buildSystemInstruction(channelName);

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

    const session = new OpenAiChatSession(sessionKey, finalSystemInstruction, initialHistory);
    channelChatSessions.set(sessionKey, session);

    logger.info({
        sessionKey,
        channelName,
        isShared: !!participants,
        personaCount: participants ? participants.length : undefined,
        toolsEnabled: ['web_search'],
        hasInitialContext: !!initialContext,
        hasInitialHistory: initialHistory.length > 0,
        historyMessageCount: initialHistory.length,
        botLanguage: botLanguage || 'English (default)'
    }, 'Created new OpenAI chat session');

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
