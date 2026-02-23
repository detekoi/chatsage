// src/components/riddle/riddleService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient } from '../llm/geminiClient.js';
import { Type as GenAIType } from '@google/genai';

// Blacklist meta-concepts and generic acknowledgements that make bad riddle answers
const META_CONCEPT_BLACKLIST = [
    'knowledge', 'information', 'data', 'fact', 'trivia', 'memory', 'learning',
    'education', 'wisdom', 'understanding', 'intelligence', 'consciousness',
    'thought', 'idea', 'concept', 'mind', 'brain',
    'yes', 'no', 'maybe', 'idk', 'dunno', 'ok', 'okay', 'yep', 'yup', 'nope', 'nah'
];

/**
 * Determines the effective topic for riddle generation.
 * @param {string} topic - The riddle topic
 * @returns {boolean} Whether the topic is general knowledge
 */
function isGeneralKnowledgeTopic(topic) {
    if (!topic) return true;
    const topicLower = topic.toLowerCase();
    return topicLower === 'general knowledge' || topicLower === 'general';
}

// --- Schema ---
const RiddleSchema = {
    type: GenAIType.OBJECT,
    properties: {
        riddle_question: {
            type: GenAIType.STRING,
            description: "The text of the riddle, focusing on metaphorical or puzzling descriptions rather than direct factual statements."
        },
        riddle_answer: {
            type: GenAIType.STRING,
            description: "The single, concise, common answer to the riddle. MUST be a concrete, common, guessable thing."
        },
        keywords: {
            type: GenAIType.ARRAY,
            description: "An array of 3-5 core keywords or short phrases. These keywords MUST be specific, concrete, and discriminative.",
            items: { type: GenAIType.STRING }
        },
        difficulty_generated: {
            type: GenAIType.STRING,
            description: "The assessed difficulty of the generated riddle (easy, normal, hard).",
            enum: ["easy", "normal", "hard"]
        },
        explanation: {
            type: GenAIType.STRING,
            description: "A brief, fun, 1-2 sentence explanation for Twitch chat."
        },
        search_used: {
            type: GenAIType.BOOLEAN,
            description: "True if web search was used to generate or verify the riddle, false otherwise."
        }
    },
    required: ["riddle_question", "riddle_answer", "keywords", "difficulty_generated", "explanation", "search_used"]
};


// Helper: prune excluded keyword sets to keep prompt small
function pruneExcludedKeywordSets(excludedKeywordSets, options = {}) {
    const maxSets = typeof options.maxSets === 'number' ? options.maxSets : 15;
    const maxKeywordsPerSet = typeof options.maxKeywordsPerSet === 'number' ? options.maxKeywordsPerSet : 4;
    const maxTotalChars = typeof options.maxTotalChars === 'number' ? options.maxTotalChars : 1500;

    if (!Array.isArray(excludedKeywordSets) || excludedKeywordSets.length === 0) return [];

    const normalize = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
        .replace(/[\s]+/g, ' ')
        .replace(/^[,;\s]+|[,;\s]+$/g, '');

    const normalizedSets = excludedKeywordSets
        .map((set) => Array.isArray(set) ? set : [])
        .map((set) => {
            const uniq = Array.from(new Set(set.map(normalize).filter(Boolean)));
            return uniq.slice(0, maxKeywordsPerSet);
        })
        .filter((set) => set.length > 0);

    const signature = (set) => set.slice().sort().join('|');
    const seen = new Set();
    const dedupedSets = [];
    for (const set of normalizedSets) {
        const sig = signature(set);
        if (!seen.has(sig)) {
            seen.add(sig);
            dedupedSets.push(set);
        }
    }

    const kept = [];
    for (const set of dedupedSets) {
        let isSubset = false;
        for (const k of kept) {
            const kSet = new Set(k);
            isSubset = set.every((w) => kSet.has(w));
            if (isSubset) break;
        }
        if (!isSubset) kept.push(set);
    }

    let capped = kept.slice(0, maxSets);
    const toInstruction = (sets) => sets.map((set) => `(${set.join(', ')})`).join('; ');
    while (capped.length > 0 && toInstruction(capped).length > maxTotalChars) {
        capped = capped.slice(0, capped.length - 1);
    }

    return capped;
}

/**
 * Generates a riddle using Structured Output and Search Grounding.
 */
