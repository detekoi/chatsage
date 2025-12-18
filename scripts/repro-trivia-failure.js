
import { GoogleGenAI } from "@google/genai";
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
const modelId = process.env.GEMINI_MODEL_ID || 'gemini-2.0-flash-exp';

console.log(`Using model: ${modelId}`);

const client = new GoogleGenAI({ apiKey });

const triviaQuestionTool = {
    functionDeclarations: [{
        name: "generate_trivia_question",
        description: "Generates a factually accurate trivia question with answer based on the given criteria.",
        parameters: {
            type: "OBJECT",
            properties: {
                question: { type: "STRING" },
                correct_answer: { type: "STRING" },
                alternate_answers: { type: "ARRAY", items: { type: "STRING" } },
                explanation: { type: "STRING" },
                difficulty: { type: "STRING" },
                search_used: { type: "BOOLEAN" },
                category: { type: "STRING" }
            },
            required: ["question", "correct_answer", "explanation", "difficulty", "search_used", "category"]
        }
    }]
};

async function testFunctionCalling() {
    const prompt = `Generate an engaging general knowledge trivia question.\nDifficulty: normal.\n\nCall 'generate_trivia_question' function. Keep 'correct_answer' concise (1-3 words). Set 'search_used: false'. Also set a generic 'category' describing the answer type.`;

    try {
        console.log('Generating content...');
        const result = await client.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                tools: [triviaQuestionTool],
                toolConfig: {
                    functionCallingConfig: {
                        mode: "ANY",
                    }
                },
                temperature: 0.7
            }
        });

        const part = result.candidates[0].content.parts[0];
        if (part.functionCall) {
            console.log('SUCCESS: Function call received:');
            console.log(JSON.stringify(part.functionCall, null, 2));
        } else {
            console.log('FAILURE: No function call received.');
            console.log('Text received:', part.text);
        }

    } catch (error) {
        console.error('Error:', error);
    }
}

testFunctionCalling();
