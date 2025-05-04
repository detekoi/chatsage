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
    const prompt = `I need you to generate a trivia question about ${topic} that is FACTUALLY ACCURATE.\n\nCRITICAL: YOU MUST FOLLOW THESE STEPS IN ORDER:\n1. FIRST, use Google Search to find verified facts about ${topic}\n2. Choose a specific, verifiable fact from search results\n3. Formulate a clear question based ONLY on information you found through search\n4. Include the exact answer as found in search results\n5. Include any common alternate forms of the answer\n6. Cite the source of your information in the explanation\n\nDO NOT generate a question based on your internal knowledge. ONLY use facts that you can verify through search.\n\nDifficulty level: ${difficulty}\n\nONLY respond by calling the generate_trivia_question function with a question that is 100% verified by search.`;
    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }, triviaQuestionTool],
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY"
                }
            }
        });
        const functionCall = result.response?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
        if (functionCall?.name === 'generate_trivia_question') {
            const args = functionCall.args;
            const questionObject = {
                question: args.question,
                answer: args.correct_answer,
                alternateAnswers: args.alternate_answers || [],
                explanation: args.explanation || "No explanation provided.",
                difficulty: args.difficulty || difficulty,
                searchUsed: true, // Force to true
                topic: topic
            };
            return questionObject;
        }
        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error generating fallback question');
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
 * @param {string} topic
 * @param {string} difficulty
 * @param {string[]} excludedQuestions
 * @param {string} channelName
 * @returns {Promise<object|null>}
 */
export async function generateQuestion(topic, difficulty, excludedQuestions = [], channelName = null) {
    const model = getGeminiClient();
    
    // Get actual game title if topic is 'game'
    let specificTopic = topic;
    if (topic === 'game' && channelName) {
        specificTopic = getGameFromContext(channelName);
    }
    
    // Determine if we should use search based on config
    // Check if this is a game topic and TRIVIA_ALWAYS_SEARCH_GAMES is enabled
    const isGameTopic = topic === 'game' || specificTopic?.toLowerCase().includes('game');
    const useSearchForGames = process.env.TRIVIA_ALWAYS_SEARCH_GAMES === 'true';
    const shouldUseSearch = isGameTopic && useSearchForGames;
    
    // STEP 1: If search should be used, do a search-only call first
    let factualInfo = null;
    if (shouldUseSearch) {
        try {
            const searchPrompt = `Find factual information about the game "${specificTopic}" for creating a trivia question.\nInclude details that would make good trivia questions at ${difficulty} difficulty level.\nFocus on verifiable facts about gameplay, characters, story, or development.`;

            // Make a search-only API call - similar to generateSearchResponse
            const searchResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
                tools: [{ googleSearch: {} }] // ONLY search tool, no function calling
            });
            
            if (searchResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                factualInfo = searchResult.response.candidates[0].content.parts[0].text;
                logger.info(`Search used to gather facts about ${specificTopic} for trivia question`);
            }
        } catch (error) {
            logger.error({ err: error }, 'Error performing search for game information');
            // Continue without search if it fails
        }
    }
    
    // STEP 2: Generate the question with a standard API call (no tools)
    let prompt = '';
    if (factualInfo) {
        // Use the search results to create a factually accurate question
        prompt = `Create a trivia question using these facts about ${specificTopic}:\n\n${factualInfo}\n\nRequirements:\n- Difficulty: ${difficulty}\n- Make the question clear and specific\n- Provide the correct answer based on the facts above\n- Include alternate acceptable answers if applicable\n- Add a brief explanation\n\nFormat your response exactly like this:\nQuestion: [your question here]\nAnswer: [the correct answer]\nAlternate Answers: [other acceptable answers, comma separated]\nExplanation: [brief explanation of the answer]`;
    } else {
        // Standard question generation without search data
        prompt = `Create a trivia question about ${specificTopic || 'general knowledge'}.\n\nRequirements:\n- Difficulty level: ${difficulty}\n- The question must be clear and specific\n- Provide the correct answer\n- Include alternate acceptable answers if applicable\n- Add a brief explanation about the answer\n\nFormat your response exactly like this:\nQuestion: [your complete question here]\nAnswer: [the correct answer]\nAlternate Answers: [other acceptable answers, comma separated]\nExplanation: [brief explanation of the answer]`;
    }
    
    try {
        // Standard content generation - NO tools or function calling
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 350
            }
        });
        
        const text = result.response.candidates[0].content.parts[0].text;
        
        // Parse the response into components (using your existing code)
        const questionObj = {
            question: '',
            answer: '',
            alternateAnswers: [],
            explanation: 'No explanation provided.',
            difficulty: difficulty,
            searchUsed: !!factualInfo, // Track if search was used
            topic: specificTopic
        };
        
        // Extract question (your existing parsing code)
        const questionMatch = text.match(/Question:\s*(.*?)(?=Answer:|$)/s);
        if (questionMatch && questionMatch[1].trim()) {
            questionObj.question = questionMatch[1].trim();
        }
        
        // Extract answer
        const answerMatch = text.match(/Answer:\s*(.*?)(?=Alternate|Explanation|$)/s);
        if (answerMatch && answerMatch[1].trim()) {
            questionObj.answer = answerMatch[1].trim();
        }
        
        // Extract alternate answers
        const altMatch = text.match(/Alternate Answers:\s*(.*?)(?=Explanation|$)/s);
        if (altMatch && altMatch[1].trim()) {
            questionObj.alternateAnswers = altMatch[1].split(',')
                .map(alt => alt.trim())
                .filter(alt => alt.length > 0);
        }
        
        // Extract explanation
        const explMatch = text.match(/Explanation:\s*(.*?)(?=$)/s);
        if (explMatch && explMatch[1].trim()) {
            questionObj.explanation = explMatch[1].trim();
        }
        
        // Validate the question
        if (!questionObj.question || questionObj.question.length < 10 || !questionObj.answer) {
            logger.warn('Generated invalid question: ' + text.substring(0, 100));
            return null;
        }
        
        // STEP 3: Verify factuality if enabled and needed (for game topics without search)
        const verifyFactuality = process.env.TRIVIA_SEARCH_VERIFICATION === 'true';
        if (isGameTopic && !factualInfo && verifyFactuality) {
            try {
                const validation = await validateQuestionFactuality(
                    questionObj.question, 
                    questionObj.answer,
                    specificTopic
                );
                
                if (!validation.valid && validation.confidence > 0.7) {
                    logger.warn(`Potentially hallucinated question detected: ${validation.reason}`);
                    // Fall back to basic question if high confidence of hallucination
                    return null;
                }
            } catch (error) {
                logger.error({ err: error }, 'Error validating question factuality');
            }
        }
        
        return questionObj;
    } catch (error) {
        logger.error({ err: error }, 'Error generating trivia question');
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