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
                    description: "The single, most accurate answer to the question."
                },
                alternate_answers: {
                    type: "ARRAY",
                    description: "Alternative correct answers or acceptable variations.",
                    items: {
                        type: "STRING"
                    }
                },
                explanation: {
                    type: "STRING",
                    description: "Brief explanation of why the answer is correct."
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

// Function declaration for verifying trivia answers
const triviaVerificationTool = {
    functionDeclarations: [{
        name: "verify_trivia_answer",
        description: "Verifies if the user's answer is correct for the given trivia question.",
        parameters: {
            type: "OBJECT",
            properties: {
                is_correct: {
                    type: "BOOLEAN",
                    description: "Whether the user's answer is correct or not."
                },
                confidence: {
                    type: "NUMBER",
                    description: "Confidence score (0.0-1.0) that the answer is correct or incorrect."
                },
                reasoning: {
                    type: "STRING",
                    description: "Brief explanation of why the answer is correct or incorrect."
                },
                search_used: {
                    type: "BOOLEAN",
                    description: "Whether external search was required to verify the answer."
                }
            },
            required: ["is_correct", "confidence", "reasoning", "search_used"]
        }
    }]
};

// --- Helper: Validate Question Factuality ---
async function validateQuestionFactuality(question, answer, topic) {
    // Skip validation for general knowledge questions
    if (!topic || topic === 'general') return { valid: true };
    const model = getGeminiClient();
    const prompt = `Verify if this trivia question and answer are factually accurate:\n\nQuestion: ${question}\nAnswer: ${answer}\nTopic: ${topic}\n\nUse search to verify if this contains accurate information. If this appears to be about a fictional entity or contains made-up details that don't exist, flag it as potentially hallucinated.\n\nReturn only a JSON object with: \n{ \"valid\": boolean, \"confidence\": number, \"reason\": string }`;
    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }]
        });
        const text = result.response.candidates[0].content.parts[0].text;
        try {
            const validation = JSON.parse(text);
            return validation;
        } catch (e) {
            return { valid: false, confidence: 0, reason: "Could not validate question factuality" };
        }
    } catch (error) {
        logger.error({ err: error }, 'Error validating question factuality');
        return { valid: true }; // Default to valid on error
    }
}

// --- Helper: Fallback to Explicit Search ---
async function generateQuestionWithExplicitSearch(topic, difficulty, excludedQuestions = [], channelName = null) {
    const model = getGeminiClient();
    const exclusionInstruction = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';

    // STEP 1: Search for facts about the topic
    const searchFactsPrompt = `First, find verified factual information about "${topic}" that can be used to create a ${difficulty} trivia question. Focus on specific, verifiable details. ${exclusionInstruction}\n\nReturn the gathered facts as a text block. Do not call any functions in this step.`;
    let factualInfoText = "";

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 1: Searching for facts about "${topic}"`);
        const searchResult = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: searchFactsPrompt }] }],
            tools: [{ googleSearch: {} }], // Only search tool for this call
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

    // STEP 2: Use the gathered facts to generate a structured question via function call
    const generateQuestionPrompt = `Using ONLY the following factual information about "${topic}":\n\nFACTS:\n${factualInfoText}\n\nCRITICAL: Generate a trivia question based SOLELY on these facts.\nDifficulty level: ${difficulty}.${exclusionInstruction}\nYou MUST call the 'generate_trivia_question' function to structure your response. Ensure the 'search_used' field in the function call is true.`;

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 2: Generating structured question for "${topic}" using retrieved facts.`);
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: generateQuestionPrompt }] }],
            tools: [triviaQuestionTool], // Only the function tool for this call
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY",
                }
            }
        });

        const functionCall = result.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
        if (functionCall?.name === 'generate_trivia_question') {
            const args = functionCall.args;
            const question = args.question || "";
            const correctAnswer = args.correct_answer || "";
            const explanation = args.explanation || "No explanation provided.";
            const actualDifficulty = args.difficulty || difficulty;

            if (!question || !correctAnswer) {
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: Function call 'generate_trivia_question' missing question or answer. Args: ${JSON.stringify(args)}`);
                return null;
            }
            
            const questionObject = {
                question: question,
                answer: correctAnswer,
                alternateAnswers: args.alternate_answers || [],
                explanation: explanation,
                difficulty: actualDifficulty,
                searchUsed: true, 
                verified: true,   // Mark as verified since it is search-based
                topic: topic
            };

            if (excludedQuestions.includes(questionObject.question)) {
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: LLM generated an excluded question: "${questionObject.question}". Returning null.`);
                return null;
            }
            logger.info(`[TriviaService-ExplicitSearch] Step 2: Successfully generated question for topic "${topic}"`);
            return questionObject;
        }
        logger.warn(`[TriviaService-ExplicitSearch] Step 2: Model did not call 'generate_trivia_question' function as expected for topic "${topic}". Response: ${JSON.stringify(result.response)}`);
        return null;
    } catch (error) {
        logger.error({ err: error, topic }, `[TriviaService-ExplicitSearch] Step 2: Error generating structured question for topic "${topic}".`);
        if (error.message && error.message.includes("Unsupported MimeType")) {
             logger.error("[TriviaService-ExplicitSearch] Detected 'Unsupported MimeType' error. This might indicate an issue with the API request structure or the content being processed.");
        } else if (error.message && error.message.includes("function calling is unsupported")) {
             logger.error("[TriviaService-ExplicitSearch] Detected 'function calling is unsupported' error. This suggests an issue with how the function tool is configured or used with the current model/API version for this specific call.");
        }
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

// --- Helper: Parse question text into parts (very basic, can be improved) ---
function parseQuestionText(text) {
    // Try to extract Q/A/Explanation from a block of text
    // Look for lines like: Question: ... Answer: ... Explanation: ...
    const parts = { question: '', answer: '', alternateAnswers: [], explanation: '' };
    const qMatch = text.match(/Question:\s*(.*)/i);
    const aMatch = text.match(/Answer:\s*(.*)/i);
    const eMatch = text.match(/Explanation:\s*(.*)/i);
    if (qMatch) parts.question = qMatch[1].trim();
    if (aMatch) parts.answer = aMatch[1].trim();
    if (eMatch) parts.explanation = eMatch[1].trim();
    // Try to find alternate answers
    const altMatch = text.match(/Alternate Answers?:\s*(.*)/i);
    if (altMatch) {
        parts.alternateAnswers = altMatch[1].split(/,|\bor\b/).map(s => s.trim()).filter(Boolean);
    }
    // Fallback: if no explicit fields, treat first line as question, second as answer
    if (!parts.question && text) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 0) parts.question = lines[0];
        if (lines.length > 1) parts.answer = lines[1];
    }
    return parts;
}

