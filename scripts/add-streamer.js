#!/usr/bin/env node

/**
 * scripts/add-streamer.js
 * 
 * Helper CLI script to pre-approve / add a streamer to the managedChannels allow-lists
 * for ChatVibes (TTS Bot) and ChatSage (Knowledge Bot).
 *
 * Usage:
 *   node scripts/add-streamer.js <username_or_user_id> [options]
 *
 * Options:
 *   --tts             Add only to ChatVibes TTS Bot (chatvibestts)
 *   --knowledge       Add only to ChatSage Knowledge Bot (streamsage-bot)
 *   --both            Add to both bots (default)
 *   --active          Set isActive: true immediately (default is false, requiring dashboard activation)
 *   --notes <text>    Custom notes to include in document
 */

import { Firestore, FieldValue } from '@google-cloud/firestore';
import https from 'https';

function fetchTwitchUserInfo(usernameOrId) {
    return new Promise((resolve, reject) => {
        const isNumericId = /^\d+$/.test(usernameOrId);
        const url = isNumericId
            ? `https://api.ivr.fi/v2/twitch/user?id=${encodeURIComponent(usernameOrId)}`
            : `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(usernameOrId.toLowerCase())}`;

        const req = https.get(url, { headers: { 'User-Agent': 'Wildcat-Bot-Admin/1.0' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const user = Array.isArray(parsed) ? parsed[0] : parsed;
                    if (!user || user.error || !user.id) {
                        reject(new Error(`Twitch user not found for "${usernameOrId}"`));
                        return;
                    }
                    resolve({
                        id: String(user.id),
                        login: user.login.toLowerCase(),
                        displayName: user.displayName || user.login,
                    });
                } catch (e) {
                    reject(new Error(`Failed to parse Twitch API response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
    });
}

async function addStreamerToProject(projectId, user, isActive = false, notes = 'Pre-approved by admin') {
    const db = new Firestore({ projectId });
    const docRef = db.collection('managedChannels').doc(user.id);
    
    const existingSnap = await docRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() : {};

    const data = {
        channelName: user.login,
        twitchUserId: user.id,
        displayName: user.displayName,
        twitchDisplayName: user.displayName,
        twitchUserLogin: user.login,
        isActive: isActive,
        addedBy: existingData.addedBy || 'admin',
        addedAt: existingData.addedAt || FieldValue.serverTimestamp(),
        notes: notes,
    };

    await docRef.set(data, { merge: true });
    return { projectId, docId: user.id, isNew: !existingSnap.exists };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0].startsWith('-')) {
        console.error('Usage: node scripts/add-streamer.js <username_or_user_id> [--tts | --knowledge | --both] [--active] [--notes "text"]');
        process.exit(1);
    }

    const target = args[0];
    const onlyTts = args.includes('--tts');
    const onlyKnowledge = args.includes('--knowledge');
    const isActive = args.includes('--active');
    
    const notesIdx = args.indexOf('--notes');
    const notes = notesIdx !== -1 && args[notesIdx + 1] ? args[notesIdx + 1] : 'Pre-approved by admin';

    const projects = [];
    if (onlyTts) {
        projects.push({ name: 'TTS Bot (ChatVibes)', id: 'chatvibestts' });
    } else if (onlyKnowledge) {
        projects.push({ name: 'Knowledge Bot (ChatSage)', id: 'streamsage-bot' });
    } else {
        projects.push({ name: 'TTS Bot (ChatVibes)', id: 'chatvibestts' });
        projects.push({ name: 'Knowledge Bot (ChatSage)', id: 'streamsage-bot' });
    }

    console.log(`🔍 Resolving Twitch user for: ${target}...`);
    let user;
    try {
        user = await fetchTwitchUserInfo(target);
        console.log(`✅ Found Twitch user: ${user.displayName} (login: ${user.login}, ID: ${user.id})`);
    } catch (err) {
        console.error(`❌ Failed to resolve Twitch user: ${err.message}`);
        process.exit(1);
    }

    console.log(`\n📝 Adding to allow-lists (isActive: ${isActive})...`);
    for (const proj of projects) {
        try {
            const result = await addStreamerToProject(proj.id, user, isActive, notes);
            const status = result.isNew ? 'Created new doc' : 'Updated existing doc';
            console.log(`  ✅ [${proj.name}] (${proj.id}) -> ${status} [ID: ${result.docId}]`);
        } catch (err) {
            console.error(`  ❌ [${proj.name}] (${proj.id}) -> Error: ${err.message}`);
        }
    }

    console.log('\n🎉 Done! The streamer is pre-approved and can authorize via the web dashboard.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
