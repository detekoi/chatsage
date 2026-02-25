// src/components/trivia/triviaQuestionService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient } from '../llm/geminiClient.js';
import { Type as GenAIType } from '@google/genai';

// --- Schemas ---

const TriviaQuestionSchema = {
    type: GenAIType.OBJECT,
    properties: {
        question: {
            type: GenAIType.STRING,
            description: "The trivia question to ask."
        },
        correct_answer: {
            type: GenAIType.STRING,
            description: "The single, most accurate, AND VERY CONCISE answer (ideally a proper noun, specific term, or 1-3 key words). Avoid full sentences or overly descriptive phrases; these belong in the 'explanation'."
        },
        alternate_answers: {
            type: GenAIType.ARRAY,
            description: "Alternative correct and VERY CONCISE answers or common, acceptable variations (each ideally 1-3 key words).",
            items: { type: GenAIType.STRING }
        },
        explanation: {
            type: GenAIType.STRING,
            description: "Brief explanation of why the answer is correct, can include more descriptive details that are not part of the concise answer."
        },
        difficulty: {
            type: GenAIType.STRING,
            description: "The difficulty level of this question (easy, normal, hard).",
            enum: ["easy", "normal", "hard"]
        },
        search_used: {
            type: GenAIType.BOOLEAN,
            description: "Whether external search was required to ensure accuracy."
        },
        category: {
            type: GenAIType.STRING,
            description: "A specific category for the answer (e.g., Person, Location, Event, Work Title, Scientific Term). Keep generic and domain-agnostic."
        }
    },
    required: ["question", "correct_answer", "explanation", "difficulty", "search_used", "category"]
};

// --- Helper: Extract current game from context ---
function getGameFromContext(channelName) {
    if (!channelName) return "video games";
    try {
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, "trivia-system", "");
        const currentGame = llmContext?.streamGame;
        return currentGame && currentGame !== "N/A" ? currentGame : "video games";
    } catch (error) {
        logger.error({ err: error }, 'Error getting game from context');
        return "video games";
    }
}

// --- Helper: String similarity (Levenshtein) ---
export function calculateStringSimilarity(str1, str2) {
    const s1 = (str1 || "").toLowerCase();
    const s2 = (str2 || "").toLowerCase();
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);
    if (maxLen === 0) return 1.0;

    const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) dp[i][0] = i;
    for (let j = 0; j <= len2; j++) dp[0][j] = j;

    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return 1 - (dp[len1][len2] / maxLen);
}

/**
 * Generates a trivia question based on topic and difficulty using Gemini Structured Output.
 * Automatically enables search for specific topics.
 * 
 * @param {string} topic
 * @param {string} difficulty
 * @param {string[]} excludedQuestions - Array of question texts to avoid regenerating.
 * @param {string|null} channelName
 * @param {string[]} excludedAnswers - Array of answer strings to avoid regenerating.
 * @returns {Promise<object|null>}
 */
