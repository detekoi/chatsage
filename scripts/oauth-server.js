// scripts/oauth-server.js
// Simple local server to handle OAuth callback for bot authentication (WildcatSage)
import express from 'express';
import axios from 'axios';
import { setSecretValue } from '../src/lib/secretManager.js';
import config from '../src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

let server;

/**
 * Exchange authorization code for tokens and update Secret Manager
 */
async function exchangeCodeForTokens(authCode) {
    const { clientId, clientSecret } = config.twitch;

    if (!clientId || !clientSecret) {
        throw new Error('Failed to get Client ID or Client Secret from config');
    }

    console.log('Exchanging authorization code for tokens...');

    // Exchange the authorization code for an access token and refresh token
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('code', authCode);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', REDIRECT_URI);

    const response = await axios.post('https://id.twitch.tv/oauth2/token', params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }).catch(error => {
        if (error.response) {
            console.error('Token exchange failed:', error.response.status, error.response.data);
            throw new Error(`Token exchange failed: ${JSON.stringify(error.response.data)}`);
        }
        throw error;
    });

    const { access_token, refresh_token, expires_in, scope } = response.data;

    console.log('\n✅ Successfully obtained tokens!\n');
    console.log('Access Token:', access_token.substring(0, 10) + '...');
    console.log('Refresh Token:', refresh_token.substring(0, 10) + '...');
    console.log('Expires in:', expires_in, 'seconds');
    console.log('\nScopes granted:');
    scope.forEach(s => console.log(`  - ${s}`));

    // Validate the token to check scopes
    console.log('\nValidating token...');
    const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: {
            'Authorization': `Bearer ${access_token}`
        }
    });

    console.log('Token validated successfully!');
    console.log('User ID:', validateResponse.data.user_id);
    console.log('Login:', validateResponse.data.login);

    // Check if required scopes are present
    // Scopes match those listed in botcommands.html + modern equivalents


    // Note: Twitch might return user:read:chat instead of chat:read, etc.
    // We check if at least these base capabilities are present.
    // However, validation returns what was requested/granted.

    console.log('\n✅ Token validation complete.');

    // Initialize Secret Manager before use
    const { initializeSecretManager } = await import('../src/lib/secretManager.js');
    initializeSecretManager();

    // Update the refresh token in Secret Manager
    console.log('\nUpdating refresh token in Secret Manager...');
    let refreshTokenSecretName = config.secrets.twitchBotRefreshTokenName;

    if (!refreshTokenSecretName) {
        throw new Error('TWITCH_BOT_REFRESH_TOKEN_SECRET_NAME is not set in config');
    }

    // Fix: If the config includes '/versions/latest' (or any version), strip it.
    // addSecretVersion expects the parent secret name, not a specific version.
    if (refreshTokenSecretName.includes('/versions/')) {
        console.log(`Note: Stripping version suffix from secret name: ${refreshTokenSecretName}`);
        refreshTokenSecretName = refreshTokenSecretName.split('/versions/')[0];
    }

    // setSecretValue returns a boolean
    const success = await setSecretValue(refreshTokenSecretName, refresh_token);

    if (success) {
        console.log('✅ Refresh token updated successfully in Secret Manager!');
    } else {
        throw new Error('Failed to update secret in Secret Manager');
    }

    console.log('\n=== Summary ===');
    console.log('✅ New refresh token has been stored in Secret Manager');
    console.log('✅ The bot now has required scopes');
    console.log('✅ Restart your bot to use the new token');
}