// --- Helper: Enhance question with factual info ---
function enhanceWithFactualInfo(parts, factualInfo, topic, difficulty) {
    // If factualInfo contains a Q/A, prefer it
    const factParts = parseQuestionText(factualInfo);
    return {
        question: factParts.question || parts.question,
        answer: factParts.answer || parts.answer,
        alternateAnswers: factParts.alternateAnswers.length ? factParts.alternateAnswers : parts.alternateAnswers,
        explanation: factParts.explanation || parts.explanation || "No explanation provided.",
        difficulty,
        searchUsed: true,
        topic
    };
}

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

// --- Helper: Format question parts ---
function formatTriviaParts(questionText, factualInfo, topic, difficulty) {
    const parts = parseQuestionText(questionText);
    if (factualInfo) {
        return enhanceWithFactualInfo(parts, factualInfo, topic, difficulty);
    }
    return {
        question: parts.question || questionText,
        answer: parts.answer || "Unknown",
        alternateAnswers: parts.alternateAnswers || [],
        explanation: parts.explanation || "No explanation provided.",
        difficulty,
        searchUsed: !!factualInfo,
        topic
    };
}

/**
 * Generates a trivia question based on topic and difficulty.
 * Uses a two-step approach: (1) search for facts if needed, (2) generate the question using those facts or standard prompt.
 * Now includes logic to exclude specific QUESTIONS.
 * @param {string} topic
 * @param {string} difficulty
 * @param {string[]} excludedQuestions - Array of question texts to avoid regenerating.
 * @param {string|null} channelName
 * @returns {Promise<object|null>}
 */