export async function generateQuestion(topic, difficulty, excludedQuestions = [], channelName = null, excludedAnswers = []) {
    const model = getGeminiClient();

    let specificTopic = topic;
    if (topic && topic.toLowerCase() === 'game' && channelName) {
        specificTopic = getGameFromContext(channelName);
        logger.info(`[TriviaService] Topic 'game' resolved to '${specificTopic}' from channel context.`);
    }

    // Determine topic type for prompt context
    const isGeneralTopic = !specificTopic || specificTopic.toLowerCase() === 'general' || specificTopic.toLowerCase() === 'general knowledge';

    // Build Prompt
    const exclusionInstructions = [];
    if (excludedQuestions.length > 0) {
        exclusionInstructions.push(`Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}`);
    }
    if (excludedAnswers.length > 0) {
        exclusionInstructions.push(`AVOID generating a question if its most likely concise answer is one of these recently used answers: ${excludedAnswers.map(a => `"${a}"`).join(', ')}`);
    }
    exclusionInstructions.push(`Do not make the correct answer exactly the topic itself`);
    if (excludedAnswers.length > 0) {
        exclusionInstructions.push(`Aim for variety`);
    }
    const exclusionInstructionText = exclusionInstructions.length > 0
        ? `\nIMPORTANT: ${exclusionInstructions.join('. ')}.`
        : '';

    const contextPrompt = !isGeneralTopic
        ? `Topic: "${specificTopic}".`
        : `Topic: General Knowledge.`;

    const prompt = `Generate an engaging trivia question.
${contextPrompt}
Difficulty: ${difficulty}.
${exclusionInstructionText}
Be precise about entity types and relationships. Do not reveal the correct answer (or any alias) in the question text.
Keep 'correct_answer' concise (1-3 words).
Also set a generic 'category' describing the answer type (e.g., Person, Location, Event, Work Title, Scientific Term).
Only use Google Search if the question requires very recent or obscure facts that may be beyond general knowledge.`;

    try {
        logger.debug({ topic: specificTopic }, `[TriviaService] Generating question via Structured Output.`);

        // Always provide Google Search tool — Gemini auto-decides whether to use it
        const tools = [{ googleSearch: {} }];

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: tools,
            generationConfig: {
                temperature: 0.7,
                responseMimeType: "application/json",
                responseSchema: TriviaQuestionSchema
            }
        });

        // Safe extraction of structured JSON
        const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
            logger.warn('[TriviaService] No text content in Gemini response.');
            return null;
        }

        let parsed;
        try {
            parsed = JSON.parse(responseText);
        } catch (e) {
            logger.warn({ err: e, text: responseText }, '[TriviaService] Failed to parse JSON response.');
            return null;
        }

        const { question, correct_answer, alternate_answers, explanation, difficulty: actualDiff, search_used, category } = parsed;

        // Guard: prevent answer leakage in question text
        const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const qNorm = normalize(question);
        const leakMatches = [];
        const checkLeak = (ans) => {
            const a = normalize(ans);
            if (!a || a.length < 4) return false;
            const re = new RegExp(`(^| )${a}( |$)`);
            return re.test(qNorm);
        };

        if (checkLeak(correct_answer)) leakMatches.push(correct_answer);
        if (Array.isArray(alternate_answers)) {
            for (const alt of alternate_answers) {
                if (checkLeak(alt)) { leakMatches.push(alt); break; }
            }
        }

        if (leakMatches.length > 0) {
            logger.warn(`[TriviaService] Question leaks answer in text (matches: ${leakMatches.join(', ')}). Rejecting.`);
            return null;
        }

        // Check exclusions again just in case
        if (excludedQuestions.includes(question)) {
            logger.warn(`[TriviaService] LLM generated an excluded question: "${question}". Returning null.`);
            return null;
        }

        // Derive searchUsed from actual response grounding metadata
        const actuallySearched = search_used || !!(result.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length);

        const questionObject = {
            question: question,
            answer: correct_answer,
            alternateAnswers: alternate_answers || [],
            explanation: explanation || "No explanation provided.",
            difficulty: actualDiff || difficulty,
            searchUsed: actuallySearched,
            verified: true, // Structured output = implicitly verified
            topic: isGeneralTopic ? 'general' : specificTopic,
            category: category || ""
        };

        logger.info(`[TriviaService] Successfully generated question (search=${actuallySearched}). Q: "${question}", A: "${correct_answer}"`);
        return questionObject;

    } catch (error) {
        logger.error({ err: error, topic: specificTopic }, '[TriviaService] Error generating trivia question.');
        return null;
    }
}

/**
 * Verifies a user's answer to a trivia question using Structured Output.
 * 
 * @param {string} correctAnswer
 * @param {string} userAnswer
 * @param {string[]} alternateAnswers
 * @param {string} question
 * @param {string} topic
 * @returns {Promise<object>}
 */
