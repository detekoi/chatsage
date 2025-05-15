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
    let forceSearch = false; // NEW: force search for certain topics

    if (topic && topic.toLowerCase() === 'game') {
        forceSearch = true; // Always use search for game topics
        try {
            const contextManager = getContextManager();
            const cleanChannelName = channelName.startsWith('#') ? channelName.substring(1) : channelName;
            const channelState = contextManager.getContextForLLM(cleanChannelName, 'riddle_service', 'fetch_game_topic');
            if (channelState?.streamGame && channelState.streamGame !== 'N/A') {
                actualTopic = channelState.streamGame;
                promptDetails += ` The riddle should be about the video game: "${actualTopic}".`;
                logger.info(`[RiddleService] Riddle topic set to current game: ${actualTopic}. Search will be used.`);
            } else {
                actualTopic = 'general video games';
                logger.warn(`[RiddleService] Could not determine specific current game for channel ${cleanChannelName}, defaulting to "general video games". Search will be used.`);
            }
        } catch (error) {
            logger.error({ err: error }, `[RiddleService] Error getting current game for riddle, defaulting to "general video games". Search will be used. Channel: ${channelName}`);
            actualTopic = 'general video games';
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

    // --- Improved search decision logic ---
    let useSearch = false;
    if (forceSearch) {
        useSearch = true;
        logger.info(`[RiddleService] Forcing search for topic type: "game" (actual topic: "${actualTopic}")`);
    } else {
        // Construct a clear statement of the "task" for the decision model
        const taskForSearchDecision = `Need to generate a ${difficulty} riddle about "${actualTopic}". ${fullExclusionInstructions}. Is search essential for factual accuracy and quality?`;
        const decisionContext = `Riddle generation task details:\nChannel: ${channelName}\nTopic: ${actualTopic}\nDifficulty: ${difficulty}\nExclusion Instructions: ${fullExclusionInstructions || 'None'}`;
        const decisionResult = await decideSearchWithFunctionCalling(decisionContext, taskForSearchDecision);
        useSearch = decisionResult.searchNeeded;
        logger.info(`[RiddleService] LLM decision to use search for riddle on "${actualTopic}": ${useSearch}. Reasoning: ${decisionResult.reasoning}`);
    }

    // --- Begin new search/generation separation logic ---
    let factualContextForRiddle = "";
    let finalGenerationPrompt = "";
    // --- Enhanced riddle prompt ---
    const baseGenerationPrompt = `You are a master riddle crafter, celebrated for your imaginative and clever puzzles. Your primary goal is to create a true RIDDLE, not a disguised trivia question.
${promptDetails}
${fullExclusionInstructions}

A true RIDDLE uses metaphorical language, describes something in an unusual, indirect, or poetic way, or plays on words to make the solver think laterally. It should be a fun mind-bender.
ABSOLUTELY AVOID questions that simply list factual attributes and end with "What am I?" (e.g., "I am large and blue, and cover most of the Earth..." is TRIVIA).
INSTEAD, craft clues that are puzzling and require interpretation. Example of a good riddle: "I have cities, but no houses; forests, but no trees; and water, but no fish. What am I?" (Answer: A map).

**CRITICAL FOR TOPIC-BASED RIDDLES (like "${actualTopic}"):**
* If the topic is a specific person, place, or thing (e.g., "Kathy Bates", "Eiffel Tower", "Chrono Trigger"), the riddle's answer should **NOT** be the topic itself.
* Instead, the riddle should be about a **specific characteristic, role, achievement, event, character, item, or concept *related to* or *within* the topic.**
* For example, if the topic is "Kathy Bates", a good riddle might be about one of her famous characters (e.g., Annie Wilkes), a notable award she won, or a significant movie she was in. The answer would then be that specific character, award, or movie title, NOT "Kathy Bates".
* If the topic is "Chrono Trigger", the riddle could be about a character (e.g., "Magus"), a specific gameplay mechanic (e.g., "Techs"), or a key plot element (e.g., "The Day of Lavos"). The answer should be that specific element.
* The goal is nuance and to test knowledge *about* the topic, not just recognition of the topic's name.

Clues must be factually accurate or based on commonly understood metaphors related to the answer. Avoid obscure terminology or misleading statements.

You MUST call the "generate_riddle_with_answer_and_keywords" function to structure your response.
For the function call:
- 'riddle_question': The riddle itself, artfully phrased.
- 'riddle_answer': The single, concise, most common answer to the riddle (which should be an aspect *of* the provided topic, not the topic itself if it's a specific entity).
- 'keywords': 3-5 highly specific and discriminative keywords or short phrases capturing the *unique metaphorical elements or core puzzle components* of THIS riddle and THIS answer. They must help distinguish it from other riddles.
- 'explanation': Briefly clarify the answer, especially any wordplay or metaphors used.
- 'difficulty_generated': Your honest assessment (easy, normal, hard).
- 'search_used': True if you actively used search to generate/verify THIS specific riddle (this will be determined by the 'useSearch' logic before this prompt is finalized).

If the topic is "general knowledge," focus on classic riddle structures or common objects/concepts described in a novel, puzzling way.
If the topic is specific (e.g., a video game), the riddle must be about elements *within* that topic, described imaginatively, and the answer should be that specific element.
Deliver a riddle that is clever and not too straightforward, matching the requested difficulty.`;

    if (useSearch) {
        logger.info(`[RiddleService] Search is needed for topic: "${actualTopic}". Fetching information...`);
        const infoGatheringPrompt = `Gather interesting and distinct facts, attributes, or unique details about the topic "${actualTopic}" that would be suitable for creating a riddle of ${difficulty} difficulty. Consider these exclusion instructions: ${fullExclusionInstructions}. Focus on information that lends itself to metaphorical or puzzling descriptions.`;
        try {
            const infoResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: infoGatheringPrompt }] }],
                tools: [{ googleSearch: {} }],
                systemInstruction: { parts: [{ text: "You are an information retriever." }] }
            });
            const infoResponse = infoResult.response;
            const infoCandidate = infoResponse?.candidates?.[0];
            if (infoCandidate?.content?.parts?.length > 0) {
                factualContextForRiddle = infoCandidate.content.parts.map(part => part.text).join('\n');
                logger.info(`[RiddleService] Successfully fetched factual context for "${actualTopic}" using search.`);
                finalGenerationPrompt = `${baseGenerationPrompt}\n\n**Use the following factual information to help craft your riddle about an aspect of "${actualTopic}" (the answer should NOT be "${actualTopic}" itself unless the topic is very broad like "history"):**\n\u0060\u0060\u0060\n${factualContextForRiddle}\n\u0060\u0060\u0060\n\nYou MUST call the \"generate_riddle_with_answer_and_keywords\" function to structure your response. When calling the function, ensure you set 'search_used: true' because information was gathered via search.`;
            } else {
                logger.warn(`[RiddleService] Search was triggered for "${actualTopic}", but no factual context was returned. Proceeding without additional search context.`);
                finalGenerationPrompt = `${baseGenerationPrompt}\n(Search was attempted for "${actualTopic}" but returned no specific pre-fetched context. Generate a riddle about an aspect of "${actualTopic}" based on your existing knowledge. The answer should NOT be "${actualTopic}" itself unless the topic is very broad. Set 'search_used: true' in the function call if your internal generation process leverages search-like capabilities.)`;
            }
        } catch (searchError) {
            logger.error({ err: searchError, topic: actualTopic }, `[RiddleService] Error during information gathering search step for riddle. Proceeding without additional search context.`);
            finalGenerationPrompt = `${baseGenerationPrompt}\n(An error occurred during an explicit search attempt for this topic. Generate the riddle based on your existing knowledge, and set 'search_used: false' in the function call.)`;
        }
    } else {
        finalGenerationPrompt = `${baseGenerationPrompt}\n(Generate this riddle about an aspect of "${actualTopic}" without using external search. The answer should NOT be "${actualTopic}" itself unless the topic is very broad. Set 'search_used: false' in your function call.)`;
    }

    try {
        const generationConfig = {
            temperature: 0.75, 
            maxOutputTokens: 450,
        };

        // Only use the generateRiddleTool here
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: finalGenerationPrompt }] }],
            tools: [generateRiddleTool],
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

            logger.info(`[RiddleService] Riddle generated for topic "${actualTopic}". Q: "${args.riddle_question.substring(0,50)}...", A: "${args.riddle_answer}", Keywords: [${args.keywords.join(', ')}], Search Used (reported by tool): ${args.search_used}, Initial decision: ${useSearch}`);
            return {
                question: args.riddle_question,
                answer: args.riddle_answer,
                keywords: args.keywords,
                difficulty: args.difficulty_generated || difficulty,
                explanation: args.explanation || "No explanation provided.",
                searchUsed: args.search_used, // Trust the value set by the LLM in the function call
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