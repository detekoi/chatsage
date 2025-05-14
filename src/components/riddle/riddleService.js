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
        description: "Generates a clever, metaphorical riddle about a given topic, its concise answer, and 3-5 highly descriptive keywords that capture the unique essence of the riddle's puzzle and solution. Ensures factual accuracy for clues, using search if necessary.",
        parameters: {
            type: "OBJECT",
            properties: {
                riddle_question: { type: "STRING", description: "The text of the riddle, focusing on metaphorical or puzzling descriptions rather than direct factual statements." },
                riddle_answer: { type: "STRING", description: "The single, concise, common answer to the riddle." },
                keywords: {
                    type: "ARRAY",
                    description: "An array of 3-5 core keywords or short phrases. These keywords MUST be specific and discriminative, capturing the unique metaphorical elements or core components of THIS particular riddle and its answer, to distinguish it from other riddles on similar topics or with similar answers.",
                    items: { type: "STRING" }
                },
                difficulty_generated: { type: "STRING", description: "The assessed difficulty of the generated riddle (easy, normal, hard)." },
                explanation: { type: "STRING", description: "A brief explanation of why the answer is correct, ideally clarifying any wordplay or metaphors used in the riddle." },
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
 * @param {Array<string>} excludedAnswers - Array of recent answers to avoid (optional).
 * @returns {Promise<{question: string, answer: string, keywords: string[], difficulty: string, explanation: string, searchUsed: boolean, topic: string}|null>}
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

    let keywordExclusionInstruction = "";
    if (excludedKeywordSets.length > 0) {
        const flatExcludedKeywords = excludedKeywordSets.map(set => `(${set.join(', ')})`).join('; ');
        keywordExclusionInstruction = `\nCRITICAL KEYWORD AVOIDANCE: Avoid generating riddles that are conceptually defined by or heavily rely on the following keyword combinations/themes: [${flatExcludedKeywords}].`;
    }

    let answerExclusionInstruction = "";
    if (excludedAnswers && excludedAnswers.length > 0) {
        answerExclusionInstruction = `\nCRITICAL ANSWER AVOIDANCE: Furthermore, DO NOT generate a riddle if its most direct and common answer is one of these recently used answers: [${excludedAnswers.join(', ')}].`;
    }
    const fullExclusionInstructions = `${keywordExclusionInstruction}${answerExclusionInstruction}\nStrive for maximum conceptual novelty and variety from previous riddles.`;

    const contextPromptForDecision = `Channel: ${channelName}\nTopic: ${actualTopic}\nDifficulty: ${difficulty}\nTask: Determine if web search is *essential* to create a factually accurate and high-quality *riddle* (not a trivia question) on this topic, considering the exclusion instructions.`;
    const decisionQuery = `Is search needed? ${fullExclusionInstructions}`;

    const decisionResult = await decideSearchWithFunctionCalling(contextPromptForDecision, decisionQuery);
    const useSearch = decisionResult.searchNeeded;

    logger.info(`[RiddleService] Decision to use search for riddle on "${actualTopic}": ${useSearch}. Reasoning: ${decisionResult.reasoning}`);

    const generationPrompt = `You are a master riddle crafter, celebrated for your imaginative and clever puzzles. Your primary goal is to create a true RIDDLE, not a disguised trivia question.
${promptDetails}
${fullExclusionInstructions}

A true RIDDLE uses metaphorical language, describes something in an unusual, indirect, or poetic way, or plays on words to make the solver think laterally. It should be a fun mind-bender.
ABSOLUTELY AVOID questions that simply list factual attributes and end with "What am I?" (e.g., "I am large and blue, and cover most of the Earth..." is TRIVIA).
INSTEAD, craft clues that are puzzling and require interpretation. Example of a good riddle: "I have cities, but no houses; forests, but no trees; and water, but no fish. What am I?" (Answer: A map).

Clues must be factually accurate or based on commonly understood metaphors related to the answer. Avoid obscure terminology or misleading statements.

You MUST call the "generate_riddle_with_answer_and_keywords" function to structure your response.
For the function call:
- 'riddle_question': The riddle itself, artfully phrased.
- 'riddle_answer': The single, concise, most common answer.
- 'keywords': 3-5 highly specific and discriminative keywords or short phrases capturing the *unique metaphorical elements or core puzzle components* of THIS riddle and THIS answer. They must help distinguish it from other riddles.
- 'explanation': Briefly clarify the answer, especially any wordplay or metaphors used.
- 'difficulty_generated': Your honest assessment (easy, normal, hard).
- 'search_used': True if you actively used search to generate/verify THIS specific riddle.

If the topic is "general knowledge," focus on classic riddle structures or common objects/concepts described in a novel, puzzling way.
If the topic is specific (e.g., a video game), the riddle must be about elements *within* that topic, described imaginatively.
Deliver a riddle that is clever and not too straightforward, matching the requested difficulty.`;

    try {
        const generationConfig = {
            temperature: 0.75, 
            maxOutputTokens: 450,
        };
        
        const toolsToUse = useSearch ? [generateRiddleTool, { googleSearch: {} }] : [generateRiddleTool];

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: generationPrompt }] }],
            tools: toolsToUse,
            toolConfig: { functionCallingConfig: { mode: "ANY" } },
            generationConfig,
            systemInstruction: { parts: [{ text: "You are an AI assistant specializing in creating clever, accurate, and varied riddles."}] }
        });

        const response = result.response;
        const candidate = response?.candidates?.[0];

        if (candidate?.content?.parts?.[0]?.functionCall?.name === 'generate_riddle_with_answer_and_keywords') {
            const args = candidate.content.parts[0].functionCall.args;
            if (!args.riddle_question || !args.riddle_answer || !args.keywords || args.keywords.length === 0) {
                logger.warn('[RiddleService] Function call made, but essential riddle parts missing.', { args });
                return null;
            }
            // Heuristic check for trivia-like riddles
            if (args.riddle_question.toLowerCase().includes("what am i?") && args.riddle_question.split('\n').length <= 4) {
                const characteristics = args.riddle_question.toLowerCase().split('\n').slice(0, -1).join(' ');
                if ((characteristics.includes("i am") || characteristics.includes("i have") || characteristics.includes("i can")) &&
                    !characteristics.includes("speak without a mouth") &&
                    !characteristics.includes("no eyes but see") &&
                    !characteristics.includes("no hands but knock")) {
                    logger.warn(`[RiddleService] Generated riddle might be too trivia-like: "${args.riddle_question}". Topic: ${actualTopic}`);
                }
            }

            logger.info(`[RiddleService] Riddle generated for topic "${actualTopic}". Q: "${args.riddle_question.substring(0,50)}...", A: "${args.riddle_answer}", Keywords: [${args.keywords.join(', ')}], Search: ${args.search_used || useSearch}`);
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