// src/components/trivia/triviaQuestionService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient } from '../llm/geminiClient.js';
import { GoogleGenAI, Type as GenAIType } from '@google/genai';

// Function declaration for generating trivia questions
const triviaQuestionTool = {
    functionDeclarations: [{
        name: "generate_trivia_question",
        description: "Generates a factually accurate trivia question with answer based on the given criteria.",
        parameters: {
            type: "OBJECT",
            properties: {
                question: {
                    type: "STRING",
                    description: "The trivia question to ask."
                },
                correct_answer: {
                    type: "STRING",
                    description: "The single, most accurate, AND VERY CONCISE answer (ideally a proper noun, specific term, or 1-3 key words). Avoid full sentences or overly descriptive phrases; these belong in the 'explanation'."
                },
                alternate_answers: {
                    type: "ARRAY",
                    description: "Alternative correct and VERY CONCISE answers or common, acceptable variations (each ideally 1-3 key words).",
                    items: {
                        type: "STRING"
                    }
                },
                explanation: {
                    type: "STRING",
                    description: "Brief explanation of why the answer is correct, can include more descriptive details that are not part of the concise answer."
                },
                difficulty: {
                    type: "STRING",
                    description: "The difficulty level of this question (easy, normal, hard)."
                },
                search_used: {
                    type: "BOOLEAN",
                    description: "Whether external search was required to ensure accuracy."
                },
                category: {
                    type: "STRING",
                    description: "A specific category for the answer (e.g., Person, Location, Event, Work Title, Scientific Term). Keep generic and domain-agnostic."
                }
            },
            required: ["question", "correct_answer", "explanation", "difficulty", "search_used", "category"]
        }
    }]
};

// (Removed function-calling tool for verification; using text-based verification only)

