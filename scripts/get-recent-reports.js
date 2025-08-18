// scripts/get-recent-reports.js
import { Firestore } from '@google-cloud/firestore';
import fs from 'fs';
import path from 'path';
import open from 'open';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// --- Configuration ---
// Collection names where reports are stored
const TRIVIA_GAME_HISTORY = 'triviaGameHistory'; // Collection for flagged trivia questions
const GEO_HISTORY_COLLECTION = 'geoGameHistory';
const RIDDLE_HISTORY_COLLECTION = 'riddleGameHistory';
const TOTAL_REPORTS_LIMIT = 500;
const QUERY_LIMIT_PER_COLLECTION = 500;
const OUTPUT_HTML_FILENAME = 'game_reports.html';
// --- End Configuration ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db;
try {
    db = new Firestore();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'Unknown';
    console.log(`Firestore client initialized successfully. Project ID: ${projectId}`);
} catch (error) {
    console.error("Error initializing Firestore:", error);
    console.error("Ensure Application Default Credentials (ADC) are configured.");
    console.error("Run 'gcloud auth application-default login' to set up credentials");
    process.exit(1);
}

async function fetchReports(collectionName, reportType, limit) {
    console.log(`Fetching up to ${limit} reports from ${collectionName}...`);
    const reports = [];
    try {
        // First, attempt a simple count query to verify collection exists and is accessible
        try {
            const countQuery = db.collection(collectionName).limit(1);
            const countSnapshot = await countQuery.get();
            console.log(`Collection ${collectionName} access test: ${countSnapshot.empty ? 'empty' : 'has documents'}`);
        } catch (testError) {
            console.error(`Failed basic access test for collection ${collectionName}:`, testError.message);
            // Continue with the main query attempt regardless
        }
        
        const query = db.collection(collectionName)
            .where('flaggedAsProblem', '==', true)
            .orderBy('flaggedTimestamp', 'desc')
            .limit(limit);

        console.log(`Executing Firestore query on collection: ${collectionName} for type: ${reportType}`);
        const snapshot = await query.get();

        console.log(`Query returned ${snapshot.size} document(s) from ${collectionName}`);
        if (!snapshot.empty) {
            snapshot.forEach(doc => {
                const data = doc.data();
                const flaggedTimeMillis = data.flaggedTimestamp?.toMillis ? data.flaggedTimestamp.toMillis() : null;

                const reportEntry = {
                    id: doc.id,
                    type: reportType,
                    reason: data.problemReason || 'N/A',
                    reportedBy: data.reportedBy || 'N/A',
                    flaggedTimestampMillis: flaggedTimeMillis,
                    // Use 'channelName' if available (from riddle/geo history), otherwise 'channel' (geo might use this)
                    channel: data.channelName || data.channel || (reportType === 'trivia' ? 'N/A - Bank' : 'N/A'),
                    rawData: data 
                };

                // Populate question/answer/details based on reportType
                if (reportType === 'trivia') {
                    // For trivia reports, use 'question' and 'answer' fields
                    reportEntry.question = data.question || 'N/A';
                    reportEntry.answer = data.answer || 'N/A';
                } else if (reportType === 'geo') {
                    reportEntry.location = data.location || 'N/A';
                    // 'channel' field from data is already handled by reportEntry.channel
                } else if (reportType === 'riddle') {
                    reportEntry.question = data.riddleText || 'N/A'; // Correct from riddleGameHistory
                    reportEntry.answer = data.riddleAnswer || 'N/A'; // Correct from riddleGameHistory
                    reportEntry.keywords = data.keywords || [];
                    reportEntry.topic = data.topic || 'N/A';
                     // 'channelName' field from data is already handled by reportEntry.channel
                }
                reports.push(reportEntry);
            });
        }
        console.log(`Fetched ${reports.length} reports from ${collectionName}.`);
    } catch (error) {
        console.error(`Error fetching reports from ${collectionName}:`, error.message);
        
        if (error.code === 5 && error.message && error.message.includes('index')) {
             console.error(`\n Firestore index required for collection '${collectionName}'.`);
             console.error(` Please create a composite index on 'flaggedAsProblem' (ascending) and 'flaggedTimestamp' (descending).\n`);
        } else if (error.code === 7 && error.message && error.message.includes('PERMISSION_DENIED')) {
             console.error(`\n Permission denied accessing Firestore. Check your credentials and ensure the Firestore API is enabled.`);
             console.error(` Use 'gcloud auth application-default login' and 'gcloud config set project YOUR_PROJECT_ID'\n`);
        } else {
            console.error("Full error details:", error); // Log full error for other issues
        }
    }
    return reports;
}

