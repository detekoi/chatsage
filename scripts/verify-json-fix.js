
import { generateStandardResponse } from '../src/components/llm/gemini/generation.js';
import { getGeminiClient } from '../src/components/llm/gemini/core.js';
import assert from 'assert';

// Mock the Gemini client
const mockGenerateContent = async ({ contents }) => {
    // Simulate the problematic JSON response
    const jsonResponse = JSON.stringify({
        action: "reply",
        text: "This is the actual message we want to extract."
    });

    return {
        candidates: [{
            content: {
                parts: [{ text: jsonResponse }]
            }
        }],
        text: () => jsonResponse
    };
};

// Mock module imports
const mockCore = {
    getGeminiClient: () => ({
        generateContent: mockGenerateContent
    }),
    getGenAIInstance: () => ({}),
    getConfiguredModelId: () => 'mock-model'
};

// We need to intercept the imports in generation.js, but since ES modules are hard to mock without a test runner,
// we'll rely on a slightly different approach for this isolated script: 
// We will test a standalone extraction function that mirrors the logic we plan to inject, 
// OR we can rely on the fact that if we were running this in a real test environment we'd mock the module.
//
// However, since I can't easily mock ES modules in a standalone script without a loader, 
// I will create a unit test file in the `tests/unit` directory that uses the project's testing setup if possible,
// or just modify the code and verify manually.
//
// BUT, to be "agentic" and precise, I will create a new test file that *actually* imports the file 
// after I've modified it, or I can define the "fix" function locally here to prove it works before applying.

function robustExtract(text) {
    if (!text) return null;
    try {
        // Attempt to parse as JSON
        // We only want to parse if it looks like a JSON object start
        const trimmed = text.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            const parsed = JSON.parse(trimmed);
            if (parsed.text && typeof parsed.text === 'string') {
                return parsed.text;
            }
        }
    } catch (e) {
        // Not valid JSON, ignore
    }
    return text;
}

// Test cases
console.log('Running robust extraction tests...');

const case1 = '{ "action": "reply", "text": "Hello world" }';
const result1 = robustExtract(case1);
assert.strictEqual(result1, "Hello world", "Should extract text from JSON");
console.log('✓ Case 1 passed');

const case2 = 'Just a normal plain text response.';
const result2 = robustExtract(case2);
assert.strictEqual(result2, "Just a normal plain text response.", "Should return plain text as is");
console.log('✓ Case 2 passed');

const case3 = '{ "some": "other", "json": "obj" }'; // No text field
const result3 = robustExtract(case3);
// In this case, if it doesn't have 'text', we probably just want to return the whole thing? 
// Or maybe we still return the raw JSON because we don't know what else to do. 
// The plan said: "If it is valid JSON and contains a text property, return that property. Otherwise, return the raw text".
assert.strictEqual(result3, case3, "Should return raw JSON if 'text' property is missing");
console.log('✓ Case 3 passed');

const case4 = '  { "text": "  Trimmed text  " }  ';
const result4 = robustExtract(case4);
assert.strictEqual(result4, "  Trimmed text  ", "Should extract text field even with whitespace");
console.log('✓ Case 4 passed');

console.log('All reproduction logic checks passed.');
