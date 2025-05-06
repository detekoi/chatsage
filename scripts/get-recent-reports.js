// scripts/get-recent-reports.js
import { Firestore } from '@google-cloud/firestore';
import fs from 'fs'; // Import Node.js file system module
import path from 'path'; // Import Node.js path module
import open from 'open'; // Import the 'open' package
import { fileURLToPath } from 'url'; // Helper for __dirname in ES modules
import { dirname } from 'path'; // Helper for __dirname in ES modules

// --- Configuration ---
const TRIVIA_COLLECTION = 'triviaQuestions';
const GEO_HISTORY_COLLECTION = 'geoGameHistory';
const TOTAL_REPORTS_LIMIT = 500;
const QUERY_LIMIT_PER_COLLECTION = 500;
const OUTPUT_HTML_FILENAME = 'game_reports.html'; // Name of the output file
// --- End Configuration ---

// Helper to get the directory name in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Firestore Initialization (same as before) ---
let db;
try {
    db = new Firestore();
    console.log('Firestore client initialized successfully.');
} catch (error) {
    console.error("Error initializing Firestore:", error);
    console.error("Ensure Application Default Credentials (ADC) are configured.");
    process.exit(1);
}

// --- fetchReports function (same as before) ---
async function fetchReports(collectionName, reportType, limit) {
    console.log(`Workspaceing up to ${limit} reports from ${collectionName}...`);
    const reports = [];
    try {
        const query = db.collection(collectionName)
            .where('flaggedAsProblem', '==', true)
            .orderBy('flaggedTimestamp', 'desc')
            .limit(limit);

        const snapshot = await query.get();

        if (!snapshot.empty) {
            snapshot.forEach(doc => {
                const data = doc.data();
                const flaggedTimeMillis = data.flaggedTimestamp?.toMillis ? data.flaggedTimestamp.toMillis() : null;

                reports.push({
                    id: doc.id,
                    type: reportType,
                    reason: data.problemReason || 'N/A',
                    flaggedTimestampMillis: flaggedTimeMillis,
                    ...(reportType === 'trivia' && { question: data.question, answer: data.answer }),
                    ...(reportType === 'geo' && { location: data.location, channel: data.channel }),
                    rawData: data // Keeping rawData might be useful
                });
            });
        }
        console.log(`Workspaceed ${reports.length} reports from ${collectionName}.`);
    } catch (error) {
        console.error(`Error fetching reports from ${collectionName}:`, error);
        if (error.code === 5 && error.details?.includes('index')) {
             console.error(`\n Firestore index required for collection '${collectionName}'.`);
             console.error(` Please create a composite index on 'flaggedAsProblem' (ascending) and 'flaggedTimestamp' (descending).\n`);
        }
    }
    return reports;
}

// --- NEW: Function to generate HTML content ---
/**
 * Generates an HTML string to display the reports in a table.
 * @param {Array<object>} reports - The sorted array of report objects.
 * @returns {string} The generated HTML content.
 */
function generateHtml(reports) {
    let tableRows = '';
    if (reports.length === 0) {
        tableRows = '<tr><td colspan="5">No reports found.</td></tr>';
    } else {
        reports.forEach(report => {
            const date = report.flaggedTimestampMillis ? new Date(report.flaggedTimestampMillis).toLocaleString() : 'No Timestamp';
            const type = report.type.toUpperCase();
            const reason = escapeHtml(report.reason);
            let details = '';
            if (report.type === 'trivia') {
                details = `Q: ${escapeHtml(report.question || 'N/A')}<br>A: ${escapeHtml(report.answer || 'N/A')}`;
            } else if (report.type === 'geo') {
                details = `Loc: ${escapeHtml(report.location || 'N/A')}<br>Ch: ${escapeHtml(report.channel || 'N/A')}`;
            }
            const id = escapeHtml(report.id);

            tableRows += `
                <tr>
                    <td>${type}</td>
                    <td>${date}</td>
                    <td>${reason}</td>
                    <td>${details}</td>
                    <td>${id}</td>
                </tr>
            `;
        });
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Recent Game Reports</title>
    <style>
        body { font-family: sans-serif; margin: 20px; background-color: #f4f4f4; color: #333; }
        h1 { text-align: center; color: #2c3e50; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; background-color: #fff; box-shadow: 0 2px 3px rgba(0,0,0,0.1); }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #3498db; color: #fff; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.03em; }
        tr:nth-child(even) { background-color: #ecf0f1; }
        tr:hover { background-color: #d6eaf8; }
        td:nth-child(1) { font-weight: bold; min-width: 60px; } /* Type */
        td:nth-child(2) { min-width: 180px; } /* Timestamp */
        td:nth-child(3) { max-width: 300px; word-wrap: break-word; } /* Reason */
        td:nth-child(4) { max-width: 400px; word-wrap: break-word; } /* Details */
        td:nth-child(5) { font-family: monospace; font-size: 0.85em; color: #7f8c8d; } /* ID */
    </style>
</head>
<body>
    <h1>Recent Game Reports (Top ${reports.length})</h1>
    <table>
        <thead>
            <tr>
                <th>Type</th>
                <th>Reported At</th>
                <th>Reason</th>
                <th>Details</th>
                <th>ID</th>
            </tr>
        </thead>
        <tbody>
            ${tableRows}
        </tbody>
    </table>
</body>
</html>
    `;
}

// Basic HTML escaping function
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return unsafe; // Return non-strings as is
    }
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}


// --- Main function (modified) ---
async function getRecentReports() {
    console.log(`Workspaceing combined reports (limit ${TOTAL_REPORTS_LIMIT})...`);

    try {
        const [triviaReports, geoReports] = await Promise.all([
            fetchReports(TRIVIA_COLLECTION, 'trivia', QUERY_LIMIT_PER_COLLECTION),
            fetchReports(GEO_HISTORY_COLLECTION, 'geo', QUERY_LIMIT_PER_COLLECTION)
        ]);

        const allReports = [...triviaReports, ...geoReports];
        console.log(`Total reports fetched before sorting: ${allReports.length}`);

        allReports.sort((a, b) => {
            const timeA = a.flaggedTimestampMillis || 0;
            const timeB = b.flaggedTimestampMillis || 0;
            return timeB - timeA;
        });

        const finalReports = allReports.slice(0, TOTAL_REPORTS_LIMIT);

        // Generate HTML
        console.log("Generating HTML report...");
        const htmlContent = generateHtml(finalReports);

        // Define output path (e.g., in the project root directory)
        // `__dirname` is the directory of the *current script* (scripts/)
        // `path.join(__dirname, '..')` goes up one level to the project root
        const reportFilePath = path.join(__dirname, '..', OUTPUT_HTML_FILENAME);

        // Write HTML to file
        fs.writeFileSync(reportFilePath, htmlContent);
        console.log(`HTML report saved to: ${reportFilePath}`);

        // Open the HTML file in the default browser
        await open(reportFilePath);
        console.log(`Opening ${reportFilePath} in your default browser...`);

    } catch (error) {
        console.error("\nAn error occurred during the main report fetching/generation process:", error);
    }
}

// Run the main function
getRecentReports();