// scripts/generate-command-table.js
import commandHandlers from '../src/components/commands/handlers/index.js';
import fs from 'fs';
import path from 'path';

const OUTPUT_FILE = path.resolve(__dirname, '../docs/generated_command_table_body.html'); // Optional: write to file

console.log("Generating HTML table body for commands...");

let htmlOutput = '';
const processedHandlers = new Set(); // To avoid listing aliases separately if they point to the same handler object

// Sort commands alphabetically for consistency
const sortedEntries = Object.entries(commandHandlers).sort(([a], [b]) => a.localeCompare(b));

for (const [commandName, handler] of sortedEntries) {
    // Check if we've already processed this specific handler object
    if (!handler || processedHandlers.has(handler)) {
        // Skip if handler is undefined or already processed (it's an alias pointing to the same object)
        continue;
    }

    // Mark this handler as processed
    processedHandlers.add(handler);

    // Find all command names (including aliases) that point to this handler
    const aliases = sortedEntries
        .filter(([name, h]) => h === handler)
        .map(([name]) => `!${name}`)
        .join(' / '); // e.g., "!ask / !search"

    const description = handler.description || 'No description available.';
    const usage = handler.usage || `!${commandName}`; // Fallback usage

    // Basic HTML escaping (replace < > &) - more robust escaping might be needed for complex descriptions
    const escapeHtml = (unsafe) => {
        return unsafe
             .replace(/&/g, "&")
             .replace(/</g, "<")
             .replace(/>/g, ">");
     };

    htmlOutput += `            <tr>\n`;
    htmlOutput += `                <td>${escapeHtml(aliases)}</td>\n`;
    htmlOutput += `                <td>${escapeHtml(description)}</td>\n`;
    htmlOutput += `                <td><code>${escapeHtml(usage)}</code></td>\n`; // Wrap usage in <code>
    htmlOutput += `            </tr>\n`;
}

console.log("\n--- HTML Table Body (tbody content) ---");
console.log(htmlOutput);
console.log("--- End HTML ---");

// Optional: Write to file
try {
    fs.writeFileSync(OUTPUT_FILE, htmlOutput);
    console.log(`\nTable body also written to: ${OUTPUT_FILE}`);
} catch (err) {
    console.error(`\nError writing to file ${OUTPUT_FILE}:`, err);
}