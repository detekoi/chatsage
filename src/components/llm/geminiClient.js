// src/components/llm/geminiClient.js
// This file is now a facade that exports functionality from the modularized structure in ./gemini/

export {
    initializeGeminiClient,
    getGenAIInstance,
    getGeminiClient
} from './gemini/core.js';

export {
    getOrCreateChatSession,
    resetChatSession,
    clearChatSession
} from './gemini/chat.js';

export {
    buildContextPrompt
} from './gemini/prompts.js';

export {
    generateStandardResponse,
    generateSearchResponse,
    generateUnifiedResponse,
    summarizeText,
    fetchIanaTimezoneForLocation
} from './gemini/generation.js';

export {
    decideSearchWithStructuredOutput
} from './gemini/decision.js';