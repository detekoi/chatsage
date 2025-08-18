// src/components/riddle/riddleService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient, decideSearchWithFunctionCalling } from '../llm/geminiClient.js';




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
 * @returns {Promise<{question: string, answer: string, keywords: string[], difficulty: string, explanation: string, searchUsed: boolean, topic: string, requestedTopic: string}|null>}
 */
export async function generateRiddle(topic, difficulty, excludedKeywordSets = [], channelName, excludedAnswers = []) {
    // Create a fresh model instance without system instruction to avoid token overhead (like geo fix)
    const { getGenAIInstance } = await import('../llm/geminiClient.js');
    const genAI = getGenAIInstance();
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.75,
            maxOutputTokens: 1200, // Increased for gemini-2.5-flash reasoning overhead
            candidateCount: 1
        }
    });
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

    // --- SYSTEM_CONTEXT preface for all prompts ---
    if (useSearch && factualContextForRiddle) {
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}". Factual information gathered via search is provided below.\nYour task is to create a riddle about a specific, nuanced *ASPECT* of "${actualTopic}". The answer to your riddle should **NOT** be "${actualTopic}" itself, but rather something specific related to it, inspired by the context or your general knowledge.\n\n**Factual Information (use this to inspire your riddle about an ASPECT of the topic):**\n\u0060\u0060\u0060\n${factualContextForRiddle}\n\u0060\u0060\u0060\n\n${baseGenerationPrompt}\nRemember to set 'search_used: true' in your function call. The riddle's answer must be about an aspect of "${actualTopic}".`;
    } else if (useSearch) {
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}". Search was attempted but yielded no specific context.\nYour task is to create a riddle about a specific, nuanced *ASPECT* of "${actualTopic}" based on your existing knowledge. The answer to your riddle should **NOT** be "${actualTopic}" itself.\n${baseGenerationPrompt}\nSet 'search_used: true' in your function call if your internal generation process leverages search-like capabilities. The riddle's answer must be about an aspect of "${actualTopic}".`;
    } else { // No search
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}".\nYour task is to create a riddle about a specific, nuanced *ASPECT* of "${actualTopic}" based on your existing knowledge. The answer to your riddle should **NOT** be "${actualTopic}" itself.\n${baseGenerationPrompt}\nSet 'search_used: false' in your function call. The riddle's answer must be about an aspect of "${actualTopic}".`;
    }

    try {
        // Only use the generateRiddleTool here
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: finalGenerationPrompt }] }],
            tools: [generateRiddleTool],
            toolConfig: { functionCallingConfig: { mode: "ANY" } }
            // No systemInstruction - using fresh model instance without CHAT_SAGE_SYSTEM_INSTRUCTION
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
                topic: actualTopic,
                requestedTopic: topic // Always return the originally requested topic for answer verification
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
 * @param {string|null} originalTopic - The original topic requested for the riddle (for stricter checking).
 * @returns {Promise<{isCorrect: boolean, reasoning: string, confidence: number}>}
 */