export async function generateRiddle(topic, difficulty, excludedKeywordSets = [], channelName, excludedAnswers = []) {
    const model = getGeminiClient();
    let actualTopic = topic;
    let promptDetails = `Difficulty: ${difficulty}.`;

    if (topic && topic.toLowerCase() === 'game') {
        try {
            const contextManager = getContextManager();
            const cleanChannelName = channelName.startsWith('#') ? channelName.substring(1) : channelName;
            const channelState = contextManager.getContextForLLM(cleanChannelName, 'riddle_service', 'fetch_game_topic');
            if (channelState?.streamGame && channelState.streamGame !== 'N/A') {
                actualTopic = channelState.streamGame;
                promptDetails += ` The riddle should be about the video game: "${actualTopic}".`;
                logger.info(`[RiddleService] Riddle topic set to current game: ${actualTopic}. Search will be used.`);
            } else {
                actualTopic = 'general video games';
                logger.warn(`[RiddleService] Could not determine specific current game for channel ${cleanChannelName}, defaulting to "general video games". Search will be used.`);
            }
        } catch (error) {
            logger.error({ err: error }, `[RiddleService] Error getting current game for riddle, defaulting to "general video games".`);
            actualTopic = 'general video games';
        }
    } else if (!topic) {
        actualTopic = 'general knowledge';
    }
    promptDetails += ` Topic: ${actualTopic}.`;

    let keywordExclusionInstruction = "";
    if (excludedKeywordSets.length > 0) {
        const prunedSets = pruneExcludedKeywordSets(excludedKeywordSets);
        if (prunedSets.length > 0) {
            const flatExcludedKeywords = prunedSets.map(set => `(${set.join(', ')})`).join('; ');
            keywordExclusionInstruction = `\nCRITICAL KEYWORD AVOIDANCE: Avoid generating riddles that are conceptually defined by or heavily rely on the following keyword combinations/themes: [${flatExcludedKeywords}].`;
        }
    }

    // Merge blacklist with excluded answers
    const allExcludedAnswers = [...(excludedAnswers || [])];
    if (actualTopic === 'general knowledge') {
        META_CONCEPT_BLACKLIST.forEach(word => {
            if (!allExcludedAnswers.includes(word)) allExcludedAnswers.push(word);
        });
    }

    let answerExclusionInstruction = "";
    if (allExcludedAnswers.length > 0) {
        answerExclusionInstruction = `\n\n🚫 ANSWER EXCLUSION (MANDATORY):
YOU MUST NOT use any of these answers: [${allExcludedAnswers.join(', ')}]
These have been used recently or are banned. Pick something COMPLETELY DIFFERENT.`;
    }
    const fullExclusionInstructions = `${keywordExclusionInstruction}${answerExclusionInstruction}\n\nRequirement: Each riddle must have a UNIQUE, CONCRETE answer.`;



    const prompt = `You are a riddle crafter for a Twitch chat game. Create a riddle about "${actualTopic}" that is CLEVER but GUESSABLE.
${promptDetails}
${fullExclusionInstructions}
Only use Google Search if the riddle requires very recent or obscure facts that may be beyond general knowledge.

CORE PRINCIPLE: The riddle should be solvable by someone familiar with the topic.
MANDATORY ANSWER REQUIREMENTS:
- The answer MUST be a CONCRETE, PHYSICAL, or TANGIBLE thing.
- NEVER use abstract concepts like: knowledge, memory, learning, data.
- Keep answers 1-2 words maximum.

RULES FOR QUESTION:
- Length: 1-2 sentences, max ~200 characters.
- Include 2-3 concrete clues.
- Use classic riddle style ("I am...", "You'll find me...").

EXPLANATION STYLE:
- Fun, conversational (Max 1-2 sentences). No academic tone.

Return JSON matching the schema.`;

    try {
        // Always provide Google Search tool — Gemini auto-decides whether to use it
        const tools = [{ googleSearch: {} }];

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: tools,
            generationConfig: {
                temperature: 0.75,
                responseMimeType: "application/json",
                responseSchema: RiddleSchema
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            logger.warn('[RiddleService] No text content in Gemini response.');
            return null;
        }

        let args;
        try {
            args = JSON.parse(responseText);
        } catch (e) {
            logger.warn({ err: e, text: responseText }, '[RiddleService] Failed to parse JSON response.');
            return null;
        }

        if (!args.riddle_question || !args.riddle_answer || !args.keywords || args.keywords.length === 0) {
            logger.warn('[RiddleService] Missing essential riddle fields in structured output.');
            return null;
        }

        // POST-GENERATION VALIDATION
        const normalizedGeneratedAnswer = args.riddle_answer.toLowerCase().trim();
        if (allExcludedAnswers.some(excluded => normalizedGeneratedAnswer === excluded.toLowerCase().trim())) {
            logger.warn(`[RiddleService] Generated answer "${args.riddle_answer}" is in exclusion list! Rejecting.`);
            return null;
        }
        if (META_CONCEPT_BLACKLIST.some(banned => normalizedGeneratedAnswer.includes(banned))) {
            logger.warn(`[RiddleService] Generated answer "${args.riddle_answer}" contains blacklisted meta-concept! Rejecting.`);
            return null;
        }

        // Derive searchUsed from actual response grounding metadata
        const actuallySearched = args.search_used || !!(result.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length);

        logger.info(`[RiddleService] Riddle generated for topic "${actualTopic}" (search=${actuallySearched}). Q: "${args.riddle_question}", A: "${args.riddle_answer}"`);

        return {
            question: args.riddle_question,
            answer: args.riddle_answer,
            keywords: args.keywords,
            difficulty: args.difficulty_generated || difficulty,
            explanation: args.explanation || "No explanation provided.",
            searchUsed: actuallySearched,
            topic: actualTopic,
            requestedTopic: topic
        };

    } catch (error) {
        logger.error({ err: error, topic: actualTopic }, '[RiddleService] Error generating riddle');
        return null;
    }
}

