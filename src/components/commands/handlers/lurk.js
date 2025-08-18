// src/components/commands/handlers/lurk.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import { getGeminiClient } from '../../llm/geminiClient.js';
import { getContextManager } from '../../context/contextManager.js';

/**
 * Handler for the !lurk command.
 * Provides a fun, contextual send-off to a user who is going to lurk.
 */
const lurkHandler = {
    name: 'lurk',
    description: 'Let the chat know you are lurking. Provide an optional reason for a custom send-off.',
    usage: '!lurk [your reason for lurking]',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const displayName = user['display-name'] || user.username;
        const lurkReason = args.join(' ').trim();
        const channelName = channel.substring(1); // Remove '#' for context manager
        const contextManager = getContextManager();

        try {
            // Get the full context object from the context manager (proceed even if unavailable)
            const llmContext = contextManager.getContextForLLM(channelName, displayName, `is going to lurk. Reason: ${lurkReason || 'none'}`) || {};

            // Build a minimal context to reduce tokens
            const recent = (llmContext.recentChatHistory || '').toString();
            const recentTail = recent.split('\n').slice(-4).join('\n');
            const recentTrimmed = recentTail.length > 200 ? recentTail.slice(-200) : recentTail;
            const summary = (llmContext.chatSummary || '').toString();
            const summaryTrimmed = summary.length > 240 ? summary.slice(0, 240) : summary;
            const minimalContext = `Channel: ${channelName}\nGame: ${llmContext.streamGame || ''}\nTitle: ${llmContext.streamTitle || ''}\nSummary: ${summaryTrimmed}\nRecent:\n${recentTrimmed}`;

            let prompt;

            if (lurkReason) {
                // Prompt that focuses on the user's reason for lurking
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Their reason is: "${lurkReason}". Based on the recent chat conversation, generate a short, friendly, and encouraging send-off for them. Wish them well with their task and try to connect it to the ongoing chat topic. Keep it concise, positive, and under 25 words.`;
            } else {
                // Prompt for a general lurk command, using chat context
                prompt = `A Twitch user named "${displayName}" is about to start lurking. Based on the recent chat conversation, generate a short, friendly, and personalized send-off. Make the response feel like a natural continuation of the current chat. Keep it concise, positive, and under 25 words.`;
            }
            
            // Use the globally configured Gemini model (from GEMINI_MODEL_ID)
            const model = getGeminiClient();
            const systemInstruction = `Reply with a single playful plain-text line for a Twitch lurk send-off. No usernames or @handles. Keep it under 22 words. Avoid clichés like "Enjoy the lurk" or "We'll be here when you get back." Vary phrasing and rhythm.`;
            let llmResponse = null;
            const extractText = (response, candidate) => {
                if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
                    const joined = candidate.content.parts.map(p => p?.text || '').join('').trim();
                    if (joined) return joined;
                }
                if (typeof candidate?.text === 'string' && candidate.text.trim()) return candidate.text.trim();
                if (typeof response?.text === 'function') {
                    const t = response.text();
                    if (typeof t === 'string' && t.trim()) return t.trim();
                }
                if (typeof response?.text === 'string' && response.text.trim()) return response.text.trim();
                return null;
            };
            try {
                const attempt1Prompt = `${minimalContext}\nTASK: ${prompt}`;
                logger.debug({ channel: channelName, phase: 'attempt1', promptLength: attempt1Prompt.length }, 'Lurk LLM generation');
                const result = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: attempt1Prompt }] }],
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    generationConfig: { maxOutputTokens: 2048, temperature: 0.98, topP: 0.9, responseMimeType: 'text/plain', stopSequences: ['\n'] }
                });
                const response = result.response;
                const candidate = response?.candidates?.[0];
                const text = extractText(response, candidate);
                logger.debug({
                    channel: channelName,
                    phase: 'attempt1',
                    finishReason: candidate?.finishReason,
                    modelVersion: response?.modelVersion,
                    hasText: !!text
                }, 'Lurk LLM attempt1 result');
                llmResponse = text && text.length > 0 ? text : null;
            } catch (e) {
                logger.warn({ err: e }, 'Lurk LLM attempt1 failed.');
            }

            // Attempt 2: simplified prompt without context to further reduce tokens
            if (!llmResponse) {
                try {
                    const attempt2Prompt = `TASK: ${prompt}\nCONSTRAINTS: One playful line, under 20 words, no usernames or @handles, plain text.`;
                    logger.debug({ channel: channelName, phase: 'attempt2', promptLength: attempt2Prompt.length }, 'Lurk LLM generation');
                    const result2 = await model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: attempt2Prompt }] }],
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        generationConfig: { maxOutputTokens: 1024, temperature: 0.95, topP: 0.9, responseMimeType: 'text/plain', stopSequences: ['\n'] }
                    });
                    const response2 = result2.response;
                    const cand2 = response2?.candidates?.[0];
                    const text2 = extractText(response2, cand2);
                    logger.debug({ channel: channelName, phase: 'attempt2', finishReason: cand2?.finishReason, modelVersion: response2?.modelVersion, hasText: !!text2 }, 'Lurk LLM attempt2 result');
                    llmResponse = text2 && text2.length > 0 ? text2 : null;
                } catch (e2) {
                    logger.warn({ err: e2 }, 'Lurk LLM attempt2 failed.');
                }
            }

            // If it looks truncated (no ending punctuation and fairly short), try one more time with a slightly higher token cap
            const seemsTruncated = (txt) => {
                if (!txt) return false;
                const endsClean = /[.!?…]$/.test(txt.trim());
                return !endsClean && txt.trim().split(/\s+/).length >= 4;
            };
            if (llmResponse && seemsTruncated(llmResponse)) {
                try {
                    const attempt3Prompt = `TASK: ${prompt}\nCONSTRAINTS: One playful line, under 22 words, end with a complete sentence.`;
                    logger.debug({ channel: channelName, phase: 'attempt3', promptLength: attempt3Prompt.length }, 'Lurk LLM generation');
                    const result3 = await model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: attempt3Prompt }] }],
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        generationConfig: { maxOutputTokens: 2048, temperature: 0.9, topP: 0.9, responseMimeType: 'text/plain', stopSequences: ['\n'] }
                    });
                    const response3 = result3.response;
                    const cand3 = response3?.candidates?.[0];
                    const text3 = extractText(response3, cand3);
                    logger.debug({ channel: channelName, phase: 'attempt3', finishReason: cand3?.finishReason, modelVersion: response3?.modelVersion, hasText: !!text3 }, 'Lurk LLM attempt3 result');
                    if (text3 && text3.length > 0) llmResponse = text3;
                } catch (e3) {
                    logger.warn({ err: e3 }, 'Lurk LLM attempt3 failed.');
                }
            }

            if (!llmResponse) {
                logger.warn({ channel: channelName }, 'LLM did not return content for !lurk; not sending a message.');
                return;
            }

            const response = `@${displayName}, ${llmResponse}`;
            enqueueMessage(channel, response);
            logger.info(`Executed !lurk command in ${channel} for ${displayName}`);

        } catch (error) {
            logger.error({ err: error, channel: channel, user: user.username }, 'Error executing !lurk command');
            return;
        }
    },
};

export default lurkHandler;