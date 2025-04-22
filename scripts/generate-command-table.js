// scripts/generate-command-table.js
import commandHandlers from '../src/components/commands/handlers/index.js';
import fs from 'fs';
import path from 'path';
// --- Import helpers for ES Module __dirname equivalent ---
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// --- Get current directory path in ES Module ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// --- End ES Module path setup ---

// Use the calculated __dirname
const OUTPUT_FILE = path.resolve(__dirname, '../docs/generated_command_table_body.html');

console.log("Generating HTML table body for commands...");

let htmlOutput = '';
const processedHandlers = new Set();

const sortedEntries = Object.entries(commandHandlers).sort(([a], [b]) => a.localeCompare(b));

for (const [commandName, handler] of sortedEntries) {
    if (!handler || processedHandlers.has(handler)) {
        continue;
    }
    processedHandlers.add(handler);

    const aliases = sortedEntries
        .filter(([name, h]) => h === handler)
        .map(([name]) => `!${name}`)
        .join(' / ');

    const description = handler.description || 'No description available.';
    const usage = handler.usage || `!${commandName}`;

    const escapeHtml = (unsafe) => {
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;");
     };

    htmlOutput += `            <tr>\n`;
    htmlOutput += `                <td>${escapeHtml(aliases)}</td>\n`;
    htmlOutput += `                <td>${escapeHtml(description)}</td>\n`;
    htmlOutput += `                <td><code>${escapeHtml(usage)}</code></td>\n`;
    htmlOutput += `            </tr>\n`;
}

console.log("\n--- HTML Table Body (tbody content) ---");
console.log(htmlOutput);
console.log("--- End HTML ---");

try {
    // Ensure the docs directory exists before writing
    const docsDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(docsDir)) {
        fs.mkdirSync(docsDir, { recursive: true });
         console.log(`Created directory: ${docsDir}`);
    }
    fs.writeFileSync(OUTPUT_FILE, htmlOutput);
    console.log(`\nTable body also written to: ${OUTPUT_FILE}`);
} catch (err) {
    console.error(`\nError writing to file ${OUTPUT_FILE}:`, err);
}