/**
 * Verifies a user's answer to a riddle using Structured Output.
 */
export async function verifyRiddleAnswer(correctAnswer, userAnswer, riddleQuestion, originalTopic = null) {
    const model = getGeminiClient();

    // Blacklist check
    const normalizedUserGuess = userAnswer.toLowerCase().trim();
    if (META_CONCEPT_BLACKLIST.includes(normalizedUserGuess)) {
        logger.info(`[RiddleService] Rejecting blacklisted word as guess: "${userAnswer}"`);
        return { isCorrect: false, reasoning: "Not a valid riddle answer.", confidence: 0.0 };
    }

    // Direct match check (optimization)
    const normalize = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    if (normalize(userAnswer) === normalize(correctAnswer)) {
        return { isCorrect: true, reasoning: "Exact match.", confidence: 1.0 };
    }

    const VerificationSchema = {
        type: GenAIType.OBJECT,
        properties: {
            is_correct: { type: GenAIType.BOOLEAN },
            confidence: { type: GenAIType.NUMBER },
            reasoning: { type: GenAIType.STRING }
        },
        required: ["is_correct", "confidence", "reasoning"]
    };

    const prompt = `Riddle: "${riddleQuestion}"
Correct Answer: "${correctAnswer}"
User's Guess: "${userAnswer}"
Original Topic: "${originalTopic || 'N/A'}"

ACCEPT if the guess is:
- Exact match or plural/singular variants
- Common abbreviations or informal terms (e.g., "lube" for "lubricant", "fridge" for "refrigerator")
- Synonyms that refer to the same object (e.g., "map" = "atlas")

REJECT if the guess is:
- A completely different object or concept
- Generic words like "yes", "no", "maybe"
- A conversational message
- The Original Topic itself, unless it IS the specific answer (e.g. if Topic="Fruit" and Answer="Apple", guess "Fruit" is WRONG. But if Topic="General" and Answer="Music", guess "Music" is RIGHT).

Return STRICT JSON.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.0,
                responseMimeType: 'application/json',
                responseSchema: VerificationSchema
            }
        });

        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
            const parsed = JSON.parse(responseText);
            logger.info({ userAnswer, is_correct: parsed.is_correct, reasoning: parsed.reasoning }, '[RiddleService] Verified answer via Structured Output.');
            return {
                isCorrect: parsed.is_correct,
                reasoning: parsed.reasoning,
                confidence: parsed.confidence
            };
        }
    } catch (error) {
        logger.error({ err: error }, '[RiddleService] Error utilizing structured verification.');
    }

    // Fallback?
    // In this specific task, simplified fallback is acceptable if LLM fails completely, but usually Gemini doesn't fail structured output repeatedly.
    // We'll trust the LLM or return false on error for safety.
    return { isCorrect: false, reasoning: "Error in verification.", confidence: 0.0 };
}