// scripts/get-app-token.js
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env file from the project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Go up one level from scripts to the project root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

/**
 * Fetches a Twitch App Access Token using Client Credentials.
 */
async function fetchToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error('Error: Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET in your environment variables or .env file.');
        console.error('Please ensure these are set correctly in the project root .env file.');
        process.exit(1); // Exit with error code
    }

    console.log('Attempting to fetch Twitch App Access Token...');
    console.log(`Using Client ID: ${clientId.substring(0, 4)}...`); // Log partial ID for confirmation

    try {
        const response = await axios.post(TWITCH_TOKEN_URL, null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials',
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000, // 10 second timeout
        });

        if (response.status === 200 && response.data && response.data.access_token) {
            const { access_token, expires_in, token_type } = response.data;
            const expiryDate = new Date(Date.now() + expires_in * 1000);

            console.log('\n--- Success! ---');
            console.log('App Access Token:', access_token);
            console.log('Token Type:', token_type);
            console.log('Expires In:', `${expires_in} seconds`);
            console.log('Approx. Expiry Date:', expiryDate.toISOString());
            console.log('----------------\n');
        } else {
            console.error('\n--- Error ---');
            console.error('Failed to fetch token. Unexpected response structure.');
            console.error('Status:', response.status);
            console.error('Data:', response.data);
            console.error('-------------\n');
            process.exit(1);
        }

    } catch (error) {
        console.error('\n--- Request Failed ---');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            if (error.response.status === 400 || error.response.status === 401 || error.response.status === 403) {
                 console.error('\nHint: Check if your TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are correct.');
            }
        } else if (error.request) {
            console.error('No response received from Twitch token endpoint. Check network connectivity.');
        } else {
            console.error('Error setting up request:', error.message);
        }
        console.error('--------------------\n');
        process.exit(1);
    }
}

// Execute the function when the script is run
fetchToken();