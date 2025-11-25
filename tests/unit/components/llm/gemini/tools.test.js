// tests/unit/components/llm/gemini/tools.test.js

import {
    standardAnswerTools,
    searchTool
} from '../../../../../src/components/llm/gemini/tools.js';

describe('gemini/tools.js', () => {
    describe('standardAnswerTools', () => {
        it('should define functionDeclarations', () => {
            expect(standardAnswerTools).toHaveProperty('functionDeclarations');
            expect(Array.isArray(standardAnswerTools.functionDeclarations)).toBe(true);
        });

        it('should include getCurrentTime tool', () => {
            const tool = standardAnswerTools.functionDeclarations.find(t => t.name === 'getCurrentTime');
            expect(tool).toBeDefined();
            expect(tool.description).toContain('current date and time');
        });

        it('should include get_iana_timezone_for_location_tool tool', () => {
            const tool = standardAnswerTools.functionDeclarations.find(t => t.name === 'get_iana_timezone_for_location_tool');
            expect(tool).toBeDefined();
            expect(tool.description).toContain('IANA timezone');
        });
    });

    describe('searchTool', () => {
        it('should be an array with googleSearch object', () => {
            expect(Array.isArray(searchTool)).toBe(true);
            expect(searchTool[0]).toHaveProperty('googleSearch');
        });
    });
});
