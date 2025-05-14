// src/components/riddle/riddleService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient, generateSearchResponse, generateStandardResponse, decideSearchWithFunctionCalling } from '../llm/geminiClient.js';
import { getChannelInformation } from '../twitch/helixClient.js'; // To get current game

const MIN_CONFIDENCE_FOR_NO_SEARCH = 0.7; // Example threshold

// Tool definition for riddle generation
const generateRiddleTool = {
    functionDeclarations: [{
        name: "generate_riddle_with_answer_and_keywords",
        description: "Generates a riddle about a given topic, its answer, and 3-5 core keywords related to the riddle and answer. Ensures factual accuracy, using search if necessary.",
        parameters: {
            type: "OBJECT",
            properties: {
                riddle_question: { type: "STRING", description: "The text of the riddle." },
                riddle_answer: { type: "STRING", description: "The concise answer to the riddle." },
                keywords: {
                    type: "ARRAY",
                    description: "An array of 3-5 core keywords or concepts related to the riddle and its answer. These keywords should capture the essence of both the question and the solution.",
                    items: { type: "STRING" }
                },
                difficulty_generated: { type: "STRING", description: "The assessed difficulty of the generated riddle (easy, normal, hard)." },
                explanation: { type: "STRING", description: "A brief explanation of why the answer is correct, or a fun fact related to it." },
                search_used: { type: "BOOLEAN", description: "True if web search was used to generate or verify the riddle, false otherwise." }
            },
            required: ["riddle_question", "riddle_answer", "keywords", "difficulty_generated", "explanation", "search_used"]
        }
    }]
};


/**
 * Generates a riddle.
 * @param {string|null} topic - The topic for the riddle. 'game' means use current Twitch game. Null for general.
 * @param {string} difficulty - 'easy', 'normal', 'hard'.
 * @param {Array<string[]>} excludedKeywordSets - Array of keyword arrays to avoid.
 * @param {string} channelName - The channel for which the riddle is being generated (for context).
 * @returns {Promise<{question: string, answer: string, keywords: string[], difficulty: string, explanation: string, searchUsed: boolean, topic: string}|null>}
 */
