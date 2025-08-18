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

// Function declaration for verifying trivia answers


// --- Helper: Validate Question Factuality ---
async function validateQuestionFactuality(question, answer, topic) {
    // Skip validation for general knowledge questions
    if (!topic || topic === 'general') return { valid: true };
    const model = getGeminiClient();
    const prompt = `Verify if this trivia question and answer are factually accurate:\n\nQuestion: ${question}\nAnswer: ${answer}\nTopic: ${topic}\n\nUse search to verify if this contains accurate information. If this appears to be about a fictional entity or contains made-up details that don't exist, flag it as potentially hallucinated.\n\nReturn only a JSON object with: \n{ "valid": boolean, "confidence": number, "reason": string }`;
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
async function generateQuestionWithExplicitSearch(topic, difficulty, excludedQuestions = [], _channelName = null, excludedAnswers = []) {
    const model = getGeminiClient();
    const exclusionInstructionQuestions = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';
    const exclusionInstructionAnswers = excludedAnswers.length > 0
        ? `\nIMPORTANT: Also, AVOID generating a question if its most likely concise answer is one of these recently used answers: ${excludedAnswers.map(a => `"${a}"`).join(', ')}. Aim for variety.`
        : '';

    // STEP 1: Search for facts about the topic - MODIFIED PROMPT
    const searchFactsPrompt = `First, find varied and interesting factual information about "${topic}" that can be used to create an engaging ${difficulty} trivia question. \nFocus on:\n- Key characters, items, or locations and their unique attributes or significance.\n- Notable plot points, events, or in-world lore details.\n- Interesting "behind-the-scenes" facts, development trivia, or real-world connections (but avoid simple release dates unless they are exceptionally trivia-worthy for a specific reason).\n- Unique mechanics, abilities, or concepts specific to the topic.\n${exclusionInstructionQuestions}${exclusionInstructionAnswers}\nReturn a collection of diverse facts as a text block. Do not call any functions in this step.`;
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
    const generateQuestionPrompt = `Using ONLY the following factual information about "${topic}":\n\nFACTS:\n${factualInfoText}\n\nCRITICAL: Generate an engaging trivia question based SOLELY on these facts.\nPrioritize questions that test knowledge about characters, plot, lore, or unique details, rather than just specific dates.\n${exclusionInstructionQuestions}${exclusionInstructionAnswers} \nDifficulty level: ${difficulty}.\nYou MUST call the 'generate_trivia_question' function to structure your response. \nWhen calling 'generate_trivia_question':\n- The 'correct_answer' MUST be the most common, VERY CONCISE, and "guessable" keyword, name, or specific term (ideally 1-3 words, max 5 words). AVOID long descriptive sentences for 'correct_answer'; such details belong in the 'explanation'. For example, if the question is "What is the name of Steven's pink, magical companion who has a pocket dimension in his mane?", the 'correct_answer' should be "Lion". If the question asks for a concept like "when Gems combine their forms", the 'correct_answer' should be "Fusion", not "The process by which Gems combine their physical forms".\n- For 'alternate_answers':\n    - If the 'correct_answer' is a short phrase like "Fusion Instability", include common, highly related, and shorter variations like "Instability" or "Unstable" as alternates if they make sense as a standalone answer to the question.\n    - If 'correct_answer' is "Italian-inspired", include "Italy" as an alternate.\n    - If 'correct_answer' is "Ghibli films and Mediterranean landscapes", alternates could include "Ghibli and Mediterranean" or potentially "Ghibli films" and "Mediterranean landscapes" IF the question could be reasonably answered by naming just one. Be discerning.\n- Ensure the 'search_used' field is true.\n`;

    try {
        logger.debug(`[TriviaService-ExplicitSearch] Step 2: Generating structured question for "${topic}" with updated concise answer/alternate guidance.`);
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
    
    // MODIFICATION START: Force search for specific topics
    const isGeneralTopic = !specificTopic || specificTopic.toLowerCase() === 'general' || specificTopic.toLowerCase() === 'general knowledge';
    const shouldUseSearch = !isGeneralTopic; // Always use search if NOT a general topic

    if (shouldUseSearch) {
        logger.info(`[TriviaService] Specific topic "${specificTopic}" identified. Forcing search-based question generation.`);
        return generateQuestionWithExplicitSearch(specificTopic, difficulty, excludedQuestions, channelName, excludedAnswers);
    }
    // MODIFICATION END

    let prompt = '';
    const exclusionInstructionQuestions = excludedQuestions.length > 0
        ? `\nIMPORTANT: Do NOT generate any of the following questions again: ${excludedQuestions.map(q => `"${q}"`).join(', ')}.`
        : '';
    const exclusionInstructionAnswers = excludedAnswers.length > 0
        ? `\nIMPORTANT: Also, AVOID generating a question if its most likely concise answer is one of these recently used answers: ${excludedAnswers.map(a => `"${a}"`).join(', ')}. Aim for variety.`
        : '';

    // MODIFIED PROMPT for general knowledge - ensuring concise answer guidance
    prompt = `Create an engaging trivia question about ${specificTopic || 'general knowledge'}.\nAvoid overly obscure or simple date-based questions. Focus on interesting facts, characters, plot points, lore, or unique details.${exclusionInstructionQuestions}${exclusionInstructionAnswers}\n\nRequirements:\n- Difficulty level: ${difficulty}\n- The question must be clear and specific.\n- IMPORTANT: The question should test knowledge of specific facts, people, places, events, or works. DO NOT simply ask for the name of a concept already described in the question. For example, instead of "What is the name of the philosophical concept where a tree falls unheard?", ask "Which philosopher is most famously associated with the 'if a tree falls in a forest' thought experiment?" (Answer: George Berkeley).\n- The 'Answer' field in your response MUST be the most common, VERY CONCISE, and "guessable" keyword, name, or specific term (ideally 1-3 words, max 5 words). AVOID long descriptive sentences for the 'Answer'; such details belong in the 'Explanation' field.\n- Provide the correct answer.\n- For 'Alternate Answers':\n    - If the 'Answer' is a short phrase like "Fusion Instability", include common, highly related, and shorter variations like "Instability" or "Unstable" as alternates if they make sense as a standalone answer to the question.\n    - If 'Answer' is "Italian-inspired", include "Italy" as an alternate.\n    - If 'Answer' is "Ghibli films and Mediterranean landscapes", alternates could include "Ghibli and Mediterranean" or potentially "Ghibli films" and "Mediterranean landscapes" IF the question could be reasonably answered by naming just one. Be discerning.\n- Add a brief explanation about the answer.\n\nFormat your response exactly like this:\nQuestion: [your complete question here]\nAnswer: [the concise correct answer]\nAlternate Answers: [concise alternate answers, comma separated]\nExplanation: [brief explanation of the answer, can include more detail]`;
    
    try {
        logger.debug(`[TriviaService] Generating general knowledge question with concise answer guidance.`);
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
        
        const questionObjParsed = parseQuestionText(text);
        
        const questionObject = {
            question: questionObjParsed.question,
            answer: questionObjParsed.answer, 
            alternateAnswers: questionObjParsed.alternateAnswers,
            explanation: questionObjParsed.explanation || 'No explanation provided.',
            difficulty: difficulty,
            searchUsed: false, 
            verified: false, 
            topic: specificTopic || 'general'
        };
        
        if (!questionObject.question || !questionObject.answer) {
            logger.warn(`[TriviaService] Generated invalid question structure (general knowledge): ${text.substring(0, 100)}...`);
            return null;
        }
        if (questionObject.answer.split(' ').length > 7 && questionObject.answer.length > 40) {
            logger.warn(`[TriviaService] General knowledge answer may be too long: "${questionObject.answer}". Length: ${questionObject.answer.length}, Words: ${questionObject.answer.split(' ').length}`);
        }
        
        if (excludedQuestions.includes(questionObject.question)) {
            logger.warn(`[TriviaService] LLM generated an excluded question (general knowledge): "${questionObject.question}". Returning null.`);
            return null; 
        }
        
        const verifyFactualityEnv = process.env.TRIVIA_SEARCH_VERIFICATION === 'true';
        if (isGeneralTopic && verifyFactualityEnv) { 
            try {
                const validation = await validateQuestionFactuality(
                    questionObject.question,
                    questionObject.answer,
                    specificTopic || 'general'
                );
                questionObject.verified = validation.valid;
                if (!validation.valid && validation.confidence > 0.7) {
                    logger.warn(`[TriviaService] General knowledge question flagged by validation: ${validation.reason}. Question: "${questionObject.question}"`);
                }
            } catch (error) {
                logger.error({ err: error }, `[TriviaService] Error validating general knowledge question factuality for "${questionObject.question}"`);
                questionObject.verified = false;
            }
        }
        
        return questionObject;
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
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with correct answer.", search_used: false };
    }
    // Ensure alternateAnswers is an array and then check
    if (Array.isArray(alternateAnswers) && alternateAnswers.some(alt => alt.toLowerCase().trim() === lowerUserAnswer)) {
        logger.debug(`[TriviaService] Alternate match: User "${lowerUserAnswer}" vs Alternates "${alternateAnswers.join(',')}"`);
        return { is_correct: true, confidence: 1.0, reasoning: "Exact match with an alternate answer.", search_used: false };
    }

    // Refined prompt for LLM verification (remains same as previous good version which is quite robust)
    const verificationPrompt = `Your task is to determine if the "Player's Input" is a correct and acceptable answer to the "Trivia Question", given the "Official Correct Answer" and any "Alternate Official Answers".

Trivia Question: "${question}"
Official Correct Answer: "${correctAnswer}"
Alternate Official Answers: ${Array.isArray(alternateAnswers) && alternateAnswers.length > 0 ? alternateAnswers.map(a => `"${a}"`).join(', ') : 'None'}
Player's Input: "${userAnswer}"

Instructions for your decision:
1.  **Direct Match:** If "Player's Input" exactly matches (case-insensitive) the "Official Correct Answer" or any "Alternate Official Answers", it is CORRECT.
2.  **Core Essence/Synonym:** If "Player's Input" captures the fundamental core essence or is a very close synonym of the "Official Correct Answer", it can be considered CORRECT. For example, if the official answer is "Italian-inspired architecture" and the question is about inspiration, "Italy" or "Italian architecture" could be acceptable. If the official answer is "The Eiffel Tower", then "Eiffel Tower" is CORRECT. If the official answer is "The colors red and green", "red and green" is correct, but "red" alone is INCORRECT. If the official answer is "Fusion Instability", an input like "Instability" or "Unstable" should be considered CORRECT if it conveys the core concept in context of the question.
3.  **Partial but Insufficient:** If "Player's Input" is only a small part of a multi-part "Official Correct Answer" and misses other key components (e.g., Player says "Europe" when answer is "Paris, France"), or if it's a broader category when a specific item is expected (e.g., Player says "a dog" when answer is "Golden Retriever"), it is INCORRECT.
4.  **Substantially Different/Unrelated:** If "Player's Input" is factually incorrect, refers to something entirely different, or is merely a comment about the question/game and not an attempt to answer, it is INCORRECT.
5.  **Format Match (Less Strict if Core Essence Met):** If the "Official Correct Answer" is a specific format (e.g., a date, a number), the "Player's Input" should ideally match that format. However, if the core essence is met (Point 2), slight format variations might be acceptable.

Respond with ONLY the word "CORRECT" or "INCORRECT".
On a new line, provide a VERY BRIEF (1 short sentence) justification for your decision, focusing on why the Player's Input is or isn't an acceptable match based on the criteria above. Example: "Player's input 'Italy' captures the core essence of 'Italian-inspired'." or "Player's input is a different concept." or "Player's input 'Unstable' is an acceptable variation of 'Fusion Instability'."
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