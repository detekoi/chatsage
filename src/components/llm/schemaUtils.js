import { Type as GenAIType } from '@google/genai';

/**
 * Converts a standard plain JSON schema into an OpenAI strict JSON schema:
 * - Adds `additionalProperties: false` to object schemas
 * - Promotes all properties to `required`
 * - Converts `nullable: true` to `type: [type, "null"]`
 */
export function toOpenAiStrictSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    const copy = JSON.parse(JSON.stringify(schema));

    function processNode(node) {
        if (!node || typeof node !== 'object') return;

        // Handle nullable property
        if (node.nullable) {
            delete node.nullable;
            if (typeof node.type === 'string') {
                node.type = [node.type, 'null'];
            }
        }

        if (node.type === 'object' || node.properties) {
            node.additionalProperties = false;
            if (node.properties) {
                node.required = Object.keys(node.properties);
                for (const key of Object.keys(node.properties)) {
                    processNode(node.properties[key]);
                }
            }
        }

        if (node.type === 'array' && node.items) {
            processNode(node.items);
        }
    }

    processNode(copy);
    return copy;
}

/**
 * Converts a standard plain JSON schema into a Gemini GenAI Type schema.
 */
export function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    function mapType(typeStr) {
        switch (typeStr) {
            case 'object': return GenAIType.OBJECT;
            case 'string': return GenAIType.STRING;
            case 'number': return GenAIType.NUMBER;
            case 'integer': return GenAIType.INTEGER;
            case 'boolean': return GenAIType.BOOLEAN;
            case 'array': return GenAIType.ARRAY;
            default: return typeStr;
        }
    }

    function processNode(node) {
        if (!node || typeof node !== 'object') return node;

        const result = {};

        if (node.type) {
            result.type = mapType(node.type);
        }

        if (node.description) result.description = node.description;
        if (node.enum) result.enum = node.enum;

        if (node.properties) {
            result.properties = {};
            for (const key of Object.keys(node.properties)) {
                result.properties[key] = processNode(node.properties[key]);
            }
        }

        if (node.required) {
            result.required = [...node.required];
        }

        if (node.items) {
            result.items = processNode(node.items);
        }

        if (node.nullable !== undefined) {
            result.nullable = node.nullable;
        }

        return result;
    }

    return processNode(schema);
}

// --- Application Schemas (Standard JSON Schema format) ---

export const TriviaQuestionSchema = {
    type: 'object',
    properties: {
        question: { type: 'string', description: 'The trivia question to ask.' },
        correct_answer: { type: 'string', description: 'The single, most accurate, AND VERY CONCISE answer (1-3 key words).' },
        alternate_answers: {
            type: 'array',
            description: 'Alternative correct and VERY CONCISE answers or common variations.',
            items: { type: 'string' }
        },
        explanation: { type: 'string', description: 'Brief explanation of why the answer is correct.' },
        difficulty: { type: 'string', description: 'Difficulty level', enum: ['easy', 'normal', 'hard'] },
        search_used: { type: 'boolean', description: 'Whether external search was required.' },
        category: { type: 'string', description: 'Specific category for the answer.' }
    },
    required: ['question', 'correct_answer', 'explanation', 'difficulty', 'search_used', 'category']
};

export const LocalizedTriviaQuestionSchema = {
    type: 'object',
    properties: {
        ...TriviaQuestionSchema.properties,
        correct_answer_english: { type: 'string', description: 'Correct answer translated to English for verification.' },
        alternate_answers_english: {
            type: 'array',
            description: 'Alternate answers translated to English.',
            items: { type: 'string' }
        }
    },
    required: [...TriviaQuestionSchema.required, 'correct_answer_english']
};

export const TriviaVerificationSchema = {
    type: 'object',
    properties: {
        is_correct: { type: 'boolean' },
        confidence: { type: 'number' },
        reasoning: { type: 'string' }
    },
    required: ['is_correct', 'confidence', 'reasoning']
};

export const RiddleSchema = {
    type: 'object',
    properties: {
        riddle_question: { type: 'string', description: 'The text of the riddle.' },
        riddle_answer: { type: 'string', description: 'The single, concise, common answer to the riddle.' },
        keywords: {
            type: 'array',
            description: 'Core keywords or short phrases.',
            items: { type: 'string' }
        },
        difficulty_generated: { type: 'string', description: 'Difficulty', enum: ['easy', 'normal', 'hard'] },
        explanation: { type: 'string', description: 'Brief explanation.' },
        search_used: { type: 'boolean', description: 'Whether web search was used.' }
    },
    required: ['riddle_question', 'riddle_answer', 'keywords', 'difficulty_generated', 'explanation', 'search_used']
};

export const LocalizedRiddleSchema = {
    type: 'object',
    properties: {
        ...RiddleSchema.properties,
        riddle_answer_english: { type: 'string', description: 'Riddle answer translated to English.' }
    },
    required: [...RiddleSchema.required, 'riddle_answer_english']
};

export const RiddleVerificationSchema = {
    type: 'object',
    properties: {
        is_correct: { type: 'boolean' },
        confidence: { type: 'number' },
        reasoning: { type: 'string' }
    },
    required: ['is_correct', 'confidence', 'reasoning']
};

export const GeoClueSchema = {
    type: 'object',
    properties: {
        clue_text: { type: 'string', description: 'The engaging clue sentence.' }
    },
    required: ['clue_text']
};

export const GeoRevealSchema = {
    type: 'object',
    properties: {
        reveal_text: { type: 'string', description: 'The summary paragraph.' }
    },
    required: ['reveal_text']
};

export const GeoCheckGuessSchema = {
    type: 'object',
    properties: {
        target_name: { type: 'string', description: 'Target location name.' },
        guess: { type: 'string', description: "User's guess." },
        alternate_names: { type: 'array', items: { type: 'string' }, description: 'Official alternate names.' },
        is_correct: { type: 'boolean', description: 'Set to true ONLY for confident match.' },
        confidence: { type: 'number', description: 'Score 0.0-1.0.' },
        reasoning: { type: 'string', description: 'Reason for decision.' }
    },
    required: ['target_name', 'guess', 'is_correct', 'confidence', 'reasoning']
};

export const TimezoneSchema = {
    type: 'object',
    properties: {
        iana_timezone: { type: 'string', description: 'Valid IANA timezone string or UNKNOWN.' }
    },
    required: ['iana_timezone']
};

export const SearchDecisionSchema = {
    type: 'object',
    properties: {
        searchNeeded: { type: 'boolean' },
        reasoning: { type: 'string' }
    },
    required: ['searchNeeded', 'reasoning']
};

export const SummarySchema = {
    type: 'object',
    properties: {
        summary: { type: 'string' }
    },
    required: ['summary']
};

export const TranslateCommandSchema = {
    type: 'object',
    properties: {
        action: { type: 'string', description: "Action: 'enable', 'stop', 'stop_all'" },
        targetUser: { type: 'string', nullable: true, description: 'Username targeted or null for self' },
        language: { type: 'string', nullable: true, description: 'Target language or null for stop' }
    },
    required: ['action']
};

export const TranslationResponseSchema = {
    type: 'object',
    properties: {
        same_language: { type: 'boolean', description: 'True if already in target language' },
        translated_text: { type: 'string', description: 'Translated text string' }
    },
    required: ['same_language', 'translated_text']
};
