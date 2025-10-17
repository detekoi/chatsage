// src/components/riddle/riddleService.js
import logger from '../../lib/logger.js';
import { getContextManager } from '../context/contextManager.js';
import { getGeminiClient, decideSearchWithFunctionCalling } from '../llm/geminiClient.js';
import { GoogleGenAI, Type as GenAIType } from '@google/genai';

// Blacklist meta-concepts and generic acknowledgements that make bad riddle answers
const META_CONCEPT_BLACKLIST = [
    'knowledge', 'information', 'data', 'fact', 'trivia', 'memory', 'learning',
    'education', 'wisdom', 'understanding', 'intelligence', 'consciousness',
    'thought', 'idea', 'concept', 'mind', 'brain',
    'yes', 'no', 'maybe', 'idk', 'dunno', 'ok', 'okay', 'yep', 'yup', 'nope', 'nah'
];

// Tool definition for riddle generation
const generateRiddleTool = {
    functionDeclarations: [{
        name: "generate_riddle_with_answer_and_keywords",
        description: "Generates a clever, metaphorical riddle about a given topic, its concise answer, and 3-5 highly descriptive keywords. IMPORTANT: The answer must be a concrete, common, guessable thing (e.g., everyday object, animal, simple tool, well-known character/item/location for 'game' topics). Avoid overly abstract concepts or processes. Keep riddles short and anchored to tangible clues. Ensures factual accuracy for clues, using search if necessary.",
        parameters: {
            type: GenAIType.OBJECT,
            properties: {
                riddle_question: { type: GenAIType.STRING, description: "The text of the riddle, focusing on metaphorical or puzzling descriptions rather than direct factual statements." },
                riddle_answer: { type: GenAIType.STRING, description: "The single, concise, common answer to the riddle." },
                keywords: {
                    type: GenAIType.ARRAY,
                    description: "An array of 3-5 core keywords or short phrases. These keywords MUST be specific, concrete, and discriminative, capturing tangible aspects or imagery from THIS riddle (shape, sound, behavior, place) so it's guessable and distinct.",
                    items: { type: GenAIType.STRING }
                },
                difficulty_generated: { type: GenAIType.STRING, description: "The assessed difficulty of the generated riddle (easy, normal, hard)." },
                explanation: { type: GenAIType.STRING, description: "A brief, fun, 1-2 sentence explanation for Twitch chat. Explain the clever wordplay or connection in a witty, conversational tone. Vary sentence starters. Examples: 'A book has a spine just like your body!' or 'Compass needles always point north, that's the trick!' Avoid: 'The riddle focuses on physical characteristics' or academic explanations." },
                search_used: { type: GenAIType.BOOLEAN, description: "True if web search was used to generate or verify the riddle, false otherwise." }
            },
            required: ["riddle_question", "riddle_answer", "keywords", "difficulty_generated", "explanation", "search_used"]
        }
    }]
};

// (No function-calling in verification; we use structured output JSON)


