import logger from './logger.js';
import { getGeminiClient } from '../components/llm/geminiClient.js';

// Enhanced text extraction function similar to lurk command fixes
function extractTextFromResponse(response, candidate) {
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
}

/**
 * Robust translation function with retry logic similar to lurk command fixes
 * @param {string} textToTranslate - The text to translate
 * @param {string} targetLanguage - The target language
 * @returns {Promise<string|null>} The translated text, or null on failure
 */
export async function translateText(textToTranslate, targetLanguage) {
    if (!textToTranslate || !targetLanguage) {
        logger.error('translateText called with missing text or target language.');
        return null;
    }
    const model = getGeminiClient();

    const translationPrompt = `You are an expert interpreter. Translate the following text into ${targetLanguage}. Do not include any other text or commentary. Do not wrap your translation in quotation marks:\n\n${textToTranslate}\n\nTranslation:`;

    logger.debug({ targetLanguage, textLength: textToTranslate.length }, 'Attempting translation Gemini API call');

    let translatedText = null;

    // Attempt 1: Standard translation with higher token limit
    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: translationPrompt }] }],
            generationConfig: { 
                maxOutputTokens: 2048, // Increased from 1024 to match recent fixes
                temperature: 0.3,
                responseMimeType: 'text/plain'
            }
        });
        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (response.promptFeedback?.blockReason) {
            logger.warn({ blockReason: response.promptFeedback.blockReason }, 'Translation prompt blocked by Gemini safety settings.');
            return null;
        }

        if (candidate && candidate.finishReason !== 'SAFETY') {
            const text = extractTextFromResponse(response, candidate);
            logger.debug({ 
                phase: 'attempt1',
                finishReason: candidate?.finishReason,
                hasText: !!text,
                textPreview: text?.substring(0, 50)
            }, 'Translation attempt1 result');
            translatedText = text && text.length > 0 ? text : null;
        }
    } catch (e) {
        logger.warn({ err: e }, 'Translation attempt1 failed.');
    }

    // Attempt 2: Simplified prompt if first attempt failed
    if (!translatedText) {
        try {
            const simplePrompt = `Translate to ${targetLanguage}: ${textToTranslate}`;
            const result2 = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: simplePrompt }] }],
                generationConfig: { 
                    maxOutputTokens: 1536,
                    temperature: 0.2,
                    responseMimeType: 'text/plain'
                }
            });
            const response2 = result2.response;
            const candidate2 = response2?.candidates?.[0];
            
            if (candidate2 && candidate2.finishReason !== 'SAFETY') {
                const text2 = extractTextFromResponse(response2, candidate2);
                logger.debug({
                    phase: 'attempt2',
                    finishReason: candidate2?.finishReason,
                    hasText: !!text2
                }, 'Translation attempt2 result');
                translatedText = text2 && text2.length > 0 ? text2 : null;
            }
        } catch (e2) {
            logger.warn({ err: e2 }, 'Translation attempt2 failed.');
        }
    }

    if (!translatedText) {
        logger.warn('Translation response missing extractable text.');
        return null;
    }

    // Only remove quotation marks if they surround the entire message
    const cleanedText = translatedText.replace(/^"(.*)"$/s, '$1').trim();
    logger.info({ targetLanguage, originalLength: textToTranslate.length, translatedLength: cleanedText.length }, 'Successfully generated translation from Gemini.');
    return cleanedText;
}