import logger from '../../../lib/logger.js';
import { getGeminiClient } from './core.js';
import { CHAT_SAGE_SYSTEM_INSTRUCTION } from './prompts.js';

// --- NEW: Channel-scoped Chat Sessions ---
// Maintain a persistent chat per Twitch channel to enable multi-turn context.
// This aligns with the Gemini chat API guidance to create a chat and send messages on it.
const channelChatSessions = new Map();

// Convert recent chat messages into Gemini chat history format
// Reference: Gemini multi-turn conversations history structure
// https://ai.google.dev/gemini-api/docs/text-generation#multi-turn-conversations
function _convertChatHistoryToGeminiHistory(chatHistory, maxMessages = 15) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return [];
    const recent = chatHistory.slice(-maxMessages);
    return recent.map(msg => ({
        role: "user",
        parts: [{ text: `${msg.username}: ${msg.message}` }]
    }));
}

/**
 * Returns an existing chat session for the given channel or creates a new one.
 * The session is initialized with the long-lived systemInstruction (persona) and optional initial history.
 * @param {string} channelName - Clean channel name without '#'
 * @param {string|null} initialContext - Optional context string to append to system instruction
 * @param {Array|null} chatHistory - Optional raw chat history array (recent messages) to seed history
 * @returns {import('@google/generative-ai').ChatSession}
 */
export function getOrCreateChatSession(channelName, initialContext = null, chatHistory = null) {
    if (!channelName || typeof channelName !== 'string') {
        throw new Error('getOrCreateChatSession requires a valid channelName');
    }
    if (channelChatSessions.has(channelName)) {
        return channelChatSessions.get(channelName);
    }

    const model = getGeminiClient();

    // Combine the base persona with the initial stream/chat context.
    let finalSystemInstruction = CHAT_SAGE_SYSTEM_INSTRUCTION;
    if (initialContext) {
        finalSystemInstruction += `

--- IMPORTANT SESSION CONTEXT ---
${initialContext}`;
    }

    // Prepare initial history from recent chat messages if provided
    const initialHistory = Array.isArray(chatHistory) && chatHistory.length > 0
        ? _convertChatHistoryToGeminiHistory(chatHistory, 15)
        : [];

    // startChat takes an object with systemInstruction and optional history
    const chat = model.startChat({
        systemInstruction: { parts: [{ text: finalSystemInstruction }] },
        // Enable Google Search grounding inside the chat session
        tools: [{ googleSearch: {} }],
        history: initialHistory
    });

    channelChatSessions.set(channelName, chat);
    logger.info({ channelName, toolsEnabled: ['googleSearch'], hasInitialContext: !!initialContext, hasInitialHistory: initialHistory.length > 0, historyMessageCount: initialHistory.length }, 'Created new Gemini chat session for channel');
    return chat;
}

/**
 * Resets/clears a chat session for the given channel.
 * The next call to getOrCreateChatSession will recreate it fresh.
 * @param {string} channelName
 */
export function resetChatSession(channelName) {
    if (!channelName || typeof channelName !== 'string') return;
    if (channelChatSessions.has(channelName)) {
        channelChatSessions.delete(channelName);
        logger.info({ channelName }, 'Reset Gemini chat session for channel');
    }
}

/**
 * Clears a chat session for the given channel or session ID.
 * Alias for resetChatSession for consistency with shared chat terminology.
 * @param {string} channelOrSessionId - Channel name or shared session ID
 */
export function clearChatSession(channelOrSessionId) {
    resetChatSession(channelOrSessionId);
}
