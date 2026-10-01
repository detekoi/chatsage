// tests/unit/components/llm/schemaUtils.test.js

import { toGeminiJsonSchema, TranslationResponseSchema, TranslateCommandSchema } from '../../../../src/components/llm/schemaUtils.js';

describe('toGeminiJsonSchema', () => {
    it('should convert nullable to a JSON Schema type array', () => {
        const result = toGeminiJsonSchema(TranslateCommandSchema);

        expect(result.properties.targetUser.type).toEqual(['string', 'null']);
        expect(result.properties.targetUser.nullable).toBeUndefined();
        expect(result.properties.action.type).toBe('string');
    });

    it('should convert nested object and array item nodes', () => {
        const result = toGeminiJsonSchema({
            type: 'object',
            properties: {
                list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string', nullable: true } } } }
            }
        });

        expect(result.properties.list.items.properties.x.type).toEqual(['string', 'null']);
    });

    it('should keep standard lowercase types and property order', () => {
        const result = toGeminiJsonSchema(TranslationResponseSchema);

        expect(result.type).toBe('object');
        // Gemini emits keys in schema order, so the decision fields must precede the chat text
        expect(Object.keys(result.properties)).toEqual(['same_language', 'untranslatable', 'notes', 'translated_text']);
    });

    it('should not mutate the input schema', () => {
        toGeminiJsonSchema(TranslateCommandSchema);

        expect(TranslateCommandSchema.properties.targetUser.nullable).toBe(true);
    });
});
