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
import open from 'open';
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

// Scopes the bot needs for IRC + chat
const SCOPES = [
    'chat:read',
    'chat:edit',
    'channel:moderate',
    'moderator:read:followers',
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
        const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI,
            },
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
            <p>Authorized as: <strong>${user.display_name}</strong> (${user.login})</p>
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
        console.log(`   gcloud secrets versions add TWITCH_BOT_REFRESH_TOKEN --data-file=- --project=streamsage-bot <<< "${refresh_token}"`);
        console.log('');

    } catch (err) {
        console.error('Token exchange failed:', err.response?.data || err.message);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Token exchange failed</h1><pre>${JSON.stringify(err.response?.data, null, 2)}</pre>`);
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

    console.log('🌐 Opening browser for Twitch authorization...');
    console.log(`   URL: ${authUrl.toString()}\n`);
    console.log('Log in with the BOT account (WildcatSage), not your broadcaster account.\n');

    open(authUrl.toString()).catch(() => {
        console.log('Could not open browser automatically. Please open the URL above manually.');
    });
});