export async function verifyAnswer(correctAnswer, userAnswer, alternateAnswers = [], question = "", topic = "") {
    const model = getGeminiClient();

    if (!correctAnswer || !userAnswer) {
        return { is_correct: false, confidence: 1.0, reasoning: "Missing answer to verify", search_used: false };
    }

    // 1. Fast path: Exact/Alternate string match
    const normalize = (s) => {
        if (!s || typeof s !== 'string') return '';
        const cleaned = s
            .toLowerCase()
            .trim()
            .replace(/[-_''`]/g, ' ')
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/^[\s]*(?:the|a|an)\s+/i, '')
            .replace(/[\s]+/g, ' ');
        if (cleaned.endsWith('ies')) return cleaned.slice(0, -3) + 'y';
        if (cleaned.endsWith('ses')) return cleaned.slice(0, -2);
        if (cleaned.endsWith('s') && !cleaned.endsWith('ss')) return cleaned.slice(0, -1);
        return cleaned;
    };
    const lowerUser = normalize(userAnswer);
    const lowerCorrect = normalize(correctAnswer);

    if (lowerUser === lowerCorrect) {
        logger.debug(`[TriviaService] Exact match: User "${lowerUser}" vs Correct "${lowerCorrect}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with correct answer.", search_used: false };
    }
    // Secondary fast path: compare without spaces (handles "Hand unit" vs "HandUnit")
    const spacelessUser = lowerUser.replace(/\s/g, '');
    const spacelessCorrect = lowerCorrect.replace(/\s/g, '');
    if (spacelessUser && spacelessCorrect && spacelessUser === spacelessCorrect) {
        logger.debug(`[TriviaService] Spaceless match: User "${lowerUser}" vs Correct "${lowerCorrect}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match ignoring spaces.", search_used: false };
    }
    if (Array.isArray(alternateAnswers) && alternateAnswers.some(alt => normalize(alt) === lowerUser)) {
        logger.debug(`[TriviaService] Alternate match: User "${lowerUser}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with an alternate answer.", search_used: false };
    }
    // Spaceless check against alternates too
    if (Array.isArray(alternateAnswers) && alternateAnswers.some(alt => {
        const spacelessAlt = normalize(alt).replace(/\s/g, '');
        return spacelessAlt && spacelessUser === spacelessAlt;
    })) {
        logger.debug(`[TriviaService] Spaceless alternate match: User "${lowerUser}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with an alternate answer (ignoring spaces).", search_used: false };
    }

    // 2. Structured Verification via LLM
    const VerificationSchema = {
        type: GenAIType.OBJECT,
        properties: {
            is_correct: { type: GenAIType.BOOLEAN },
            confidence: { type: GenAIType.NUMBER },
            reasoning: { type: GenAIType.STRING }
        },
        required: ["is_correct", "confidence", "reasoning"]
    };

    const prompt = `Topic: ${topic || 'general'}
Question: "${question}"
Correct Answer: "${correctAnswer}"
Alternate Answers: ${Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Answer: "${userAnswer}"

Verify if the Player's Answer is correct. 
- It should be accepted if it matches the correct answer or alternates conceptually, phonetically (minor typos), or is a valid synonym/alias.
- Reject if it is a completely different answer.

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
            logger.info({ userAnswer, is_correct: parsed.is_correct, reasoning: parsed.reasoning }, '[TriviaService] Verified via Structured Output.');
            return {
                is_correct: parsed.is_correct,
                confidence: parsed.confidence,
                reasoning: parsed.reasoning,
                search_used: false
            };
        }
    } catch (error) {
        logger.error({ err: error }, '[TriviaService] Error using structured verification. Falling back to similarity.');
    }

    // 3. Fallback: Similarity
    const simToCorrect = calculateStringSimilarity(lowerCorrect, lowerUser);
    const bestAltSim = Array.isArray(alternateAnswers) && alternateAnswers.length > 0
        ? Math.max(...alternateAnswers.map(alt => calculateStringSimilarity(normalize(alt), lowerUser)))
        : 0;

    const isFallbackCorrect = simToCorrect > 0.8 || bestAltSim > 0.8;
    return {
        is_correct: isFallbackCorrect,
        confidence: isFallbackCorrect ? 0.85 : 0.15,
        reasoning: isFallbackCorrect ? 'Similarity/alt match (fallback).' : 'No structured result; similarity low.',
        search_used: false
    };
}

/**
 * Generates an explanation for a trivia answer.
 */
export async function generateExplanation(question, answer, topic = "general") {
    const model = getGeminiClient();
    const prompt = `Provide a brief, interesting explanation for this trivia answer:
    
Question: ${question}
Answer: ${answer}
Topic: ${topic}

Your explanation should be informative, engaging, and around 1-2 sentences long.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7 }
        });
        return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || `The correct answer is ${answer}.`;
    } catch (error) {
        logger.error({ err: error }, 'Error generating explanation');
        return `The correct answer is ${answer}.`;
    }
}