export async function generateRiddle(topic, difficulty, excludedKeywordSets = [], channelName) {
    const model = getGeminiClient();
    let actualTopic = topic;
    let promptDetails = `Difficulty: ${difficulty}.`;

    if (topic && topic.toLowerCase() === 'game') {
        try {
            const contextManager = getContextManager();
            // Ensure channelName does not have '#' for context manager
            const cleanChannelName = channelName.startsWith('#') ? channelName.substring(1) : channelName;
            const channelState = contextManager.getContextForLLM(cleanChannelName, 'riddle_service', 'fetch_game_topic');
            if (channelState?.streamGame && channelState.streamGame !== 'N/A') {
                actualTopic = channelState.streamGame;
                promptDetails += ` The riddle should be about the video game: "${actualTopic}".`;
                logger.info(`[RiddleService] Riddle topic set to current game: ${actualTopic}`);
            } else {
                actualTopic = 'general knowledge'; 
                logger.warn(`[RiddleService] Could not determine current game for channel ${cleanChannelName}, defaulting to general knowledge.`);
            }
        } catch (error) {
            logger.error({ err: error }, `[RiddleService] Error getting current game for riddle, defaulting to general. Channel: ${channelName}`);
            actualTopic = 'general knowledge';
        }
    } else if (!topic) {
        actualTopic = 'general knowledge';
    }
    promptDetails += ` Topic: ${actualTopic}.`;

    let exclusionInstruction = "";
    if (excludedKeywordSets.length > 0) {
        const flatExcludedKeywords = excludedKeywordSets.map(set => `(${set.join(', ')})`).join('; ');
        exclusionInstruction = `\nCRITICAL: Avoid generating riddles that heavily rely on the following keyword combinations or themes: [${flatExcludedKeywords}]. Aim for conceptually different riddles.`;
    }
    
    const contextPromptForDecision = `Channel: ${channelName}\nStream Game (if any): ${actualTopic === topic && topic !== 'game' ? 'N/A' : actualTopic}\nUser is requesting a riddle.`;
    const decisionQuery = `Is search needed to generate a high-quality, factually accurate ${difficulty} riddle about "${actualTopic}" that is a true riddle and not a trivia question?${exclusionInstruction}`;
    
    const decisionResult = await decideSearchWithFunctionCalling(contextPromptForDecision, decisionQuery);
    const useSearch = decisionResult.searchNeeded;

    logger.info(`[RiddleService] Decision to use search for riddle on "${actualTopic}": ${useSearch}. Reasoning: ${decisionResult.reasoning}`);

    // --- MODIFIED PROMPT ---
    const generationPrompt = `You are a master riddle crafter, known for your clever wordplay and imaginative puzzles. Your task is to generate an engaging and creative RIDDLE, not a trivia question.
${promptDetails} ${exclusionInstruction}

A RIDDLE typically uses metaphorical language, describes something in an unusual way, or plays on words to make the solver think laterally. It should be a fun mind-bender.
AVOID questions that simply ask "What am I?" after listing factual attributes (e.g., "I am a large body of water..." is TRIVIA, not a riddle).
INSTEAD, focus on characteristics presented in a puzzling or poetic manner. For example: "I have cities, but no houses; forests, but no trees; and water, but no fish. What am I?" (Answer: A map) is a good riddle.

Your generated riddle clues must be factually accurate or based on commonly understood metaphors for the answer. Avoid obscure or misleading terminology.

You MUST call the "generate_riddle_with_answer_and_keywords" function to structure your response.
Ensure:
- 'riddle_question': The riddle itself, designed to be puzzling and metaphorical.
- 'riddle_answer': A concise, common answer.
- 'keywords': 3-5 core concepts or terms directly related to the riddle's question AND its answer. These should capture the *essence* of the puzzle.
- 'explanation': Briefly clarify the answer, especially any wordplay or metaphors used in the riddle.
- 'difficulty_generated': Your assessment of the riddle's difficulty (easy, normal, hard).
- 'search_used': True if you consulted external search to create/verify this specific riddle.

If the topic is "general knowledge", aim for classic riddle structures or common objects/concepts described in a novel way.
If the topic is specific (like a video game), ensure the riddle is about elements *within* that topic, described imaginatively.
Provide a riddle that is clever and not too straightforward, according to the requested difficulty.`;

    try {
        const generationConfig = {
            temperature: 0.75, // Slightly increased for creativity, but not too high to maintain accuracy
            maxOutputTokens: 450,
        };
        
        const toolsToUse = useSearch ? [generateRiddleTool, { googleSearch: {} }] : [generateRiddleTool];

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: generationPrompt }] }],
            tools: toolsToUse,
            toolConfig: {
                functionCallingConfig: { mode: "ANY" } 
            },
            generationConfig,
            systemInstruction: { parts: [{ text: "You are an AI assistant specializing in creating clever and accurate riddles."}] }
        });

        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate?.content?.parts?.[0]?.functionCall?.name === 'generate_riddle_with_answer_and_keywords') {
            const args = candidate.content.parts[0].functionCall.args;
            if (!args.riddle_question || !args.riddle_answer || !args.keywords || args.keywords.length === 0) {
                logger.warn('[RiddleService] Function call made, but essential riddle parts missing.', { args });
                return null;
            }
            // Additional check for "What am I?" type questions if they still slip through
            if (args.riddle_question.toLowerCase().includes("what am i?") && args.riddle_question.split('\n').length <= 3) {
                const characteristics = args.riddle_question.toLowerCase().split('\n').slice(0, -1).join(' ');
                if (characteristics.includes("i am") || characteristics.includes("i have") || characteristics.includes("i can")) {
                    logger.warn(`[RiddleService] Generated riddle resembles trivia ("What am I?" with direct attributes): "${args.riddle_question}". Consider re-prompting or filtering. Topic: ${actualTopic}`);
                    // Optionally: return null; // to force a retry
                }
            }

            logger.info(`[RiddleService] Riddle generated for topic "${actualTopic}" via function call. Search used by LLM: ${args.search_used}, Our decision: ${useSearch}`);
            return {
                question: args.riddle_question,
                answer: args.riddle_answer,
                keywords: args.keywords,
                difficulty: args.difficulty_generated || difficulty,
                explanation: args.explanation || "No explanation provided.",
                searchUsed: args.search_used || useSearch, 
                topic: actualTopic
            };
        } else {
            const textResponse = candidate?.content?.parts?.map(p => p.text).join('').trim();
            logger.warn('[RiddleService] Model did not call "generate_riddle_with_answer_and_keywords" as expected.', { textResponse: textResponse || "No text response." });
            return null;
        }

    } catch (error) {
        logger.error({ err: error, topic: actualTopic, difficulty }, '[RiddleService] Error generating riddle');
        return null;
    }
}