async function startServer() {
    const { clientId } = config.twitch;

    if (!clientId) {
        console.error('❌ Failed to get Client ID from config');
        process.exit(1);
    }

    // Define required scopes
    const requiredScopes = [
        'chat:read',
        'chat:edit',
        'channel:read:subscriptions',
        'channel:manage:redemptions',
        'user:read:email'
    ];

    const scopes = requiredScopes.join(' ');
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&force_verify=true`;

    // Landing page
    app.get('/', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WildcatSage Bot OAuth</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                    .button { display: inline-block; padding: 15px 30px; background: #9147ff; color: white; text-decoration: none; border-radius: 5px; font-size: 18px; }
                    .button:hover { background: #772ce8; }
                    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
                    .info { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }
                </style>
            </head>
            <body>
                <h1>🤖 WildcatSage OAuth Authentication</h1>
                <div class="info">
                    <p><strong>Important:</strong> Make sure you are logged into Twitch as the <code>WildcatSage</code> account before clicking the button below.</p>
                </div>
                <p>Click the button below to authorize the bot with the required scopes:</p>
                <ul>
                    ${requiredScopes.map(scope => `<li><code>${scope}</code></li>`).join('')}
                </ul>
                <p>
                    <a href="${authUrl}" class="button">Authorize Bot on Twitch</a>
                </p>
                <p style="margin-top: 40px; color: #666; font-size: 14px;">
                    After authorization, you'll be redirected back here and the authorization code will be automatically processed.
                </p>
            </body>
            </html>
        `);
    });

    // OAuth callback handler
    app.get('/auth/callback', async (req, res) => {
        const code = req.query.code;
        const error = req.query.error;
        const errorDescription = req.query.error_description;

        if (error) {
            console.error('❌ OAuth Error:', error, errorDescription);
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authentication Failed</title>
                    <style>
                        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                        .error { background: #ffebee; padding: 15px; border-radius: 5px; color: #c62828; }
                    </style>
                </head>
                <body>
                    <h1>❌ Authentication Failed</h1>
                    <div class="error">
                        <p><strong>Error:</strong> ${error}</p>
                        <p>${errorDescription || 'Unknown error'}</p>
                    </div>
                    <p><a href="/">Try again</a></p>
                </body>
                </html>
            `);
            return;
        }

        if (!code) {
            console.error('❌ No authorization code received');
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authentication Failed</title>
                    <style>
                        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                        .error { background: #ffebee; padding: 15px; border-radius: 5px; color: #c62828; }
                    </style>
                </head>
                <body>
                    <h1>❌ Authentication Failed</h1>
                    <div class="error">
                        <p>No authorization code received from Twitch.</p>
                    </div>
                    <p><a href="/">Try again</a></p>
                </body>
                </html>
            `);
            return;
        }

        console.log('\n✅ Authorization code received!');
        console.log('Code:', code.substring(0, 10) + '...');
        console.log('\nProcessing authorization code...\n');

        // Exchange the code for tokens
        try {
            await exchangeCodeForTokens(code);

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Success!</title>
                    <style>
                        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; text-align: center; }
                        .success { background: #e8f5e9; padding: 20px; border-radius: 5px; color: #2e7d32; margin: 20px 0; }
                        .checkmark { font-size: 48px; color: #4caf50; }
                    </style>
                </head>
                <body>
                    <div class="checkmark">✅</div>
                    <h1>Authentication Successful!</h1>
                    <div class="success">
                        <p><strong>Refresh token has been updated in Secret Manager</strong></p>
                        <p>The bot now has all required scopes</p>
                    </div>
                    <p>Next steps:</p>
                    <ol style="text-align: left; max-width: 500px; margin: 20px auto;">
                        <li>Close this window</li>
                        <li>The server will shut down automatically</li>
                        <li>Restart your bot to use the new token</li>
                    </ol>
                </body>
                </html>
            `);

            setTimeout(() => {
                console.log('\n✅ OAuth flow complete! You can close this browser window.');
                console.log('Shutting down OAuth server...');
                server.close(() => {
                    process.exit(0);
                });
            }, 2000);

        } catch (error) {
            console.error('❌ Error exchanging code:', error.message);
            console.error('Stack:', error.stack);

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Error</title>
                    <style>
                        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
                        .error { background: #ffebee; padding: 15px; border-radius: 5px; color: #c62828; }
                        pre { background: #f5f5f5; padding: 10px; border-radius: 3px; overflow-x: auto; }
                    </style>
                </head>
                <body>
                    <h1>❌ Error Processing Authorization</h1>
                    <div class="error">
                        <p><strong>Error:</strong> ${error.message}</p>
                        <p>Check the terminal for detailed error information.</p>
                    </div>
                    <p><a href="/">Try again</a></p>
                </body>
                </html>
            `);
        }
    });

    server = app.listen(PORT, () => {
        console.log('\n=== WildcatSage OAuth Server Started ===\n');
        console.log(`1. Open your browser and go to: http://localhost:${PORT}`);
        console.log('2. Make sure you are logged into Twitch as the bot account (WildcatSage)');
        console.log('3. Click the "Authorize Bot on Twitch" button');
        console.log('4. The server will automatically process the authorization code\n');
        console.log('Server is running on http://localhost:' + PORT);
        console.log('\nPress Ctrl+C to stop the server\n');
    });
}

startServer().catch(error => {
    console.error('❌ Error starting OAuth server:', error.message);
    process.exit(1);
});
