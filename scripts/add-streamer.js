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
 *   --tts             Add to ChatVibes TTS Bot (chatvibestts)
 *   --knowledge       Add to ChatSage Knowledge Bot (streamsage-bot)
 *   --both            Add to both bots (the default when neither is named)
 *   --active          Set isActive: true immediately. Without it a new channel
 *                     starts inactive and an existing one keeps its current
 *                     state, so re-running never switches a live bot off.
 *   --notes <text>    Custom notes. Omitting it leaves any existing note intact.
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

/**
 * Adds or refreshes a streamer's managedChannels document.
 *
 * `isActive` is the live "bot is running in this channel" flag, so an existing
 * value is never overwritten unless --active was passed explicitly. Re-running
 * this script to refresh a display name must not silently switch a streamer's
 * bot off. `notes` is preserved on the same principle.
 *
 * @param {string} projectId
 * @param {{id: string, login: string, displayName: string}} user
 * @param {boolean} [activate] - True only when --active was passed
 * @param {string} [notes] - Set only when --notes was passed
 */
async function addStreamerToProject(projectId, user, activate, notes) {
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
        isActive: activate === true ? true : (existingData.isActive === true),
        addedBy: existingData.addedBy || 'admin',
        addedAt: existingData.addedAt || FieldValue.serverTimestamp(),
        notes: notes ?? existingData.notes ?? 'Pre-approved by admin',
    };

    await docRef.set(data, { merge: true });
    return { projectId, docId: user.id, isNew: !existingSnap.exists, isActive: data.isActive };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0].startsWith('-')) {
        console.error('Usage: node scripts/add-streamer.js <username_or_user_id> [--tts | --knowledge | --both] [--active] [--notes "text"]');
        process.exit(1);
    }

    const target = args[0];
    const wantsTts = args.includes('--tts');
    const wantsKnowledge = args.includes('--knowledge');
    const activate = args.includes('--active') ? true : undefined;

    // A bare --notes with no value, or one followed by another flag, means the
    // operator supplied no text — fall through to the existing/default note
    // rather than storing "--active" as the note.
    const notesIdx = args.indexOf('--notes');
    const notesValue = notesIdx !== -1 ? args[notesIdx + 1] : undefined;
    const notes = notesValue && !notesValue.startsWith('-') ? notesValue : undefined;
    if (notesIdx !== -1 && notes === undefined) {
        console.error('❌ --notes requires a value, e.g. --notes "Partner tier"');
        process.exit(1);
    }

    const TTS = { name: 'TTS Bot (ChatVibes)', id: 'chatvibestts' };
    const KNOWLEDGE = { name: 'Knowledge Bot (ChatSage)', id: 'streamsage-bot' };

    // Selectors are additive, so --tts --knowledge targets both instead of
    // silently dropping the second one.
    const projects = [];
    if (wantsTts) projects.push(TTS);
    if (wantsKnowledge) projects.push(KNOWLEDGE);
    if (projects.length === 0) projects.push(TTS, KNOWLEDGE);

    console.log(`🔍 Resolving Twitch user for: ${target}...`);
    let user;
    try {
        user = await fetchTwitchUserInfo(target);
        console.log(`✅ Found Twitch user: ${user.displayName} (login: ${user.login}, ID: ${user.id})`);
    } catch (err) {
        console.error(`❌ Failed to resolve Twitch user: ${err.message}`);
        process.exit(1);
    }

    console.log(activate
        ? '\n📝 Adding to allow-lists and activating...'
        : '\n📝 Adding to allow-lists (existing activation state preserved)...');
    for (const proj of projects) {
        try {
            const result = await addStreamerToProject(proj.id, user, activate, notes);
            const status = result.isNew ? 'Created new doc' : 'Updated existing doc';
            console.log(`  ✅ [${proj.name}] (${proj.id}) -> ${status} [ID: ${result.docId}, isActive: ${result.isActive}]`);
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
