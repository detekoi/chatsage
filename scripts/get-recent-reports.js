// scripts/get-recent-reports.js
import { Firestore } from '@google-cloud/firestore';

// --- Configuration ---
const TRIVIA_COLLECTION = 'triviaQuestions';
const GEO_HISTORY_COLLECTION = 'geoGameHistory';
const TOTAL_REPORTS_LIMIT = 100;
// Fetch slightly more from each initially in case reports are unevenly distributed
const QUERY_LIMIT_PER_COLLECTION = 100;
// --- End Configuration ---

// Initialize Firestore
// Assumes Application Default Credentials (ADC) are set up.
// Run `gcloud auth application-default login` locally, or ensure
// the service account has 'Cloud Datastore User' role when deployed.
let db;
try {
    db = new Firestore();
    console.log('Firestore client initialized successfully.');
} catch (error) {
    console.error("Error initializing Firestore:", error);
    console.error("Ensure Application Default Credentials (ADC) are configured.");
    process.exit(1);
}

/**
 * Fetches recent reports from a specific collection.
 * @param {string} collectionName - The name of the Firestore collection.
 * @param {string} reportType - A string label for the report type (e.g., 'trivia', 'geo').
 * @param {number} limit - The maximum number of reports to fetch.
 * @returns {Promise<Array<object>>} A promise resolving to an array of report objects.
 */
async function fetchReports(collectionName, reportType, limit) {
    console.log(`Workspaceing up to ${limit} reports from ${collectionName}...`);
    const reports = [];
    try {
        const query = db.collection(collectionName)
            .where('flaggedAsProblem', '==', true)
            .orderBy('flaggedTimestamp', 'desc') // Order by when it was flagged
            .limit(limit);

        const snapshot = await query.get();

        if (!snapshot.empty) {
            snapshot.forEach(doc => {
                const data = doc.data();
                // Ensure timestamp exists and convert Firestore Timestamp to milliseconds for sorting
                const flaggedTimeMillis = data.flaggedTimestamp?.toMillis ? data.flaggedTimestamp.toMillis() : null;

                reports.push({
                    id: doc.id,
                    type: reportType,
                    reason: data.problemReason || 'N/A',
                    flaggedTimestampMillis: flaggedTimeMillis,
                    // Add other relevant fields based on type
                    ...(reportType === 'trivia' && { question: data.question, answer: data.answer }),
                    ...(reportType === 'geo' && { location: data.location, channel: data.channel }),
                    rawData: data // Include raw data if needed
                });
            });
        }
        console.log(`Workspaceed ${reports.length} reports from ${collectionName}.`);
    } catch (error) {
        console.error(`Error fetching reports from ${collectionName}:`, error);
        // Check for index errors specifically
        if (error.code === 5 && error.details?.includes('index')) {
             console.error(`\n Firestore index required for collection '${collectionName}'.`);
             console.error(` Please create a composite index on 'flaggedAsProblem' (ascending) and 'flaggedTimestamp' (descending).\n`);
        }
        // Continue even if one query fails, might return partial results
    }
    return reports;
}

/**
 * Main function to fetch, combine, sort, and print reports.
 */
async function getRecentReports() {
    console.log(`Workspaceing combined reports (limit ${TOTAL_REPORTS_LIMIT})...`);

    try {
        // Fetch reports from both collections concurrently
        const [triviaReports, geoReports] = await Promise.all([
            fetchReports(TRIVIA_COLLECTION, 'trivia', QUERY_LIMIT_PER_COLLECTION),
            fetchReports(GEO_HISTORY_COLLECTION, 'geo', QUERY_LIMIT_PER_COLLECTION)
        ]);

        // Combine results
        const allReports = [...triviaReports, ...geoReports];
        console.log(`Total reports fetched before sorting: ${allReports.length}`);

        // Sort combined results by flagged timestamp (most recent first)
        // Handle cases where timestamp might be null
        allReports.sort((a, b) => {
            const timeA = a.flaggedTimestampMillis || 0;
            const timeB = b.flaggedTimestampMillis || 0;
            return timeB - timeA; // Descending order
        });

        // Limit to the desired total number
        const finalReports = allReports.slice(0, TOTAL_REPORTS_LIMIT);

        console.log(`\n--- Top ${finalReports.length} Recent Reports ---`);
        if (finalReports.length === 0) {
            console.log("No reports found matching the criteria.");
        } else {
            // Output as JSON for easier parsing or viewing
            console.log(JSON.stringify(finalReports, null, 2));
            // Or print line by line:
            // finalReports.forEach((report, index) => {
            //     const date = report.flaggedTimestampMillis ? new Date(report.flaggedTimestampMillis).toISOString() : 'No Timestamp';
            //     const identifier = report.type === 'trivia' ? `Trivia Q: ${report.question?.substring(0, 30)}...` : `Geo Loc: ${report.location} (Channel: ${report.channel})`;
            //     console.log(`${index + 1}. [${report.type.toUpperCase()}] ${date} - Reason: ${report.reason} (${identifier})`);
            // });
        }
        console.log(`--- End of Reports ---`);

    } catch (error) {
        console.error("\nAn error occurred during the main report fetching process:", error);
    }
}

// Run the main function
getRecentReports();