export async function generateQuestion(topic, difficulty, excludedQuestions = [], channelName = null) {
    const model = getGeminiClient();
    
    let specificTopic = topic;
    if (topic && topic.toLowerCase() === 'game' && channelName) {
        specificTopic = getGameFromContext(channelName);
        logger.info(`[TriviaService] Topic 'game' resolved to '${specificTopic}' from channel context.`);
    }
    
    // MODIFICATION START: Force search for specific topics
    const isGeneralTopic = !specificTopic || specificTopic.toLowerCase() === 'general' || specificTopic.toLowerCase() === 'general knowledge';
    const shouldUseSearch = !isGeneralTopic; // Always use search if NOT a general topic

    if (shouldUseSearch) {
        logger.info(`[TriviaService] Specific topic "${specificTopic}" identified. Forcing search-based question generation.`);
        return generateQuestionWithExplicitSearch(specificTopic, difficulty, excludedQuestions, channelName);
    }
    // MODIFICATION END

    // Fallback to standard generation for general knowledge or if search path fails (though generateQuestionWithExplicitSearch has its own retry)
    let prompt = '';
    const exclusionInstruction = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';

    prompt = `Create a trivia question about ${specificTopic || 'general knowledge'}.\n\nRequirements:\n- Difficulty level: ${difficulty}\n- The question must be clear and specific\n- Provide the correct answer\n- Include alternate acceptable answers if applicable\n- Add a brief explanation about the answer${exclusionInstruction}\n\nFormat your response exactly like this:\nQuestion: [your complete question here]\nAnswer: [the correct answer]\nAlternate Answers: [other acceptable answers, comma separated]\nExplanation: [brief explanation of the answer]`;
    
    try {
        logger.debug(`[TriviaService] Generating general knowledge question. Prompt includes exclusion instruction: ${!!exclusionInstruction}`);
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7, 
                maxOutputTokens: 350
            }
        });
        
        const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
             logger.warn('[TriviaService] Gemini response missing text content (general knowledge).');
             return null;
        }
        
        const questionObj = {
            question: '',
            answer: '',
            alternateAnswers: [],
            explanation: 'No explanation provided.',
            difficulty: difficulty,
            searchUsed: false, // General knowledge path
            verified: false, // Not explicitly verified by search in this path
            topic: specificTopic || 'general'
        };
        
        const questionMatch = text.match(/Question:\s*(.*?)(?=Answer:|$)/si);
        if (questionMatch && questionMatch[1].trim()) questionObj.question = questionMatch[1].trim();
        
        const answerMatch = text.match(/Answer:\s*(.*?)(?=Alternate|Explanation|$)/si);
        if (answerMatch && answerMatch[1].trim()) questionObj.answer = answerMatch[1].trim();
        
        const altMatch = text.match(/Alternate Answers?:\s*(.*?)(?=Explanation|$)/si);
        if (altMatch && altMatch[1].trim()) {
            questionObj.alternateAnswers = altMatch[1].split(',')
                .map(alt => alt.trim())
                .filter(alt => alt.length > 0 && alt.toLowerCase() !== questionObj.answer.toLowerCase());
        }
        
        const explMatch = text.match(/Explanation:\s*(.*?)(?=$)/si);
        if (explMatch && explMatch[1].trim()) questionObj.explanation = explMatch[1].trim();
        
        if (!questionObj.question || !questionObj.answer) {
            logger.warn(`[TriviaService] Generated invalid question structure (general knowledge): ${text.substring(0, 100)}...`);
            return null;
        }
        
        if (excludedQuestions.includes(questionObj.question)) {
            logger.warn(`[TriviaService] LLM generated an excluded question despite instructions (general knowledge): "${questionObj.question}". Returning null.`);
            return null; 
        }
        
        // For general knowledge, factuality check might still be useful if enabled
        const verifyFactualityEnv = process.env.TRIVIA_SEARCH_VERIFICATION === 'true';
        if (isGeneralTopic && verifyFactualityEnv) { // Check only if it's general and verification is on
            try {
                const validation = await validateQuestionFactuality(
                    questionObj.question,
                    questionObj.answer,
                    specificTopic || 'general'
                );
                questionObj.verified = validation.valid;
                if (!validation.valid && validation.confidence > 0.7) {
                    logger.warn(`[TriviaService] General knowledge question flagged by validation: ${validation.reason}. Question: "${questionObj.question}"`);
                }
            } catch (error) {
                logger.error({ err: error }, `[TriviaService] Error validating general knowledge question factuality for "${questionObj.question}"`);
                questionObj.verified = false;
            }
        }
        
        return questionObj;
    } catch (error) {
        logger.error({ err: error }, '[TriviaService] Error generating general knowledge trivia question API call');
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
    // 1. Basic string comparison
    if (userAnswer.toLowerCase() === correctAnswer.toLowerCase()) {
        return {
            is_correct: true,
            confidence: 1.0,
            reasoning: "Exact match with correct answer",
            search_used: false
        };
    }
    // 2. Check alternate answers
    for (const alt of alternateAnswers) {
        if (alt.toLowerCase() === userAnswer.toLowerCase()) {
            return {
                is_correct: true,
                confidence: 1.0,
                reasoning: "Exact match with alternate answer",
                search_used: false
            };
        }
    }
    // 3. More rigorous verification for non-exact matches
    const searchPrompt = `Verify if the user's answer is correct for this trivia question:\n\nQuestion: ${question}\nCorrect answer: ${correctAnswer}\nUser's answer: ${userAnswer}\n\nPlease answer with ONLY ONE of these exact words: "CORRECT" or "INCORRECT". \nThen provide a brief explanation on a new line.`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
            generationConfig: {
                temperature: 0.3 // Low temperature for more deterministic response
            }
        });
        const responseText = result.response.candidates[0].content.parts[0].text;
        // Check for the exact verdict at the beginning of the response
        const isCorrect = responseText.trim().toUpperCase().startsWith("CORRECT");
        // Extract the explanation part (after the first line)
        const explanation = responseText.split("\n").slice(1).join(" ").trim();
        return {
            is_correct: isCorrect,
            confidence: 0.95,
            reasoning: explanation || (isCorrect ? "The answers match conceptually." : "The answers are different."),
            search_used: false
        };
    } catch (error) {
        logger.error({ err: error }, 'Error verifying answer with structured response');
        // Fall back to strict matching as a last resort
        const similarity = calculateStringSimilarity(correctAnswer, userAnswer);
        const isVeryClose = similarity > 0.9; // Require very high similarity
        return {
            is_correct: isVeryClose,
            confidence: similarity,
            reasoning: `String similarity: ${Math.round(similarity * 100)}%`,
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
                maxOutputTokens: 100, // Keep it concise
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