// Helper: prune excluded keyword sets to keep prompt small
function pruneExcludedKeywordSets(excludedKeywordSets, options = {}) {
    const maxSets = typeof options.maxSets === 'number' ? options.maxSets : 15;
    const maxKeywordsPerSet = typeof options.maxKeywordsPerSet === 'number' ? options.maxKeywordsPerSet : 4;
    const maxTotalChars = typeof options.maxTotalChars === 'number' ? options.maxTotalChars : 1500; // rough cap for the instruction block

    if (!Array.isArray(excludedKeywordSets) || excludedKeywordSets.length === 0) return [];

    const normalize = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
        .replace(/[\s]+/g, ' ')
        .replace(/^[,;\s]+|[,;\s]+$/g, '');

    // 1) Normalize, dedupe within each set, and trim per-set length
    const normalizedSets = excludedKeywordSets
        .map((set) => Array.isArray(set) ? set : [])
        .map((set) => {
            const uniq = Array.from(new Set(set.map(normalize).filter(Boolean)));
            return uniq.slice(0, maxKeywordsPerSet);
        })
        .filter((set) => set.length > 0);

    // 2) Dedupe identical sets (order-insensitive)
    const signature = (set) => set.slice().sort().join('|');
    const seen = new Set();
    const dedupedSets = [];
    for (const set of normalizedSets) {
        const sig = signature(set);
        if (!seen.has(sig)) {
            seen.add(sig);
            dedupedSets.push(set);
        }
    }

    // 3) Drop sets that are strict subsets of an earlier kept set (favor earlier ones)
    const kept = [];
    for (const set of dedupedSets) {
        let isSubset = false;
        for (const k of kept) {
            const kSet = new Set(k);
            // set ⊆ k ?
            isSubset = set.every((w) => kSet.has(w));
            if (isSubset) break;
        }
        if (!isSubset) kept.push(set);
    }

    // 4) Prefer the earliest sets (session-specific likely come first). Cap by count.
    let capped = kept.slice(0, maxSets);

    // 5) Ensure overall character cap by trimming from the end if needed
    const toInstruction = (sets) => sets.map((set) => `(${set.join(', ')})`).join('; ');
    while (capped.length > 0 && toInstruction(capped).length > maxTotalChars) {
        capped = capped.slice(0, capped.length - 1);
    }

    return capped;
}

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
    // Create a fresh AI instance without system instruction to avoid token overhead (like geo fix)
    const { getGenAIInstance } = await import('../llm/geminiClient.js');
    const ai = getGenAIInstance();
    const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash';
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
        const prunedSets = pruneExcludedKeywordSets(excludedKeywordSets);
        if (prunedSets.length > 0) {
            const flatExcludedKeywords = prunedSets.map(set => `(${set.join(', ')})`).join('; ');
            keywordExclusionInstruction = `\nCRITICAL KEYWORD AVOIDANCE: Avoid generating riddles that are conceptually defined by or heavily rely on the following keyword combinations/themes: [${flatExcludedKeywords}].`;
            try {
                logger.debug({
                    beforeSets: excludedKeywordSets.length,
                    afterSets: prunedSets.length,
                    instructionChars: keywordExclusionInstruction.length
                }, '[RiddleService] Pruned excluded keyword sets for prompt.');
            } catch (_) { /* ignore structured log issues */ }
        }
    }

    // Merge blacklist with excluded answers
    const allExcludedAnswers = [...(excludedAnswers || [])];
    if (actualTopic === 'general knowledge') {
        // For general knowledge topic, always exclude meta-concepts
        META_CONCEPT_BLACKLIST.forEach(word => {
            if (!allExcludedAnswers.includes(word)) {
                allExcludedAnswers.push(word);
            }
        });
        logger.info(`[RiddleService] Applied meta-concept blacklist for general knowledge. Total excluded answers: ${allExcludedAnswers.length}`);
    }
    
    let answerExclusionInstruction = "";
    if (allExcludedAnswers.length > 0) {
        answerExclusionInstruction = `\n\n🚫 ANSWER EXCLUSION (MANDATORY):
YOU MUST NOT use any of these answers: [${allExcludedAnswers.join(', ')}]
These have been used recently or are banned. Pick something COMPLETELY DIFFERENT.
If you generate a riddle with any of these answers, it will be rejected.`;
    }
    const fullExclusionInstructions = `${keywordExclusionInstruction}${answerExclusionInstruction}\n\nRequirement: Each riddle must have a UNIQUE, CONCRETE answer different from all previous riddles.`;

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
    
    // Perform actual search when useSearch is true
    if (useSearch) {
        const searchFactsPrompt = `Find interesting and unique facts about "${actualTopic}" suitable for a riddle. Focus on specific details, characteristics, and unique aspects that could inspire creative riddle clues.`;
        try {
            logger.info(`[RiddleService] Performing search for facts about "${actualTopic}"`);
            const searchResult = await ai.models.generateContent({
                model: modelId,
                contents: [{ role: "user", parts: [{ text: searchFactsPrompt }] }],
                tools: [{ googleSearch: {} }],
                config: { 
                    temperature: 0.75,
                    candidateCount: 1,
                    maxOutputTokens: 512 
                }
            });
            
            const searchText = searchResult?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (searchText && searchText.trim() !== "") {
                factualContextForRiddle = searchText.trim();
                logger.info(`[RiddleService] Successfully retrieved facts for "${actualTopic}". Length: ${factualContextForRiddle.length}`);
            } else {
                logger.warn(`[RiddleService] Search returned no factual information for topic "${actualTopic}".`);
            }
        } catch (searchError) {
            logger.error({ err: searchError, topic: actualTopic }, `[RiddleService] Error during factual search for riddle generation.`);
        }
    }
    
    let finalGenerationPrompt = "";
    // --- Improved riddle prompt for better guessability ---
    const baseGenerationPrompt = `You are a riddle crafter for a Twitch chat game. Create a riddle about "${actualTopic}" that is CLEVER but GUESSABLE.
${promptDetails}
${fullExclusionInstructions}

CORE PRINCIPLE: The riddle should be solvable by someone familiar with the topic. Avoid forcing obscure metaphors or multi-layered abstractions.

MANDATORY ANSWER REQUIREMENTS:
- The answer MUST be a CONCRETE, PHYSICAL, or TANGIBLE thing that exists in the real world
- For 'general knowledge': choose OBJECTS (book, clock, map, compass), ANIMALS (elephant, octopus), PLACES (library, museum), NATURAL PHENOMENA (rainbow, echo, shadow)
- For 'game' topics: choose CHARACTERS (Mario, Sonic), ITEMS (sword, potion, ring), LOCATIONS (castle, dungeon), ENEMIES (Goomba, Creeper)
- The answer must be something you can SEE, TOUCH, HEAR, or POINT TO
- NEVER use abstract concepts like: knowledge, memory, learning, information, data, wisdom, consciousness, thought, idea, mind
- Keep answers 1-2 words maximum, singular form when possible
- Good examples: "compass", "telescope", "penguin", "volcano", "diamond", "pyramid"

RULES FOR QUESTION:
- Length: 1-2 sentences, max ~200 characters
- Include 2-3 concrete clues that narrow down the answer (appearance, function, behavior, location, sound)
- Use classic riddle style ("I am...", "You'll find me...", "I help you...")
- Avoid purple prose, academic language, or overly abstract metaphors
- Each clue should eliminate wrong answers and guide toward the right one

DIFFICULTY GUIDANCE:
- easy: Very obvious clues, answer is immediate (e.g., "I'm red, round, and keep doctors away" → Apple)
- normal: Requires thinking but clues are clear (e.g., "I'm green, hop, and catch flies with my tongue" → Frog)
- hard: Clever wordplay or less direct clues, but still fair (e.g., "I have keys but no locks, space but no room" → Keyboard)

GOOD EXAMPLES (concrete, guessable, physical things):
✓ "I'm blue, fast, and collect golden rings" → Sonic (game character)
✓ "I have hands but cannot clap" → Clock (everyday object)
✓ "I'm thrown at monsters to capture them" → Pokeball (game item)
✓ "I have a trunk but never travel" → Elephant (animal)
✓ "I show you the world but never leave the wall" → Map (object)

BAD EXAMPLES - NEVER DO THESE:
✗ "I fill the gaps not taught in school" → knowledge (ABSTRACT CONCEPT - BANNED!)
✗ "I am a library without walls" → knowledge (META-CONCEPT - NOT ALLOWED!)
✗ "I am the dust on forgotten facts" → Dust (too philosophical, not fun)
✗ "I guard names behind mental doors" → tip of tongue (abstract mental state)
✗ "I am the currency of conversation" → Key (forced metaphor, not concrete usage)

If the answer is an abstract concept about thinking, learning, or mental processes, START OVER with a physical object instead.

EXPLANATION STYLE FOR TWITCH CHAT (Max 1-2 sentences):
Write fun, conversational explanations—NOT boring academic lectures. Vary your sentence starters!

✓ GOOD EXAMPLES:
- "A book has a spine just like your body—both hold things together!"
- "Compass needles always point north, and that's the whole trick!"
- "Museums are basically treasure troves of facts from every era—perfect metaphor!"
- "Globes look like Earth but never actually move, which is the clever bit."
- "It's called an [answer] because it [specific function related to riddle]."

✗ NEVER USE (academic boilerplate):
- "The riddle focuses on the physical characteristics of..."
- "This riddle uses clues drawn from the factual information provided..."
- "The answer is a concrete object that contains general knowledge..."
- Anything that sounds like a textbook explanation

Call "generate_riddle_with_answer_and_keywords" with your response.`;

    // --- SYSTEM_CONTEXT preface for all prompts ---
    if (useSearch && factualContextForRiddle) {
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}". Factual information from search is provided below to inspire your riddle.\n\n**Factual Information:**\n\`\`\`\n${factualContextForRiddle}\n\`\`\`\n\n${baseGenerationPrompt}\nRemember to set 'search_used: true' in your function call.`;
    } else if (useSearch) {
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}". Search was attempted but yielded no additional context. Use your existing knowledge.\n\n${baseGenerationPrompt}\nSet 'search_used: true' in your function call.`;
    } else { // No search
        finalGenerationPrompt = `**SYSTEM_CONTEXT**: The user requested a riddle on the topic "${actualTopic}".\n\n${baseGenerationPrompt}\nSet 'search_used: false' in your function call.`;
    }

    try {
        // Only use the generateRiddleTool here
        const result = await ai.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: finalGenerationPrompt }] }],
            config: {
                temperature: 0.75,
                candidateCount: 1,
                tools: [generateRiddleTool],
                toolConfig: { functionCallingConfig: { mode: "ANY" } }
            }
            // No systemInstruction - using fresh AI instance without CHAT_SAGE_SYSTEM_INSTRUCTION
        });

        const response = result;

        // Enhanced error checking
        if (response.promptFeedback?.blockReason) {
            logger.error('[RiddleService] Riddle generation blocked by safety settings.', {
                blockReason: response.promptFeedback.blockReason,
                safetyRatings: response.promptFeedback.safetyRatings,
                topic: actualTopic
            });
            return null;
        }

        const candidate = response?.candidates?.[0];

        if (!candidate) {
            logger.error('[RiddleService] No candidates in riddle generation response.', {
                topic: actualTopic,
                responseKeys: Object.keys(response || {})
            });
            return null;
        }

        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            logger.warn('[RiddleService] Riddle generation finished with unexpected reason.', {
                finishReason: candidate.finishReason,
                topic: actualTopic,
                hasContent: !!candidate.content
            });
            if (candidate.finishReason === 'SAFETY') {
                logger.error('[RiddleService] Riddle content blocked by safety filters.', { topic: actualTopic });
                return null;
            }
        }

        // Check for function call
        const functionCall = candidate?.content?.parts?.find(p => p?.functionCall)?.functionCall;

        if (!functionCall) {
            const textResponse = candidate?.content?.parts?.map(p => p?.text).filter(Boolean).join('').trim();
            logger.error('[RiddleService] Model did not call the expected function.', {
                topic: actualTopic,
                hasTextResponse: !!textResponse,
                textPreview: textResponse ? textResponse.substring(0, 100) : null,
                partsCount: candidate?.content?.parts?.length,
                parts: candidate?.content?.parts?.map(p => Object.keys(p || {}))
            });
            return null;
        }

        if (functionCall.name !== 'generate_riddle_with_answer_and_keywords') {
            logger.error('[RiddleService] Model called unexpected function.', {
                expectedFunction: 'generate_riddle_with_answer_and_keywords',
                actualFunction: functionCall.name,
                topic: actualTopic
            });
            return null;
        }

        const args = functionCall.args;
        if (!args) {
            logger.error('[RiddleService] Function call missing args.', { topic: actualTopic });
            return null;
        }

        if (!args.riddle_question || !args.riddle_answer || !args.keywords || args.keywords.length === 0) {
            logger.warn('[RiddleService] Function call made, but essential riddle parts missing.', {
                args,
                topic: actualTopic,
                hasQuestion: !!args.riddle_question,
                hasAnswer: !!args.riddle_answer,
                keywordsLength: args.keywords?.length || 0
            });
            return null;
        }

        // POST-GENERATION VALIDATION: Check if answer is in exclusion list
        const normalizedGeneratedAnswer = args.riddle_answer.toLowerCase().trim();
        if (allExcludedAnswers.some(excluded => normalizedGeneratedAnswer === excluded.toLowerCase().trim())) {
            logger.warn('[RiddleService] Generated answer is in exclusion list! Rejecting.', {
                generatedAnswer: args.riddle_answer,
                excludedAnswers: allExcludedAnswers,
                topic: actualTopic
            });
            return null; // This will trigger a retry
        }

        // Additional check: reject if answer is a blacklisted meta-concept
        if (META_CONCEPT_BLACKLIST.some(banned => normalizedGeneratedAnswer.includes(banned))) {
            logger.warn('[RiddleService] Generated answer contains blacklisted meta-concept! Rejecting.', {
                generatedAnswer: args.riddle_answer,
                topic: actualTopic
            });
            return null; // This will trigger a retry
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
    } catch (error) {
        logger.error({
            err: {
                message: error.message,
                stack: error.stack,
                name: error.name,
                status: error.status,
                code: error.code
            },
            topic: actualTopic,
            difficulty,
            useSearch
        }, '[RiddleService] Error generating riddle');
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
    // Blacklist check: reject generic acknowledgements and meta-concepts as user guesses
    const normalizedUserGuess = userAnswer.toLowerCase().trim();
    if (META_CONCEPT_BLACKLIST.includes(normalizedUserGuess)) {
        logger.info(`[RiddleService] Rejecting blacklisted word as guess: "${userAnswer}"`);
        return { isCorrect: false, reasoning: "Not a valid riddle answer.", confidence: 0.0 };
    }

    // Prefer @google/genai for structured output; fall back to older client if needed
    if (!globalThis.__genaiClient) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
        globalThis.__genaiClient = new GoogleGenAI({ apiKey });
    }
    const genaiModels = globalThis.__genaiClient.models;
    const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash';
    const model = getGeminiClient();
    // Helper to robustly extract text from Gemini responses
    const extractText = (resp) => {
        const cand = resp?.candidates?.[0];
        if (Array.isArray(cand?.content?.parts) && cand.content.parts.length > 0) {
            return cand.content.parts.map(p => p?.text || '').join('').trim();
        }
        if (cand && typeof cand.text === 'string' && cand.text.trim().length > 0) {
            return cand.text.trim();
        }
        if (resp && typeof resp.text === 'function') {
            const t = resp.text();
            return typeof t === 'string' ? t.trim() : '';
        }
        if (resp && typeof resp.text === 'string') {
            return resp.text.trim();
        }
        return '';
    };
    // Normalize inputs for comparison
    const normalize = (s) => {
        if (!s || typeof s !== 'string') return '';
        // Basic plural/singular handling and punctuation cleanup
        const cleaned = s
            .toLowerCase()
            .trim()
            .replace(/[-_''`]/g, ' ')
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/^[\s]*(?:the|a|an)\s+/i, '')
            .replace(/[\s]+/g, ' ');
        // Simple plural normalization
        if (cleaned.endsWith('ies')) return cleaned.slice(0, -3) + 'y';
        if (cleaned.endsWith('ses')) return cleaned.slice(0, -2); // e.g., "classes" -> "classe" (crude but helps match)
        if (cleaned.endsWith('s') && !cleaned.endsWith('ss')) return cleaned.slice(0, -1);
        return cleaned;
    };
    // Simple edit-distance for fuzzy matching
    const computeEditDistance = (a, b) => {
        const s1 = normalize(a);
        const s2 = normalize(b);
        const len1 = s1.length;
        const len2 = s2.length;
        if (len1 === 0) return len2;
        if (len2 === 0) return len1;
        const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
        for (let i = 0; i <= len1; i++) dp[i][0] = i;
        for (let j = 0; j <= len2; j++) dp[0][j] = j;
        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                if (s1[i - 1] === s2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
                else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[len1][len2];
    };
    const lowerCorrectAnswer = normalize(correctAnswer);
    const lowerUserAnswer = normalize(userAnswer);
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

    // Simplified fuzzy pre-check for common misspellings/near-variants
    if (!isTopicGuessInsteadOfAspect && !directMatch) {
        const distance = computeEditDistance(lowerUserAnswer, lowerCorrectAnswer);
        const maxLen = Math.max(lowerUserAnswer.length, lowerCorrectAnswer.length);
        if (distance <= 1) {
            logger.info(`[RiddleService] Pre-LLM fuzzy: edit distance ${distance} (<=1). Accepting as correct.`);
            return { isCorrect: true, reasoning: "Minor typo.", confidence: 0.95 };
        }
        if (maxLen >= 6 && distance <= 2) {
            logger.info(`[RiddleService] Pre-LLM fuzzy: edit distance ${distance} (<=2) on length ${maxLen}. Accepting as correct.`);
            return { isCorrect: true, reasoning: "Close variant.", confidence: 0.9 };
        }
        // Simple substring containment for short answers
        if ((lowerUserAnswer.length >= 4 && lowerCorrectAnswer.includes(lowerUserAnswer)) ||
            (lowerCorrectAnswer.length >= 4 && lowerUserAnswer.includes(lowerCorrectAnswer))) {
            logger.info(`[RiddleService] Pre-LLM substring containment between "${userAnswer}" and "${correctAnswer}". Accepting as correct.`);
            return { isCorrect: true, reasoning: "Substring match.", confidence: 0.88 };
        }
    }

    const prompt = `Riddle: "${riddleQuestion}"
Correct Answer: "${correctAnswer}"
User's Guess: "${userAnswer}"

Is the guess correct? Accept variants/synonyms (e.g., "map" = "maps" = "atlas"). Reject if different object or conversational message.

Return JSON ONLY: {"is_correct": boolean, "confidence": number, "reasoning": string}`

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

        // Primary attempt: schema-based structured output with small retries on 5xx
        const genWithSchema = async (maxTokens = 512, minimalPrompt = false) => {
            const res = await genaiModels.generateContent({
                model: modelId,
                contents: [{ role: 'user', parts: [{ text: minimalPrompt ? (() => {
                    const q = typeof riddleQuestion === 'string' && riddleQuestion.length > 300 ? (riddleQuestion.slice(0, 300) + '...') : riddleQuestion;
                    return `Question: "${q}"
Answer: "${correctAnswer}"
Guess: "${userAnswer}"

Return JSON ONLY: {"is_correct": boolean, "reasoning": string}. Keep reasoning under 6 words.`;
                })() : `${prompt}` }] }],
                config: {
                    temperature: 0.0,
                    maxOutputTokens: maxTokens,
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: GenAIType.OBJECT,
                        properties: {
                            is_correct: { type: GenAIType.BOOLEAN },
                            reasoning: { type: GenAIType.STRING }
                        },
                        propertyOrdering: ['is_correct', 'reasoning'],
                        required: ['is_correct', 'reasoning']
                    }
                },
                systemInstruction: {
                    parts: [{ text: 'You are a verifier. Output ONLY JSON that matches the schema; no preface, no extra text.' }]
                }
            });
            return { response: res };
        };
        let schemaResp;
        try {
            schemaResp = await genWithSchema(512, true);
        } catch (eSchema1) {
            const msg = String(eSchema1?.message || '');
            if (/\b(500|internal error)\b/i.test(msg)) {
                await new Promise(r => setTimeout(r, 200));
                try { schemaResp = await genWithSchema(512, true); } catch (eSchema2) {
                    const msg2 = String(eSchema2?.message || '');
                    if (/\b(500|internal error)\b/i.test(msg2)) {
                        await new Promise(r => setTimeout(r, 400));
                        schemaResp = await genWithSchema(512, true);
                    } else {
                        throw eSchema2;
                    }
                }
            } else {
                throw eSchema1;
            }
        }
        // Helper: prefer parsed from SDK; otherwise extract text
        const coerceParsed = (resp) => {
            try {
                const parsed = resp?.parsed;
                if (parsed && typeof parsed.is_correct === 'boolean') {
                    return parsed;
                }
            } catch (_) { /* ignore */ }
            return null;
        };
        const tryParseJsonString = (raw) => {
            if (!raw || typeof raw !== 'string') return null;
            try { return JSON.parse(raw); } catch (_) { /* continue */ }
            // Attempt to extract the first {...} block
            const first = raw.indexOf('{');
            const last = raw.lastIndexOf('}');
            if (first !== -1 && last !== -1 && last > first) {
                const sliced = raw.substring(first, last + 1).trim();
                try { return JSON.parse(sliced); } catch (_) { /* ignore */ }
            }
            return null;
        };
        // If finishReason indicates truncation or content missing, escalate retries with higher tokens and minimal prompt
        const fin = schemaResp?.candidates?.[0]?.finishReason;
        let sText = '';
        const respObj = schemaResp;
        let structured = coerceParsed(respObj);
        if (respObj && typeof respObj.text === 'string' && respObj.text.trim().length > 0) {
            sText = respObj.text.trim();
        } else {
            sText = extractText(respObj) || '';
        }
        if (!sText && !structured) {
            try {
                const parts = Array.isArray(respObj?.candidates) ? (respObj.candidates[0]?.content?.parts || []) : [];
                const joined = parts.map(p => p?.text || '').join('').trim();
                if (joined) sText = joined;
            } catch (_) { /* ignore */ }
        }
        if ((!sText && !structured) || fin === 'MAX_TOKENS') {
            try {
                // Try again with higher tokens
                const retryHigh = await genWithSchema(1024, true);
                const ro = retryHigh.response;
                structured = coerceParsed(ro) || structured;
                const textHigh = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                if (textHigh) sText = textHigh;
            } catch (_) { /* ignore */ }
        }
        if (!sText && !structured) {
            try {
                // Minimal prompt attempt
                const retryMin = await genWithSchema(256, true);
                const ro = retryMin.response;
                structured = coerceParsed(ro) || structured;
                const textMin = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                if (textMin) sText = textMin;
            } catch (_) { /* ignore */ }
        }
        if (!sText && !structured) {
            try {
                const preview = JSON.stringify(respObj).slice(0, 500);
                logger.warn({ preview }, '[RiddleService] Structured output response missing text.');
            } catch (_) {
                logger.warn('[RiddleService] Structured output response missing text and could not stringify.');
            }
        }
        // Prefer parsed object if available
        if (structured && typeof structured.is_correct === 'boolean') {
            try {
                logger.info(`[RiddleService] Structured verification: guess "${userAnswer}", correct "${correctAnswer}" -> ${structured.is_correct} (conf ${typeof structured.confidence === 'number' ? structured.confidence : 'n/a'}). Reason: ${structured.reasoning || ''}`);
            } catch (_) { /* ignore */ }
            if (structured.is_correct && isTopicGuessInsteadOfAspect) {
                return { isCorrect: false, reasoning: `The guess "${userAnswer}" is the general topic. The specific answer is "${correctAnswer}".`, confidence: 0.25 };
            }
            return { isCorrect: structured.is_correct, reasoning: structured.reasoning || '', confidence: typeof structured.confidence === 'number' ? structured.confidence : (structured.is_correct ? 0.9 : 0.1) };
        }
        if (sText) {
            let parsed = tryParseJsonString(sText);
            // If likely truncated (no closing brace), try one more high-token retry
            const looksTruncated = sText.includes('{') && !sText.trim().endsWith('}');
            if ((!parsed || looksTruncated) && !structured) {
                try {
                    const retryRepair = await genWithSchema(1024, false);
                    const ro = retryRepair.response;
                    structured = coerceParsed(ro) || structured;
                    const textRepair = typeof ro.text === 'string' && ro.text.trim().length > 0 ? ro.text.trim() : (extractText(ro) || (Array.isArray(ro?.candidates) ? (ro.candidates[0]?.content?.parts || []).map(p => p?.text || '').join('').trim() : ''));
                    if (textRepair) {
                        sText = textRepair;
                        parsed = tryParseJsonString(sText);
                    }
                } catch (_) { /* ignore */ }
            }
            
            if (parsed && typeof parsed.is_correct === 'boolean') {
                try {
                    logger.info(`[RiddleService] Parsed-json verification: guess "${userAnswer}", correct "${correctAnswer}" -> ${parsed.is_correct} (conf ${typeof parsed.confidence === 'number' ? parsed.confidence : 'n/a'}). Reason: ${parsed.reasoning || ''}`);
                } catch (_) { /* ignore */ }
                if (parsed.is_correct && isTopicGuessInsteadOfAspect) {
                    return { isCorrect: false, reasoning: `The guess "${userAnswer}" is the general topic. The specific answer is "${correctAnswer}".`, confidence: 0.25 };
                }
                return { isCorrect: parsed.is_correct, reasoning: parsed.reasoning || '', confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.is_correct ? 0.9 : 0.1) };
            } else if (sText) {
                logger.warn({ preview: sText.slice(0, 200) }, '[RiddleService] Schema parse failed.');
            }
        }

        // Fallback attempt 1: ask for strict JSON (no schema)
        let text = '';
        // Reuse the same prompt but request JSON explicitly
        try {
            const plainJsonResp = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nRespond ONLY as JSON: {"is_correct": true|false, "confidence": number, "reasoning": string}` }] }],
                generationConfig: { temperature: 0.0, maxOutputTokens: 80, responseMimeType: 'text/plain' }
            });
            text = extractText(plainJsonResp);
        } catch (_) { text = ''; }

        if (text) {
            try {
                // Try direct JSON parse first
                let candidateText = text.replace(/^```json\s*|```\s*$/g, '').trim();
                // If still not pure JSON, try extracting the first {...} block
                if (!(candidateText.startsWith('{') && candidateText.endsWith('}'))) {
                    const firstBrace = candidateText.indexOf('{');
                    const lastBrace = candidateText.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        candidateText = candidateText.substring(firstBrace, lastBrace + 1).trim();
                    }
                }
                const parsed = JSON.parse(candidateText);
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

        // Fallback attempt 2: Structured output via responseSchema (per Gemini structured output docs)
        try {
            const structured = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
            const sResp = structured.response;
            const sCand = sResp?.candidates?.[0];
            const sText = sCand?.content?.parts?.map(p => p?.text || '').join('').trim() || '';
            if (sText) {
                const parsed = JSON.parse(sText);
                if (typeof parsed.is_correct === 'boolean') {
                    try {
                        logger.info(`[RiddleService] Legacy-structured verification: guess "${userAnswer}", correct "${correctAnswer}" -> ${parsed.is_correct} (conf ${typeof parsed.confidence === 'number' ? parsed.confidence : 'n/a'}). Reason: ${parsed.reasoning || ''}`);
                    } catch (_) { /* ignore */ }
                    if (parsed.is_correct && isTopicGuessInsteadOfAspect) {
                        return { isCorrect: false, reasoning: `The guess "${userAnswer}" is the general topic. The specific answer is "${correctAnswer}".`, confidence: 0.25 };
                    }
                    return { isCorrect: parsed.is_correct, reasoning: parsed.reasoning || '', confidence: typeof parsed.confidence === 'number' ? parsed.confidence : (parsed.is_correct ? 0.9 : 0.1) };
                }
            }
        } catch (se) {
            logger.warn({ err: se?.message }, '[RiddleService] Structured-output attempt failed. Proceeding to basic fallback.');
        }
        // Function-calling fallback per docs (last-ditch structured decision)
        try {
            const verifyDecisionTool = {
                functionDeclarations: [{
                    name: "report_verification",
                    description: "Report whether the guess is correct for this specific riddle.",
                    parameters: {
                        type: "OBJECT",
                        properties: {
                            is_correct: { type: "BOOLEAN" },
                            confidence: { type: "NUMBER" },
                            reasoning: { type: "STRING" }
                        },
                        required: ["is_correct", "confidence", "reasoning"]
                    }
                }]
            };
            const fcPrompt = `Question: "${riddleQuestion}"\nAnswer: "${correctAnswer}"\nGuess: "${userAnswer}"\nCall report_verification with your decision.`;
            const callOnce = async () => {
                return await model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: fcPrompt }] }],
                    tools: [verifyDecisionTool],
                    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
                    generationConfig: { temperature: 0.0, maxOutputTokens: 64 }
                });
            };
            let fcResp;
            try {
                fcResp = await callOnce();
            } catch (eFc1) {
                const msg = String(eFc1?.message || '');
                if (/\b(500|internal error)\b/i.test(msg)) {
                    await new Promise(r => setTimeout(r, 200));
                    fcResp = await callOnce();
                } else {
                    throw eFc1;
                }
            }
            const fn = fcResp?.candidates?.[0]?.content?.parts?.[0]?.functionCall;
            if (fn?.name === 'report_verification') {
                const args = fn.args || {};
                if (typeof args.is_correct === 'boolean') {
                    if (args.is_correct && isTopicGuessInsteadOfAspect) {
                        return { isCorrect: false, reasoning: `The guess "${userAnswer}" is the general topic. The specific answer is "${correctAnswer}".`, confidence: 0.25 };
                    }
                    return { isCorrect: !!args.is_correct, reasoning: (args.reasoning || '').toString(), confidence: typeof args.confidence === 'number' ? args.confidence : (args.is_correct ? 0.9 : 0.1) };
                }
            }
        } catch (eFc) {
            logger.warn({ err: eFc?.message }, '[RiddleService] Function-calling fallback failed.');
        }

        // Regex-based parse fallback from any textual response
        try {
            const result2 = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nOutput strictly as JSON with keys is_correct, confidence, reasoning.` }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 160 }
            });
            const resp2 = result2;
            const cand2 = resp2?.candidates?.[0];
            const t2 = cand2?.content?.parts?.map(p => p?.text || '').join('\n') || '';
            const text2 = t2.replace(/^```json\s*|```\s*$/g, '').trim();
            const m = text2.match(/"?is_?correct"?\s*[:=]\s*(true|false)/i);
            if (m) {
                const isCorrectFromRegex = m[1].toLowerCase() === 'true';
                if (isCorrectFromRegex && isTopicGuessInsteadOfAspect) {
                    return { isCorrect: false, reasoning: `The guess "${userAnswer}" is the general topic. The specific answer is "${correctAnswer}".`, confidence: 0.25 };
                }
                return { isCorrect: isCorrectFromRegex, reasoning: isCorrectFromRegex ? 'Regex parse: correct' : 'Regex parse: incorrect', confidence: isCorrectFromRegex ? 0.85 : 0.15 };
            }
        } catch (_) { /* ignore */ }
        // Final fallback if nothing structured could be parsed
        logger.warn('[RiddleService] Answer verification failed to get structured response, using final basic comparison.');
        const isBasicCorrect = lowerUserAnswer === lowerCorrectAnswer;
        return { isCorrect: isBasicCorrect, reasoning: isBasicCorrect ? 'Exact match (final fallback).' : 'Incorrect (final fallback).', confidence: isBasicCorrect ? 0.85 : 0.1 };

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