export async function verifyRiddleAnswer(correctAnswer, userAnswer, riddleQuestion, originalTopic = null) {
    const model = getGeminiClient();
    // Normalize inputs for comparison
    const lowerCorrectAnswer = correctAnswer.toLowerCase().trim();
    const lowerUserAnswer = userAnswer.toLowerCase().trim();
    const lowerOriginalTopic = originalTopic ? originalTopic.toLowerCase().trim() : null;

    let directMatch = false;
    if (lowerUserAnswer === lowerCorrectAnswer) {
        directMatch = true;
    }

    // If the user's answer IS the original topic,
    // AND the original topic IS NOT the actual correct answer to this specific riddle,
    // then it's likely an incorrect guess, even if related.
    let isTopicGuessInsteadOfAspect = false;
    if (lowerOriginalTopic && lowerUserAnswer === lowerOriginalTopic && lowerOriginalTopic !== lowerCorrectAnswer) {
        isTopicGuessInsteadOfAspect = true;
        logger.info(`[RiddleService] User guessed the original topic ("${userAnswer}") but the specific answer was ("${correctAnswer}").`);
    }

    const prompt = `
Context:
Riddle Question: "${riddleQuestion}"
Intended Correct Answer to THIS SPECIFIC Riddle: "${correctAnswer}"
Original Topic/Subject of the Riddle Request (if provided): "${originalTopic || 'Not provided'}"

Player's Guess: "${userAnswer}"

Task: Determine if the "Player's Guess" is the intended correct answer to THIS SPECIFIC riddle.

Instructions for your decision:
1.  **Exact Match:** If "Player's Guess" exactly matches (case-insensitive) the "Intended Correct Answer", it is CORRECT. Confidence: 1.0.
2.  **Close Variations:** Accept very close synonyms, common and obvious misspellings, or minor variations (e.g., "Eiffel tower" for "The Eiffel Tower") of the "Intended Correct Answer". Confidence: 0.9-0.95.
3.  **Topic vs. Aspect:**
    * If an "Original Topic/Subject" was provided AND the "Intended Correct Answer" is a specific aspect *of* that topic (e.g., Topic="Kathy Bates", Answer="Annie Wilkes"),
    * AND the "Player's Guess" is the "Original Topic/Subject" itself (e.g., guessed "Kathy Bates"),
    * THEN the guess is INCORRECT because it's too broad and not the specific answer to *this particular riddle*. Reasoning should state this. Confidence: 0.1-0.3.
4.  **Related but Incorrect:** If the guess is related to the "Intended Correct Answer" or "Original Topic" but is not the specific answer (e.g., another character from the same movie, a different movie by the same actor), it is INCORRECT. Reasoning should clarify the distinction. Confidence: 0.2-0.5.
5.  **Unrelated/Clearly Wrong:** If the guess is unrelated, it is INCORRECT. Confidence: 0.0.

Respond with ONLY a JSON object with the following structure:
{
  "is_correct": boolean, // True if the guess is considered correct for THIS SPECIFIC riddle, false otherwise.
  "confidence": number, // A score from 0.0 (completely wrong) to 1.0 (exact match or very high confidence).
  "reasoning": "string" // Brief explanation for the decision.
}`;

    try {
        // Pre-check for the specific scenario before calling LLM, if desired, for more deterministic control
        if (isTopicGuessInsteadOfAspect) {
            logger.info(`[RiddleService] Pre-LLM check: User guessed original topic "${userAnswer}", but riddle answer is "${correctAnswer}". Marking as incorrect.`);
            return {
                isCorrect: false,
                reasoning: `The guess "${userAnswer}" is the general topic, but the riddle is about a more specific aspect. The answer is "${correctAnswer}".`,
                confidence: 0.2 // Low confidence in user's guess being the specific answer
            };
        }
        if (directMatch) {
             logger.info(`[RiddleService] Pre-LLM check: User guess "${userAnswer}" is an exact match to "${correctAnswer}". Marking as correct.`);
            return {
                isCorrect: true,
                reasoning: "Exact match.",
                confidence: 1.0
            };
        }

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 200 } // Lower temp for more deterministic verification
        });
        const response = result.response;
        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (text) {
            try {
                const cleanedText = text.replace(/^```json\s*|```\s*$/g, '').trim();
                const parsed = JSON.parse(cleanedText);
                if (typeof parsed.is_correct === 'boolean' && typeof parsed.confidence === 'number' && typeof parsed.reasoning === 'string') {
                    // Additional check: if LLM says correct, but it was a topic guess, override if we are strict
                    if (parsed.is_correct && isTopicGuessInsteadOfAspect) {
                        logger.warn(`[RiddleService] LLM marked topic guess ("${userAnswer}") as correct for specific answer ("${correctAnswer}"). Overriding to incorrect based on new rule.`);
                        return {
                            isCorrect: false,
                            reasoning: `The guess "${userAnswer}" is the general topic of the riddle. The specific answer is "${correctAnswer}". (LLM initially considered it related).`,
                            confidence: 0.25
                        };
                    }
                    logger.info(`[RiddleService] LLM Answer verification: User guess "${userAnswer}", Correct Answer "${correctAnswer}", Original Topic "${originalTopic}". LLM says: ${parsed.is_correct}. Reasoning: ${parsed.reasoning}`);
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
        // Fallback if LLM fails to provide valid JSON or structured response
        logger.warn('[RiddleService] Answer verification failed to get structured response, falling back to basic string comparison against correct answer only.');
        const isBasicCorrect = lowerUserAnswer === lowerCorrectAnswer;
        return {
            isCorrect: isBasicCorrect,
            reasoning: isBasicCorrect ? "Exact match (fallback)." : "Incorrect (fallback).",
            confidence: isBasicCorrect ? 0.9 : 0.1 // Slightly lower confidence for exact match in fallback
        };

    } catch (error) {
        logger.error({ err: error }, '[RiddleService] Error verifying riddle answer with LLM');
        const isBasicCorrect = lowerUserAnswer === lowerCorrectAnswer;
        return {
            isCorrect: isBasicCorrect,
            reasoning: `Error during LLM verification. Basic check: ${isBasicCorrect ? "Correct" : "Incorrect"}.`,
            confidence: isBasicCorrect ? 0.8 : 0.0
        };
    }
}