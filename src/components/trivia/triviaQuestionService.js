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

    // STEP 1: Search for facts about the topic - MODIFIED PROMPT
    const searchFactsPrompt = `First, find varied and interesting factual information about "${topic}" that can be used to create an engaging ${difficulty} trivia question. 
Focus on:
- Key characters, items, or locations and their unique attributes or significance.
- Notable plot points, events, or in-world lore details.
- Interesting "behind-the-scenes" facts, development trivia, or real-world connections (but avoid simple release dates unless they are exceptionally trivia-worthy for a specific reason).
- Unique mechanics, abilities, or concepts specific to the topic.
${exclusionInstruction}
Return a collection of diverse facts as a text block. Do not call any functions in this step.`;
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

    // STEP 2: Use the gathered facts to generate a structured question via function call - MODIFIED PROMPT
    const generateQuestionPrompt = `Using ONLY the following factual information about "${topic}":\n\nFACTS:\n${factualInfoText}\n\nCRITICAL: Generate an engaging trivia question based SOLELY on these facts.\nPrioritize questions that test knowledge about characters, plot, lore, or unique details, rather than just specific dates (like premiere or end dates), unless the date itself is a highly significant and interesting piece of trivia for a unique reason.\nDifficulty level: ${difficulty}.${exclusionInstruction}\nYou MUST call the 'generate_trivia_question' function to structure your response. \nWhen calling 'generate_trivia_question':\n- Ensure the 'search_used' field is true.\n- For 'alternate_answers': If the 'correct_answer' is a descriptive phrase (e.g., "Italian-inspired", "colors like yellow and blue"), INCLUDE THE CORE NOUN OR CONCEPT (e.g., "Italy", "yellow and blue") as an alternate_answer if it's a common, understandable shorthand in a trivia context. For instance, if the answer is "Spanish-inspired architecture", add "Spain" AND "Spanish architecture" as alternates. If the answer is "the colors red and green", add "red and green" as an alternate.\n`;

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 2: Generating structured question for "${topic}" using retrieved facts. Prompt includes alternate answer guidance.`);
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
            const alternateAnswers = args.alternate_answers || [];

            if (!question || !correctAnswer) {
                logger.warn(`[TriviaService-ExplicitSearch] Step 2: Function call 'generate_trivia_question' missing question or answer. Args: ${JSON.stringify(args)}`);
                return null;
            }
            
            const questionObject = {
                question: question,
                answer: correctAnswer,
                alternateAnswers: alternateAnswers,
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
            logger.info(`[TriviaService-ExplicitSearch] Step 2: Successfully generated question for topic "${topic}". Answer: "${correctAnswer}", Alternates: "${alternateAnswers.join(', ')}"`);
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

    // MODIFIED PROMPT for general knowledge
    prompt = `Create an engaging trivia question about ${specificTopic || 'general knowledge'}.
Avoid overly obscure or simple date-based questions (like premiere or release dates) unless the date itself is exceptionally significant for a unique reason.
Focus on interesting facts, characters, plot points, lore, or unique details.
\n\nRequirements:\n- Difficulty level: ${difficulty}\n- The question must be clear and specific\n- Provide the correct answer\n- Include alternate acceptable answers if applicable\n- Add a brief explanation about the answer${exclusionInstruction}\n\nFormat your response exactly like this:\nQuestion: [your complete question here]\nAnswer: [the correct answer]\nAlternate Answers: [other acceptable answers, comma separated]\nExplanation: [brief explanation of the answer]`;
    
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

    const lowerUserAnswer = userAnswer.toLowerCase().trim();
    const lowerCorrectAnswer = correctAnswer.toLowerCase().trim();

    if (lowerUserAnswer === lowerCorrectAnswer) {
        logger.debug(`[TriviaService] Exact match: User "${lowerUserAnswer}" vs Correct "${lowerCorrectAnswer}"`);
        return {
            is_correct: true,
            confidence: 1.0,
            reasoning: "Exact match with correct answer.",
            search_used: false
        };
    }
    if (alternateAnswers && alternateAnswers.some(alt => alt.toLowerCase().trim() === lowerUserAnswer)) {
        logger.debug(`[TriviaService] Alternate match: User "${lowerUserAnswer}" vs Alternates "${alternateAnswers.join(',')}"`);
        return {
            is_correct: true,
            confidence: 1.0,
            reasoning: "Exact match with an alternate answer.",
            search_used: false
        };
    }

    const questionExpectsDate = /date|when|year|premiered|released|concluded/i.test(question);
    const userAnswerLooksLikeDate = /\d/.test(userAnswer) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(lowerUserAnswer);
    
    if (questionExpectsDate && !userAnswerLooksLikeDate) {
        logger.debug(`[TriviaService] Heuristic: Question expects date, user answer "${userAnswer}" does not appear to be a date. Marking as incorrect.`);
        return {
            is_correct: false,
            confidence: 0.8, 
            reasoning: "Answer format does not match expected (e.g., a date was expected).",
            search_used: false
        };
    }

    // Refined prompt for LLM verification
    const verificationPrompt = `Your task is to determine if the "Player's Input" is a correct and acceptable answer to the "Trivia Question", given the "Official Correct Answer" and any "Alternate Official Answers".