// --- Helper: Fallback to Explicit Search ---
async function generateQuestionWithExplicitSearch(topic, difficulty, excludedQuestions = [], _channelName = null, excludedAnswers = []) {
    const model = getGeminiClient();
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

    // STEP 1: Search for facts about the topic - SIMPLIFIED PROMPT
    const searchFactsPrompt = `Find reliable, neutral facts about "${topic}" suitable for a ${difficulty} trivia question. Focus on clear, verifiable details and relationships between entities (avoid conflating entity types, like a person vs. a role, a work vs. its creator).${exclusionInstructionText}\nReturn facts as text. Do not call functions.`;
    let factualInfoText = "";

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 1: Searching for facts about "${topic}"`);
        const searchResult = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: searchFactsPrompt }] }],
            tools: [{ googleSearch: {} }], // Only search tool for this call
            generationConfig: { maxOutputTokens: 512 }
        });
        
        factualInfoText = searchResult.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!factualInfoText || factualInfoText.trim() === "") {
            logger.warn(`[TriviaService-ExplicitSearch] Step 1: No factual information returned from search for topic "${topic}".`);
            return null;
        }
        logger.debug(`[TriviaService-ExplicitSearch] Step 1: Successfully retrieved facts for "${topic}". Length: ${factualInfoText.length}`);

    } catch (searchError) {
        logger.error({ err: searchError, topic }, `[TriviaService-ExplicitSearch] Step 1: Error during search for facts about "${topic}".`);
        return null; 
    }

    // STEP 2: Use the gathered facts to generate a structured question via function call - SIMPLIFIED PROMPT
    const generateQuestionPrompt = `Using these facts about "${topic}":\n\nFACTS:\n${factualInfoText}\n\nGenerate an engaging trivia question.${exclusionInstructionText}\nDifficulty: ${difficulty}.\nBe precise about entity types and relationships.\n\nCall 'generate_trivia_question' function. Keep 'correct_answer' concise (1-3 words). Set 'search_used: true'. Also set a generic 'category' describing the answer type (e.g., Person, Location, Event, Work Title, Scientific Term).`;

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 2: Generating structured question for "${topic}" with updated concise answer/alternate guidance.`);
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: generateQuestionPrompt }] }],
            tools: [triviaQuestionTool], // Only the function tool for this call
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY",
                }
            },
            generationConfig: { maxOutputTokens: 512 }
        });

        const functionCall = result.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
        if (functionCall?.name === 'generate_trivia_question') {
            const args = functionCall.args;
            const questionText = args.question || "";
            const correctAnswerText = args.correct_answer || "";
            const explanationText = args.explanation || "No explanation provided.";
            const actualDifficulty = args.difficulty || difficulty;
            const alternateAnswersList = args.alternate_answers || [];
            const category = args.category || "";

            if (!questionText || !correctAnswerText) {
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: Func call 'generate_trivia_question' missing Q or A. Args: ${JSON.stringify(args)}`);
                return null;
            }
            // Heuristic: Warn if answer is too long
            if (correctAnswerText.split(' ').length > 7 && correctAnswerText.length > 40) { 
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: Generated 'correct_answer' may be too long: "${correctAnswerText}". Length: ${correctAnswerText.length}, Words: ${correctAnswerText.split(' ').length}`);
            }
            
            const questionObject = {
                question: questionText,
                answer: correctAnswerText,
                alternateAnswers: alternateAnswersList,
                explanation: explanationText,
                difficulty: actualDifficulty,
                searchUsed: true, 
                verified: true,   // Mark as verified since it is search-based
                topic: topic,
                category
            };

            if (excludedQuestions.includes(questionObject.question)) {
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: LLM generated an excluded question: "${questionObject.question}". Returning null.`);
                return null;
            }
            logger.info(`[TriviaService-ExplicitSearch] Step 2: Successfully generated question for topic "${topic}". Answer: "${correctAnswerText}", Alternates: "${alternateAnswersList.join(', ')}"`);
            return questionObject;
        }
        logger.warn(`[TriviaService-ExplicitSearch] Step 2: Model did not call 'generate_trivia_question' for topic "${topic}". Resp: ${JSON.stringify(result.response)}`);
        return null;
    } catch (error) {
        logger.error({ err: error, topic }, `[TriviaService-ExplicitSearch] Step 2: Error generating structured question for topic "${topic}".`);
        return null;
    }
}

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


// enhanceWithFactualInfo function removed - was unused

// --- Helper: String similarity (Levenshtein) ---
function calculateStringSimilarity(str1, str2) {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    const len1 = s1.length;
    const len2 = s2.length;
    const maxLen = Math.max(len1, len2);
    if (maxLen === 0) return 1.0;
    // Levenshtein distance
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
    const distance = dp[len1][len2];
    return 1 - (distance / maxLen);
}

// formatTriviaParts function removed - was unused

/**
 * Generates a trivia question based on topic and difficulty.
 * Uses a two-step approach: (1) search for facts if needed, (2) generate the question using those facts or standard prompt.
 * Now includes logic to exclude specific QUESTIONS and ANSWERS.
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
    
    // Determine if we need search-based generation for specific topics
    const isGeneralTopic = !specificTopic || specificTopic.toLowerCase() === 'general' || specificTopic.toLowerCase() === 'general knowledge';
    
    if (!isGeneralTopic) {
        // For specific topics, use the existing search-based approach which is more reliable for factual accuracy
        logger.info(`[TriviaService] Specific topic "${specificTopic}" identified. Using search-based question generation.`);
        return generateQuestionWithExplicitSearch(specificTopic, difficulty, excludedQuestions, channelName, excludedAnswers);
    }

    // For general knowledge, use function calling for reliability
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

    const functionCallPrompt = `Generate an engaging general knowledge trivia question.\nDifficulty: ${difficulty}.${exclusionInstructionText}\nBe precise about entity types and relationships.\n\nCall 'generate_trivia_question' function. Keep 'correct_answer' concise (1-3 words). Set 'search_used: false'. Also set a generic 'category' describing the answer type (e.g., Person, Location, Event, Work Title, Scientific Term).`;
    
    try {
        logger.debug(`[TriviaService] Generating general knowledge trivia question using function calling.`);
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: functionCallPrompt }] }],
            tools: [triviaQuestionTool],
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY",
                }
            },
            generationConfig: {
                temperature: 0.7, 
                maxOutputTokens: 512
            }
        });
        
        const response = result.response;
        const candidate = response?.candidates?.[0];
        
        if (!candidate) {
            logger.warn('[TriviaService] No candidate found in Gemini response.');
            return null;
        }
        
        
        const functionCall = candidate.content?.parts?.[0]?.functionCall;
        if (!functionCall || functionCall.name !== 'generate_trivia_question') {
            logger.warn(`[TriviaService] Expected function call 'generate_trivia_question' but got: ${functionCall?.name || 'none'}`);
            return null;
        }
        
        const args = functionCall.args;
        const questionText = args.question || "";
        const correctAnswerText = args.correct_answer || "";
        const explanationText = args.explanation || "No explanation provided.";
        const actualDifficulty = args.difficulty || difficulty;
        const alternateAnswersList = args.alternate_answers || [];
        const searchUsed = args.search_used || false;
        const category = args.category || "";

        if (!questionText || !correctAnswerText) {
            logger.warn(`[TriviaService] Function call 'generate_trivia_question' missing question or answer. Args: ${JSON.stringify(args)}`);
            return null;
        }
        
        // Heuristic: Warn if answer is too long
        if (correctAnswerText.split(' ').length > 7 && correctAnswerText.length > 40) { 
            logger.warn(`[TriviaService] Generated 'correct_answer' may be too long: "${correctAnswerText}". Length: ${correctAnswerText.length}, Words: ${correctAnswerText.split(' ').length}`);
        }
        
        const questionObject = {
            question: questionText,
            answer: correctAnswerText,
            alternateAnswers: alternateAnswersList,
            explanation: explanationText,
            difficulty: actualDifficulty,
            searchUsed: searchUsed, 
            verified: true,   // Mark as verified since using function calling
            topic: 'general',
            category
        };

        if (excludedQuestions.includes(questionObject.question)) {
            logger.warn(`[TriviaService] LLM generated an excluded question: "${questionObject.question}". Returning null.`);
            return null;
        }
        
        logger.info(`[TriviaService] Successfully generated general knowledge question. Answer: "${correctAnswerText}", Alternates: "${alternateAnswersList.join(', ')}"`);
        return questionObject;
        
    } catch (error) {
        logger.error({ err: error }, '[TriviaService] Error generating general knowledge trivia question using function calling');
        return null;
    }
}

/**
 * Verifies if a user's answer matches the expected answer.
 * Uses a two-step approach: (1) basic string/alternate match, (2) if needed, do a separate search call for semantic equivalence.
 * @param {string} correctAnswer
 * @param {string} userAnswer
 * @param {string[]} alternateAnswers
 * @param {string} question
 * @returns {Promise<object>}
 */
export async function verifyAnswer(correctAnswer, userAnswer, alternateAnswers = [], question = "", topic = "") {
    // Structured-output verification via @google/genai (schema-first)
    if (!globalThis.__genaiClient) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
        globalThis.__genaiClient = new GoogleGenAI({ apiKey });
    }
    const genaiModels = globalThis.__genaiClient.models;
    const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash';
    if (!correctAnswer || !userAnswer) {
        return { is_correct: false, confidence: 1.0, reasoning: "Missing answer to verify", search_used: false };
    }

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
    const lowerUserAnswer = normalize(userAnswer);
    const lowerCorrectAnswer = normalize(correctAnswer);

    if (lowerUserAnswer === lowerCorrectAnswer) {
        logger.debug(`[TriviaService] Exact match: User "${lowerUserAnswer}" vs Correct "${lowerCorrectAnswer}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with correct answer.", search_used: false };
    }
    // Ensure alternateAnswers is an array and then check
    if (Array.isArray(alternateAnswers) && alternateAnswers.some(alt => alt.toLowerCase().trim() === lowerUserAnswer)) {
        logger.debug(`[TriviaService] Alternate match: User "${lowerUserAnswer}" vs Alternates "${alternateAnswers.join(',')}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with an alternate answer.", search_used: false };
    }

    try {
        const extractText = (resp) => {
            const cand = resp?.candidates?.[0];
            if (Array.isArray(cand?.content?.parts) && cand.content.parts.length > 0) {
                return cand.content.parts.map(p => p?.text || '').join('').trim();
            }
            if (cand && typeof cand.text === 'string' && cand.text.trim().length > 0) {
                return cand.text.trim();
            }
            if (resp && typeof resp.text === 'function') {
                const t = resp.text();
                return typeof t === 'string' ? t.trim() : '';
            }
            if (resp && typeof resp.text === 'string') {
                return resp.text.trim();
            }
            return '';
        };
        const coerceParsed = (resp) => {
            try {
                const parsed = resp?.parsed;
                if (parsed && typeof parsed.is_correct === 'boolean') return parsed;
            } catch (_) { /* Ignore errors */ }
            return null;
        };
        const tryParseJsonString = (raw) => {
            if (!raw || typeof raw !== 'string') return null;
            try { return JSON.parse(raw); } catch (_) { /* Ignore parse errors */ }
            const i = raw.indexOf('{');
            const j = raw.lastIndexOf('}');
            if (i !== -1 && j !== -1 && j > i) {
                try { return JSON.parse(raw.substring(i, j + 1).trim()); } catch (_) { /* Ignore parse errors */ }
            }
            return null;
        };

        const prompt = `Topic: ${topic || 'general'}
Question: "${question}"
Correct Answer: "${correctAnswer}"
Alternate Answers: ${Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Answer: "${userAnswer}"

Return JSON ONLY: {"is_correct": boolean, "confidence": number, "reasoning": string}`;

        const genWithSchema = async (maxTokens = 512, minimalPrompt = false) => {
            const textForModel = minimalPrompt
                ? `Topic: ${topic || 'general'}
Question: "${question}"
Correct Answer: "${correctAnswer}"
Alternate Answers: ${Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Answer: "${userAnswer}"

Return JSON ONLY: {"is_correct": boolean, "confidence": number, "reasoning": string}. Keep reasoning under 6 words.`
                : prompt;
            const res = await genaiModels.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts: [{ text: textForModel }] }],
                config: {
                    temperature: 0.0,
                    maxOutputTokens: maxTokens,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: GenAIType.OBJECT,
                        properties: {
                            is_correct: { type: GenAIType.BOOLEAN },
                            confidence: { type: GenAIType.NUMBER },
                            reasoning: { type: GenAIType.STRING }
                        },
                        propertyOrdering: ['is_correct', 'confidence', 'reasoning'],
                        required: ['is_correct', 'confidence', 'reasoning']
                    }
                },
                systemInstruction: { parts: [{ text: 'You verify trivia answers. Output ONLY JSON matching the schema; no preface.' }] }
            });
            return { response: res };
        };

        let schemaResp;
        try {
            schemaResp = await genWithSchema(512, false);
        } catch (e1) {
            const msg = String(e1?.message || '');
            if (/\b(500|internal error)\b/i.test(msg)) {
                await new Promise(r => setTimeout(r, 200));
                try { schemaResp = await genWithSchema(512, false); } catch (e2) {
                    const msg2 = String(e2?.message || '');
                    if (/\b(500|internal error)\b/i.test(msg2)) {
                        await new Promise(r => setTimeout(r, 400));
                        schemaResp = await genWithSchema(512, false);
                    } else { throw e2; }
                }
            } else { throw e1; }
        }

        const fin = schemaResp?.response?.candidates?.[0]?.finishReason;
        const respObj = schemaResp.response;
        let structured = coerceParsed(respObj);
        let sText = '';
        if (respObj && typeof respObj.text === 'string' && respObj.text.trim().length > 0) sText = respObj.text.trim();
        else sText = extractText(respObj) || '';
        if (!sText && !structured) {
            try {
                const parts = Array.isArray(respObj?.candidates) ? (respObj.candidates[0]?.content?.parts || []) : [];
                const joined = parts.map(p => p?.text || '').join('').trim();
                if (joined) sText = joined;
            } catch (_) { /* Ignore errors */ }
        }
        if ((!sText && !structured) || fin === 'MAX_TOKENS') {
            try {
                const high = await genWithSchema(1024, false);
                const ro = high.response;
                structured = coerceParsed(ro) || structured;
                const textHigh = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                if (textHigh) sText = textHigh;
            } catch (_) { /* Ignore errors */ }
        }
        if (!sText && !structured) {
            try {
                const min = await genWithSchema(256, true);
                const ro = min.response;
                structured = coerceParsed(ro) || structured;
                const textMin = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                if (textMin) sText = textMin;
            } catch (_) { /* Ignore errors */ }
        }
        if (structured && typeof structured.is_correct === 'boolean') {
            try {
                logger.info(`[TriviaService] Structured verification: guess "${userAnswer}", correct "${correctAnswer}" -> ${structured.is_correct} (conf ${typeof structured.confidence === 'number' ? structured.confidence : 'n/a'}). Reason: ${structured.reasoning || ''}`);
            } catch (_) { /* Ignore errors */ }
            return { is_correct: structured.is_correct, confidence: typeof structured.confidence === 'number' ? structured.confidence : (structured.is_correct ? 0.9 : 0.1), reasoning: structured.reasoning || '', search_used: false };
        }
        if (sText) {
            let parsed = tryParseJsonString(sText);
            const looksTruncated = sText.includes('{') && !sText.trim().endsWith('}');
            if ((!parsed || looksTruncated) && !structured) {
                try {
                    const repair = await genWithSchema(1024, false);
                    const ro = repair.response;
                    structured = coerceParsed(ro) || structured;
                    const textRepair = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                    if (textRepair) { sText = textRepair; parsed = tryParseJsonString(sText); }
                } catch (_) { /* Ignore errors */ }
            }
            if (parsed && typeof parsed.is_correct === 'boolean') {
                try {
                    logger.info(`[TriviaService] Parsed-json verification: guess "${userAnswer}", correct "${correctAnswer}" -> ${parsed.is_correct} (conf ${typeof parsed.confidence === 'number' ? parsed.confidence : 'n/a'}). Reason: ${parsed.reasoning || ''}`);
                } catch (_) { /* Ignore errors */ }
                return { is_correct: parsed.is_correct, confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.is_correct ? 0.9 : 0.1), reasoning: parsed.reasoning || '', search_used: false };
            }
        }

        // Final conservative fallback: similarity only
        const simToCorrect = calculateStringSimilarity(lowerCorrectAnswer, lowerUserAnswer);
        const bestAltSim = Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? Math.max(...alternateAnswers.map(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer))) : 0;
        const isFallbackCorrect = simToCorrect > 0.8 || bestAltSim > 0.8;
        return { is_correct: isFallbackCorrect, confidence: isFallbackCorrect ? 0.85 : 0.15, reasoning: isFallbackCorrect ? 'Similarity/alt match (fallback).' : 'No structured result; similarity low.', search_used: false };

    } catch (error) {
        logger.error({ err: error }, '[TriviaService] Error verifying answer with structured output. Falling back to basic similarity.');
        const similarity = calculateStringSimilarity(lowerCorrectAnswer, lowerUserAnswer);
        let isFallbackCorrect = similarity > 0.8; 
        if (!isFallbackCorrect && Array.isArray(alternateAnswers) && alternateAnswers.some(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer) > 0.8)) isFallbackCorrect = true;
        return { is_correct: isFallbackCorrect, confidence: similarity, reasoning: `Similarity check: ${Math.round(similarity * 100)}% (LLM fallback).`, search_used: false };
    }
}

/**
 * Generates an explanation for a trivia answer.
 * 
 * @param {string} question - The trivia question
 * @param {string} answer - The correct answer
 * @param {string} topic - The topic of the question
 * @returns {Promise<string>} Explanation text
 */
export async function generateExplanation(question, answer, topic = "general") {
    const model = getGeminiClient();
    
    // Simple prompt for explanation
    const prompt = `Provide a brief, interesting explanation for this trivia answer:
    
Question: ${question}
Answer: ${answer}
Topic: ${topic}

Your explanation should be informative, engaging, and around 1-2 sentences long.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: 256, // Keep it concise
                temperature: 0.7
            }
        });
        
        const response = result.response;
        if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
            return response.candidates[0].content.parts[0].text.trim();
        }
        
        return `The correct answer is ${answer}.`;
    } catch (error) {
        logger.error({ err: error }, 'Error generating explanation');
        return `The correct answer is ${answer}.`;
    }
}