function generateHtml(reports) {
    let tableRows = '';
    if (reports.length === 0) {
        tableRows = '<tr><td colspan="7">No reports found.</td></tr>'; // Updated colspan
    } else {
        reports.forEach(report => {
            const date = report.flaggedTimestampMillis ? new Date(report.flaggedTimestampMillis).toLocaleString() : 'No Timestamp';
            const type = report.type.toUpperCase();
            const channel = escapeHtml(report.channel);
            const reportedBy = escapeHtml(report.reportedBy);
            const reason = escapeHtml(report.reason);
            let details = '';

            if (report.type === 'trivia') {
                details = `Q: ${escapeHtml(report.question)}<br>A: ${escapeHtml(report.answer)}`;
            } else if (report.type === 'geo') {
                details = `Loc: ${escapeHtml(report.location)}`;
            } else if (report.type === 'riddle') {
                details = `Q: ${escapeHtml(report.question)}<br>A: ${escapeHtml(report.answer)}`;
                if (report.keywords && report.keywords.length > 0) {
                    details += `<br>Keywords: ${escapeHtml(report.keywords.join(', '))}`;
                }
                if (report.topic) {
                    details += `<br>Topic: ${escapeHtml(report.topic)}`;
                }
            }
            const id = escapeHtml(report.id);

            tableRows += `
                <tr>
                    <td>${type}</td>
                    <td>${channel}</td>
                    <td>${date}</td>
                    <td>${reportedBy}</td>
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
        th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #ddd; font-size: 0.9em; }
        th { background-color: #3498db; color: #fff; text-transform: uppercase; letter-spacing: 0.03em; }
        tr:nth-child(even) { background-color: #ecf0f1; }
        tr:hover { background-color: #d6eaf8; }
        td { word-wrap: break-word; max-width: 250px; } /* General max-width */
        td:nth-child(1) { font-weight: bold; min-width: 50px; } /* Type */
        td:nth-child(2) { min-width: 100px; } /* Channel */
        td:nth-child(3) { min-width: 150px; } /* Timestamp */
        td:nth-child(4) { min-width: 100px; } /* Reported By */
        td:nth-child(5) { max-width: 200px; } /* Reason */
        td:nth-child(6) { max-width: 300px; } /* Details */
        td:nth-child(7) { font-family: monospace; color: #7f8c8d; max-width: 150px; } /* ID */
    </style>
</head>
<body>
    <h1>Recent Game Reports (Top ${reports.length})</h1>
    <table>
        <thead>
            <tr>
                <th>Type</th>
                <th>Channel</th>
                <th>Reported At</th>
                <th>Reported By</th>
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

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') {
        return unsafe === undefined || unsafe === null ? '' : String(unsafe); 
    }
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}



async function main() {
    console.log(`Fetching combined reports from all game collections (limit ${TOTAL_REPORTS_LIMIT})...`);
    console.log(`Authentication instructions:`);
    console.log(`  1. Ensure you have gcloud CLI installed: https://cloud.google.com/sdk/docs/install`);
    console.log(`  2. Run: gcloud auth application-default login`);
    console.log(`  3. Run: gcloud config set project YOUR_PROJECT_ID (replace with your actual GCP project ID)`);
    console.log(`  4. Run this script again\n`);
    try {
        const [triviaReports, geoReports, riddleReports] = await Promise.all([
            fetchReports(TRIVIA_GAME_HISTORY, 'trivia', QUERY_LIMIT_PER_COLLECTION),
            fetchReports(GEO_HISTORY_COLLECTION, 'geo', QUERY_LIMIT_PER_COLLECTION),
            fetchReports(RIDDLE_HISTORY_COLLECTION, 'riddle', QUERY_LIMIT_PER_COLLECTION),
        ]);

        const allReports = [...triviaReports, ...geoReports, ...riddleReports];
        console.log(`Total reports fetched before sorting: ${allReports.length}`);

        allReports.sort((a, b) => {
            const timeA = a.flaggedTimestampMillis || 0;
            const timeB = b.flaggedTimestampMillis || 0;
            return timeB - timeA;
        });

        const finalReports = allReports.slice(0, TOTAL_REPORTS_LIMIT);

        console.log("Generating HTML report...");
        const htmlContent = generateHtml(finalReports);
        const reportFilePath = path.join(__dirname, '..', OUTPUT_HTML_FILENAME);

        fs.writeFileSync(reportFilePath, htmlContent);
        console.log(`HTML report saved to: ${reportFilePath}`);

        await open(reportFilePath);
        console.log(`Opening ${reportFilePath} in your default browser...`);

    } catch (error) {
        console.error("\nAn error occurred during the main report fetching/generation process:", error);
    }
}

main();