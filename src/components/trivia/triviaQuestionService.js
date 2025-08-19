// src/components/trivia/triviaQuestionService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient } from '../llm/geminiClient.js';

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
                }
            },
            required: ["question", "correct_answer", "explanation", "difficulty", "search_used"]
        }
    }]
};

// (Removed function-calling tool for verification; using text-based verification only)

// --- Helper: Fallback to Explicit Search ---
async function generateQuestionWithExplicitSearch(topic, difficulty, excludedQuestions = [], _channelName = null, excludedAnswers = []) {
    const model = getGeminiClient();
    const exclusionInstructionQuestions = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';
    const exclusionInstructionAnswers = excludedAnswers.length > 0
        ? `\nIMPORTANT: Also, AVOID generating a question if its most likely concise answer is one of these recently used answers: ${excludedAnswers.map(a => `"${a}"`).join(', ')}. Aim for variety.`
        : '';

    // STEP 1: Search for facts about the topic - SIMPLIFIED PROMPT
    const searchFactsPrompt = `Find interesting facts about "${topic}" for a ${difficulty} trivia question. Focus on characters, plot points, lore, and unique details.${exclusionInstructionQuestions}${exclusionInstructionAnswers}\nReturn facts as text. Do not call functions.`;
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
    const generateQuestionPrompt = `Using these facts about "${topic}":\n\nFACTS:\n${factualInfoText}\n\nGenerate an engaging trivia question.${exclusionInstructionQuestions}${exclusionInstructionAnswers}\nDifficulty: ${difficulty}.\n\nCall 'generate_trivia_question' function. Keep 'correct_answer' concise (1-3 words). Set 'search_used: true'.`;

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
                topic: topic
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
    const exclusionInstructionQuestions = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';
    const exclusionInstructionAnswers = excludedAnswers.length > 0
        ? `\nIMPORTANT: Also, AVOID generating a question if its most likely concise answer is one of these recently used answers: ${excludedAnswers.map(a => `"${a}"`).join(', ')}. Aim for variety.`
        : '';

    const functionCallPrompt = `Generate an engaging general knowledge trivia question.\nDifficulty: ${difficulty}.${exclusionInstructionQuestions}${exclusionInstructionAnswers}\n\nCall 'generate_trivia_question' function. Keep 'correct_answer' concise (1-3 words). Set 'search_used: false'.`;
    
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
            topic: 'general'
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
export async function verifyAnswer(correctAnswer, userAnswer, alternateAnswers = [], question = "") {
    const model = getGeminiClient();
    if (!correctAnswer || !userAnswer) {
        return { is_correct: false, confidence: 1.0, reasoning: "Missing answer to verify", search_used: false };
    }

    const normalize = (s) => {
        if (!s || typeof s !== 'string') return '';
        const cleaned = s
            .toLowerCase()
            .trim()
            .replace(/[\-_'’`]/g, ' ')
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
        // First attempt: function-calling for structured decision
        const verifyTool = {
            functionDeclarations: [{
                name: 'report_verification',
                description: 'Report the decision for whether the player\'s answer is correct for this specific trivia question.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        is_correct: { type: 'BOOLEAN' },
                        confidence: { type: 'NUMBER' },
                        reasoning: { type: 'STRING' }
                    },
                    required: ['is_correct', 'confidence', 'reasoning']
                }
            }]
        };

        const verificationPrompt = `Question: "${question}"
Correct Answer: "${correctAnswer}"
Alternate Answers: ${Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Answer: "${userAnswer}"

Decide correctness (accept exact, close synonyms, obvious misspellings). Call 'report_verification' with is_correct, confidence (0.0-1.0), and a short reasoning.`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: verificationPrompt }] }],
            tools: [verifyTool],
            toolConfig: { functionCallingConfig: { mode: 'ANY' } },
            systemInstruction: { parts: [{ text: 'You verify trivia answers and must call report_verification.' }] },
            generationConfig: { temperature: 0.1, maxOutputTokens: 120 }
        });

        const candidate = result.response?.candidates?.[0];
        const fn = candidate?.content?.parts?.[0]?.functionCall;
        let isCorrectByLLM = false;
        let reasoningFromLLM = '';
        let confidenceFromLLM = 0.0;
        if (fn?.name === 'report_verification') {
            const args = fn.args || {};
            if (typeof args.is_correct === 'boolean') {
                isCorrectByLLM = args.is_correct;
                reasoningFromLLM = (args.reasoning || '').toString().trim();
                confidenceFromLLM = typeof args.confidence === 'number' ? args.confidence : (isCorrectByLLM ? 0.9 : 0.1);
            }
        }
        if (!fn) {
            // Fallback to strict JSON text parsing
            const parts = candidate?.content?.parts || [];
            let responseText = parts.map(p => p.text || '').join('').trim();
            responseText = responseText.replace(/^```json\s*|```\s*$/g, '').trim();
            if (!(responseText.startsWith('{') && responseText.endsWith('}'))) {
                const i = responseText.indexOf('{');
                const j = responseText.lastIndexOf('}');
                if (i !== -1 && j !== -1 && j > i) responseText = responseText.substring(i, j + 1);
            }
            try {
                const parsed = JSON.parse(responseText);
                isCorrectByLLM = !!parsed.is_correct;
                reasoningFromLLM = (parsed.reasoning || '').toString().trim();
                confidenceFromLLM = typeof parsed.confidence === 'number' ? parsed.confidence : (isCorrectByLLM ? 0.9 : 0.1);
            } catch (_) {
                logger.warn('[TriviaService] Could not parse verification JSON. Defaulting to conservative result.');
                isCorrectByLLM = false;
                reasoningFromLLM = '';
                confidenceFromLLM = 0.1;
            }
            // Fallback attempt 2: Structured output with responseSchema
            if (reasoningFromLLM.length === 0) {
                try {
                    const structured = await model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: verificationPrompt }] }],
                        generationConfig: {
                            responseMimeType: 'application/json',
                            responseSchema: {
                                type: 'object',
                                properties: {
                                    is_correct: { type: 'boolean' },
                                    confidence: { type: 'number' },
                                    reasoning: { type: 'string' }
                                },
                                required: ['is_correct', 'confidence', 'reasoning']
                            },
                            temperature: 0.1,
                            maxOutputTokens: 120
                        }
                    });
                    const sText = structured.response?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim() || '';
                    if (sText) {
                        const parsed = JSON.parse(sText);
                        isCorrectByLLM = !!parsed.is_correct;
                        reasoningFromLLM = (parsed.reasoning || '').toString().trim();
                        confidenceFromLLM = typeof parsed.confidence === 'number' ? parsed.confidence : (isCorrectByLLM ? 0.9 : 0.1);
                    }
                } catch (se) {
                    logger.warn({ err: se?.message }, '[TriviaService] Structured-output attempt failed. Proceeding.');
                }
            }
        }
        if (!reasoningFromLLM || /considered (in)?correct by the LLM\./i.test(reasoningFromLLM)) {
            try {
                const reasoningPrompt = `Explain why the player's answer is ${isCorrectByLLM ? 'CORRECT' : 'INCORRECT'}.

Question: "${question}"
Correct Answer: "${correctAnswer}"
Player's Answer: "${userAnswer}"

Write ONE short sentence (≤20 words) explaining the decision.`;
                const reasoningResp = await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: reasoningPrompt }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 60 }
                });
                const rtext = reasoningResp.response?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
                if (rtext && rtext.length > 0) {
                    reasoningFromLLM = rtext.replace(/^```[a-zA-Z]*\s*|```\s*$/g, '').trim();
                }
            } catch (_) {
                // ignore; keep fallback below
            }
            if (!reasoningFromLLM || reasoningFromLLM.length === 0) {
                reasoningFromLLM = isCorrectByLLM ? "Matches the intended answer." : "Does not match the intended answer or alternates.";
            }
        }

        const similarityToCorrect = calculateStringSimilarity(lowerCorrectAnswer, lowerUserAnswer);
        const bestAlternateSimilarity = Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? Math.max(...alternateAnswers.map(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer))) : 0;

        // If LLM says CORRECT, but no direct/alternate match was found earlier,
        // and string similarity is very low, this is a high-risk acceptance.
        // We log it but trust the LLM's reasoning based on the improved prompt.
        if (isCorrectByLLM && similarityToCorrect < 0.4 && bestAlternateSimilarity < 0.7) { 
             logger.warn(`[TriviaService] LLM verified as CORRECT, but string similarity to official answer is low (${similarityToCorrect.toFixed(2)}) and no strong alternate string match. User: "${userAnswer}", Correct: "${correctAnswer}". Trusting LLM reasoning: "${reasoningFromLLM}"`);
        }
        
        logger.info(`[TriviaService] LLM Verification - Input: "${userAnswer}", Expected: "${correctAnswer}", LLM Verdict: ${isCorrectByLLM}, Reasoning: ${reasoningFromLLM}, Similarity: ${similarityToCorrect.toFixed(2)}`);
        return {
            is_correct: isCorrectByLLM,
            confidence: isCorrectByLLM ? (similarityToCorrect > 0.85 || bestAlternateSimilarity > 0.85 ? 0.98 : 0.9) : (1.0 - Math.max(similarityToCorrect, bestAlternateSimilarity)),
            reasoning: reasoningFromLLM,
            search_used: false 
        };

    } catch (error) {
        logger.error({ err: error }, '[TriviaService] Error verifying answer with LLM. Falling back to basic similarity.');
        const similarity = calculateStringSimilarity(lowerCorrectAnswer, lowerUserAnswer);
        let isFallbackCorrect = similarity > 0.8; 

        if (!isFallbackCorrect && Array.isArray(alternateAnswers) && alternateAnswers.some(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer) > 0.8)) {
            isFallbackCorrect = true;
        }

        return {
            is_correct: isFallbackCorrect,
            confidence: similarity,
            reasoning: `Similarity check: ${Math.round(similarity * 100)}% (LLM fallback).`,
            search_used: false
        };
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