// scripts/get-user-token.js
// Runs a local OAuth Authorization Code flow to get a user access token + refresh token.
// Usage: node scripts/get-user-token.js
//
// 1. Opens your browser to Twitch login
// 2. After you authorize, Twitch redirects to localhost
// 3. This script exchanges the code for tokens and prints them

import axios from 'axios';
import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import escapeHtml from 'escape-html';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
// Ties the callback to the authorize URL this run printed (OAuth CSRF protection)
const OAUTH_STATE = crypto.randomBytes(16).toString('hex');

// Scopes the bot needs for EventSub chat + Helix API
const SCOPES = [
    // EventSub chat message subscriptions
    'user:bot',
    'user:read:chat',
    'user:write:chat',
    // Legacy IRC (kept for phased migration, can remove later)
    'chat:read',
    'chat:edit',
    // Moderation & followers
    'channel:moderate',
    'moderator:read:followers',
    // Announcements
    'moderator:manage:announcements',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Error: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env');
    process.exit(1);
}

console.log(`\nUsing Client ID: ${CLIENT_ID.substring(0, 6)}...`);
console.log(`Redirect URI: ${REDIRECT_URI}`);
console.log(`Scopes: ${SCOPES}`);
console.log('\n⚠️  IMPORTANT: Make sure this redirect URI is registered in your Twitch app!');
console.log(`   Go to: https://dev.twitch.tv/console/apps → your app → OAuth Redirect URLs`);
console.log(`   Add: ${REDIRECT_URI}\n`);

// Start local server to catch the callback
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    // Ignore callbacks that did not come from this run's authorize URL,
    // and keep waiting for the real one
    if (url.searchParams.get('state') !== OAUTH_STATE) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Invalid state parameter</h1>');
        return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Error: ${escapeHtml(error)}</h1><p>${escapeHtml(url.searchParams.get('error_description') || '')}</p>`);
        server.close();
        process.exit(1);
    }

    if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Missing authorization code</h1>');
        return;
    }

    try {
        // Exchange code for tokens
        // Credentials go in the form body, not the URL, so they stay out of request logs
        const tokenBody = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
        });
        const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', tokenBody.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const { access_token, refresh_token, expires_in, scope, token_type } = tokenRes.data;

        // Validate - get user info
        const userRes = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Client-ID': CLIENT_ID,
            },
        });

        const user = userRes.data.data[0];

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <h1>✅ Success!</h1>
            <p>Authorized as: <strong>${escapeHtml(user.display_name)}</strong> (${escapeHtml(user.login)})</p>
            <p>You can close this tab now.</p>
        `);

        console.log('\n✅ Success!');
        console.log(`   User: ${user.display_name} (${user.login})`);
        console.log(`   User ID: ${user.id}`);
        console.log(`   Token type: ${token_type}`);
        console.log(`   Scopes: ${JSON.stringify(scope)}`);
        console.log(`   Expires in: ${expires_in}s`);
        console.log('\n--- Tokens ---');
        console.log(`ACCESS_TOKEN=${access_token}`);
        console.log(`REFRESH_TOKEN=${refresh_token}`);
        console.log('--------------');
        console.log('\n📋 Update your .env with:');
        console.log(`   TWITCH_BOT_REFRESH_TOKEN=${refresh_token}`);
        console.log('\n📋 Update Secret Manager with:');
        console.log(`   printf '%s' '${refresh_token}' | gcloud secrets versions add TWITCH_BOT_REFRESH_TOKEN --data-file=- --project=streamsage-bot`);
        console.log('');

    } catch (err) {
        console.error('Token exchange failed:', err.response?.data || err.message);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Token exchange failed</h1><pre>${escapeHtml(JSON.stringify(err.response?.data, null, 2))}</pre>`);
    }

    server.close();
});

server.listen(PORT, () => {
    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('force_verify', 'true');
    authUrl.searchParams.set('state', OAUTH_STATE);

    console.log('🌐 Copy and paste this URL into a browser where you are logged in as the BOT account (WildcatSage):\n');
    console.log(authUrl.toString());
    console.log('\n⏳ Waiting for callback...\n');
});