/**
 * Verifies a user's answer to a riddle.
 * @param {string} correctAnswer - The correct answer to the riddle.
 * @param {string} userAnswer - The user's submitted answer.
 * @param {string} riddleQuestion - The text of the riddle question for context.
 * @returns {Promise<{isCorrect: boolean, reasoning: string, confidence: number}>}
 */
export async function verifyRiddleAnswer(correctAnswer, userAnswer, riddleQuestion) {
    const model = getGeminiClient();
    const prompt = `
Context:
Riddle Question: "${riddleQuestion}"
Correct Answer to the Riddle: "${correctAnswer}"

Player's Guess: "${userAnswer}"

Task: Determine if the "Player's Guess" is a correct and acceptable answer to the "Riddle Question", given the "Correct Answer".
Consider synonyms, common misspellings, and slight variations in phrasing.
The "Correct Answer" is the ideal, concise answer. The player's guess doesn't have to be an exact match but should clearly indicate they've solved the riddle.

Respond with ONLY a JSON object with the following structure:
{
  "is_correct": boolean, // True if the guess is considered correct, false otherwise.
  "confidence": number, // A score from 0.0 (completely wrong) to 1.0 (exact match or very high confidence).
  "reasoning": "string" // Brief explanation for the decision (e.g., "Exact match", "Common misspelling accepted", "Close, but refers to a related concept not the answer").
}`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 150 } // Low temp for more deterministic verification
        });
        const response = result.response;
        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (text) {
            try {
                // Clean potential markdown code block fences
                const cleanedText = text.replace(/^```json\s*|```\s*$/g, '').trim();
                const parsed = JSON.parse(cleanedText);
                if (typeof parsed.is_correct === 'boolean' && typeof parsed.confidence === 'number' && typeof parsed.reasoning === 'string') {
                    logger.info(`[RiddleService] Answer verification complete for guess "${userAnswer}". Correct: ${parsed.is_correct}. Reasoning: ${parsed.reasoning}`);
                    return {
                        isCorrect: parsed.is_correct,
                        reasoning: parsed.reasoning,
                        confidence: parsed.confidence
                    };
                }
            } catch (e) {
                logger.error({ err: e, text }, '[RiddleService] Failed to parse JSON from answer verification');
            }
        }
        // Fallback if LLM fails to provide valid JSON
        logger.warn('[RiddleService] Answer verification failed to get structured response, falling back to basic string comparison.');
        const isBasicCorrect = correctAnswer.toLowerCase() === userAnswer.toLowerCase();
        return {
            isCorrect: isBasicCorrect,
            reasoning: isBasicCorrect ? "Exact match (fallback)." : "Incorrect (fallback).",
            confidence: isBasicCorrect ? 1.0 : 0.1
        };

    } catch (error) {
        logger.error({ err: error }, '[RiddleService] Error verifying riddle answer');
        const isBasicCorrect = correctAnswer.toLowerCase() === userAnswer.toLowerCase(); // Basic fallback
        return {
            isCorrect: isBasicCorrect,
            reasoning: `Error during verification. Basic check: ${isBasicCorrect ? "Correct" : "Incorrect"}.`,
            confidence: isBasicCorrect ? 0.9 : 0.0 // Lower confidence on error
        };
    }
}