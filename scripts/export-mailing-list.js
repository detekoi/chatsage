import { Firestore } from '@google-cloud/firestore';
import fs from 'fs';
import { fileURLToPath } from 'url';

const MANAGED_CHANNELS_COLLECTION = 'managedChannels';

async function main() {
    // Get project ID from args or env
    const args = process.argv.slice(2);
    let projectId = args[0] || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

    if (!projectId) {
        console.error('Error: No project ID specified.');
        console.error('Usage: node scripts/export-mailing-list.js [project-id]');
        console.error('Or set GOOGLE_CLOUD_PROJECT environment variable.');
        process.exit(1);
    }

    console.log(`[Exports] Initializing Firestore for project: ${projectId}`);

    try {
        const db = new Firestore({ projectId });

        console.log(`[Exports] Fetching documents from '${MANAGED_CHANNELS_COLLECTION}'...`);
        const snapshot = await db.collection(MANAGED_CHANNELS_COLLECTION).get();

        if (snapshot.empty) {
            console.log('[Exports] No documents found in collection.');
            return;
        }

        console.log(`[Exports] Processing ${snapshot.size} documents...`);

        const contacts = [];
        let missingEmailCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            const email = data.email;

            if (email && typeof email === 'string' && email.includes('@')) {
                contacts.push({
                    email: email.trim(),
                    channelName: data.channelName || doc.id,
                    displayName: data.displayName || data.channelName || doc.id,
                    isActive: !!data.isActive,
                    sourceProject: projectId
                });
            } else {
                missingEmailCount++;
            }
        });

        console.log(`[Exports] Found ${contacts.length} valid email addresses.`);
        if (missingEmailCount > 0) {
            console.log(`[Exports] Skipped ${missingEmailCount} documents with missing or invalid emails.`);
        }

        if (contacts.length === 0) {
            console.log('[Exports] No contacts to export.');
            return;
        }

        // Generate CSV content
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mailing_list_${projectId}_${timestamp}.csv`;

        const headers = ['Email', 'Channel Name', 'Display Name', 'Is Active', 'Source Project'];
        const csvContent = [
            headers.join(','),
            ...contacts.map(c => [
                `"${c.email.replace(/"/g, '""')}"`,
                `"${c.channelName.replace(/"/g, '""')}"`,
                `"${c.displayName.replace(/"/g, '""')}"`,
                c.isActive,
                c.sourceProject
            ].join(','))
        ].join('\n');

        fs.writeFileSync(filename, csvContent);
        console.log(`[Exports] Successfully exported to ${filename}`);

    } catch (error) {
        console.error('[Exports] Fatal error:', error);
        process.exit(1);
    }
}

main();
