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

/**
 * Generates a trivia question based on topic and difficulty.
 * Uses LLM function calling and optional Google Search.
 * 
 * @param {string} topic - The topic for the question (can be "general", a game title, or specific topic)
 * @param {string} difficulty - Difficulty level (easy, normal, hard)
 * @param {string[]} excludedQuestions - Array of recently used questions to avoid repetition
 * @param {string} channelName - Channel name for context
 * @returns {Promise<object|null>} Question object or null on failure
 */
export async function generateQuestion(topic, difficulty, excludedQuestions = [], channelName = null) {
    const model = getGeminiClient();
    
    // Build topic guidance based on the input
    let topicGuidance = "";
    if (!topic || topic.toLowerCase() === "general") {
        topicGuidance = "Create a general knowledge trivia question on any interesting topic.";
    } else if (topic.toLowerCase() === "game" && channelName) {
        // Get current game from context if available
        const contextManager = getContextManager();
        const llmContext = contextManager.getContextForLLM(channelName, "trivia-system", "");
        const currentGame = llmContext?.streamGame || null;
        
        if (currentGame && currentGame !== "N/A") {
            topicGuidance = `Create a trivia question about the video game "${currentGame}".`;
        } else {
            topicGuidance = "Create a video game related trivia question.";
        }
    } else {
        topicGuidance = `Create a trivia question about ${topic}.`;
    }
    
    // Construct the full prompt
    const prompt = `Generate a high-quality, factually accurate trivia question.

${topicGuidance}

Difficulty level: ${difficulty}

Requirements:
- The question should be clear, concise and have a definitive answer
- For easy questions, focus on well-known facts that most people would know
- For hard questions, focus on more obscure but still factual information
- Include alternate acceptable answers where appropriate
- Provide a brief explanation about the answer
- Use search if needed to ensure accuracy
- Do NOT use any of these recently used questions: ${excludedQuestions.join(", ")}

ONLY respond by calling the generate_trivia_question function.`;

    logger.debug({
        topic,
        difficulty,
        excludedCount: excludedQuestions.length
    }, 'Generating trivia question');

    try {
        // Make the API call with function calling
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: triviaQuestionTool,
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY" // Force function calling
                }
            }
        });

        // Process the result
        const response = result.response;
        const candidate = response?.candidates?.[0];

        // Extract function call data
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            
            if (functionCall.name === 'generate_trivia_question') {
                const args = functionCall.args;
                
                // Validate required fields
                if (!args.question || !args.correct_answer) {
                    logger.warn('Generated trivia question missing required fields');
                    return null;
                }
                
                // Build the question object
                const questionObject = {
                    question: args.question,
                    answer: args.correct_answer,
                    alternateAnswers: args.alternate_answers || [],
                    explanation: args.explanation || "No explanation provided.",
                    difficulty: args.difficulty || difficulty,
                    searchUsed: args.search_used || false,
                    topic: topic
                };
                
                logger.info({
                    questionLength: questionObject.question.length,
                    topicUsed: topic,
                    difficultyAssigned: questionObject.difficulty
                }, 'Successfully generated trivia question');
                
                return questionObject;
            } else {
                logger.warn({ functionCallName: functionCall.name }, "Model called unexpected function for question generation.");
            }
        } else {
            logger.warn("Model did not make expected function call for question generation.");
        }
        
        return null;
    } catch (error) {
        logger.error({ err: error }, 'Error generating trivia question');
        return null;
    }
}

/**
 * Verifies if a user's answer matches the expected answer.
 * Uses LLM function calling and optional Google Search for verification.
 * 
 * @param {string} correctAnswer - The known correct answer
 * @param {string} userAnswer - The user's submitted answer
 * @param {string[]} alternateAnswers - Array of acceptable alternate answers
 * @param {string} question - The original question for context
 * @returns {Promise<object>} Verification result
 */
export async function verifyAnswer(correctAnswer, userAnswer, alternateAnswers = [], question = "") {
    if (!correctAnswer || !userAnswer) {
        return { is_correct: false, confidence: 1.0, reasoning: "Missing answer to verify", search_used: false };
    }
    
    const model = getGeminiClient();
    
    // Construct the verification prompt
    const prompt = `You are verifying a trivia answer. Determine if the user's answer is correct.

Question: ${question}
Correct answer: ${correctAnswer}
Alternative acceptable answers: ${alternateAnswers.join(", ")}
User's answer: ${userAnswer}

Requirements:
- Be flexible with spelling, punctuation, and minor variations
- Consider both semantic meaning and exact matching
- For non-exact matches, use search if necessary to verify correctness
- For numeric answers, allow reasonable rounding
- For names, accept common variations (e.g., "Bill Gates" vs "William Gates")
- Do not be overly strict - valid answers can be phrased differently

ONLY respond by calling the verify_trivia_answer function with your assessment.`;

    logger.debug({
        userAnswerLength: userAnswer.length,
        correctAnswerLength: correctAnswer.length,
        alternateCount: alternateAnswers.length
    }, 'Verifying trivia answer');

    try {
        // Make the API call with function calling
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools: triviaVerificationTool,
            toolConfig: {
                functionCallingConfig: {
                    mode: "ANY" // Force function calling
                }
            }
        });

        // Process the result
        const response = result.response;
        const candidate = response?.candidates?.[0];

        // Extract function call data
        if (candidate?.content?.parts?.[0]?.functionCall) {
            const functionCall = candidate.content.parts[0].functionCall;
            
            if (functionCall.name === 'verify_trivia_answer') {
                const args = functionCall.args;
                
                // Validate boolean field
                const isCorrect = args.is_correct === true;
                
                // Build verification result
                const verificationResult = {
                    is_correct: isCorrect,
                    confidence: typeof args.confidence === 'number' ? args.confidence : (isCorrect ? 1.0 : 0.0),
                    reasoning: args.reasoning || (isCorrect ? "Answer matches expected answer." : "Answer does not match expected answer."),
                    search_used: args.search_used || false
                };
                
                logger.info({
                    is_correct: verificationResult.is_correct,
                    confidence: verificationResult.confidence,
                    search_used: verificationResult.search_used
                }, 'Successfully verified trivia answer');
                
                return verificationResult;
            } else {
                logger.warn({ functionCallName: functionCall.name }, "Model called unexpected function for answer verification.");
            }
        } else {
            logger.warn("Model did not make expected function call for answer verification.");
        }
        
        // Default return if function call failed
        return {
            is_correct: userAnswer.toLowerCase() === correctAnswer.toLowerCase(),
            confidence: 0.8,
            reasoning: "Basic string comparison (fallback method).",
            search_used: false
        };
    } catch (error) {
        logger.error({ err: error }, 'Error verifying trivia answer');
        
        // Fallback to simple string comparison
        return {
            is_correct: userAnswer.toLowerCase() === correctAnswer.toLowerCase(),
            confidence: 0.7,
            reasoning: "Basic string comparison (error fallback).",
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