Trivia Question: "${question}"
Official Correct Answer: "${correctAnswer}"
Alternate Official Answers: ${alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Input: "${userAnswer}"

Instructions for your decision:
1.  **Direct Match:** If "Player's Input" exactly matches (case-insensitive) the "Official Correct Answer" or any "Alternate Official Answers", it is CORRECT.
2.  **Core Essence/Synonym:** If "Player's Input" captures the fundamental core essence or is a very close synonym of the "Official Correct Answer", it can be considered CORRECT. For example, if the official answer is "Italian-inspired architecture" and the question is about inspiration, "Italy" or "Italian architecture" could be acceptable. If the official answer is "The Eiffel Tower", then "Eiffel Tower" is CORRECT. If the official answer is "The colors red and green", "red and green" is correct, but "red" alone is INCORRECT.
3.  **Partial but Insufficient:** If "Player's Input" is only a small part of a multi-part "Official Correct Answer" and misses other key components (e.g., Player says "Europe" when answer is "Paris, France"), or if it's a broader category when a specific item is expected (e.g., Player says "a dog" when answer is "Golden Retriever"), it is INCORRECT.
4.  **Substantially Different/Unrelated:** If "Player's Input" is factually incorrect, refers to something entirely different, or is merely a comment about the question/game and not an attempt to answer, it is INCORRECT.
5.  **Format Match (Less Strict if Core Essence Met):** If the "Official Correct Answer" is a specific format (e.g., a date, a number), the "Player's Input" should ideally match that format. However, if the core essence is met (Point 2), slight format variations might be acceptable.

Respond with ONLY the word "CORRECT" or "INCORRECT".
On a new line, provide a VERY BRIEF (1 short sentence) justification for your decision, focusing on why the Player's Input is or isn't an acceptable match based on the criteria above. Example: "Player's input 'Italy' captures the core essence of 'Italian-inspired'." or "Player's input is a different concept."
`;

    try {
        logger.debug(`[TriviaService] Sending to LLM for verification. Correct: "${correctAnswer}", User: "${userAnswer}", Alts: "${alternateAnswers.join(',')}"`);
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: verificationPrompt }] }],
            generationConfig: {
                temperature: 0.1, // Very low for high determinism in verification
                maxOutputTokens: 60,
            }
        });
        const responseText = result.response.candidates[0].content.parts[0].text.trim();
        
        const isCorrectByLLM = responseText.toUpperCase().startsWith("CORRECT");
        let reasoningFromLLM = responseText.split("\n").slice(1).join(" ").trim();
        if (!reasoningFromLLM) {
            reasoningFromLLM = isCorrectByLLM ? "The answer is considered correct by the LLM." : "The answer is considered incorrect by the LLM.";
        }

        const similarityToCorrect = calculateStringSimilarity(lowerCorrectAnswer, lowerUserAnswer);
        const bestAlternateSimilarity = alternateAnswers.length > 0 ? Math.max(...alternateAnswers.map(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer))) : 0;

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
        let isFallbackCorrect = similarity > 0.7; 

        if (!isFallbackCorrect && alternateAnswers.some(alt => calculateStringSimilarity(alt.toLowerCase().trim(), lowerUserAnswer) > 0.7)) {
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