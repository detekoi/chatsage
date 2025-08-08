#!/usr/bin/env node

/**
 * Script to trigger a stream.online EventSub notification to wake up the bot
 * 
 * Usage:
 *   node trigger-stream-online.js [broadcaster_name]
 * 
 * Examples:
 *   node trigger-stream-online.js streamername
 *   node trigger-stream-online.js anotherchannel
 *   TWITCH_EVENTSUB_SECRET=your_secret node trigger-stream-online.js
 */

import crypto from 'crypto';
import axios from 'axios';

// Your bot's deployment URL
const BOT_URL = 'https://chatsage-907887386166.us-central1.run.app';
const WEBHOOK_ENDPOINT = `${BOT_URL}/twitch/event`;

// You'll need to set this to your actual EventSub secret
const EVENTSUB_SECRET = process.env.TWITCH_EVENTSUB_SECRET || 'your_secret_here';

if (EVENTSUB_SECRET === 'your_secret_here') {
    console.error('❌ Please set TWITCH_EVENTSUB_SECRET environment variable');
    console.error('   You can find this in your Google Cloud Secret Manager or .env file');
    process.exit(1);
}

/**
 * Creates a mock stream.online EventSub notification
 */
function createStreamOnlineEvent(broadcasterUserName = 'testbroadcaster') {
    const messageId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    const event = {
        subscription: {
            id: crypto.randomUUID(),
            status: 'enabled',
            type: 'stream.online',
            version: '1',
            condition: {
                broadcaster_user_id: '123456789'
            },
            transport: {
                method: 'webhook',
                callback: WEBHOOK_ENDPOINT
            },
            created_at: timestamp
        },
        event: {
            id: crypto.randomUUID(),
            broadcaster_user_id: '123456789',
            broadcaster_user_login: broadcasterUserName.toLowerCase(),
            broadcaster_user_name: broadcasterUserName,
            type: 'live',
            started_at: timestamp
        }
    };
    
    return { event, messageId, timestamp };
}

/**
 * Creates the required EventSub signature
 */
function createEventSubSignature(messageId, timestamp, body, secret) {
    const message = messageId + timestamp + body;
    const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return `sha256=${signature}`;
}

/**
 * Sends the EventSub notification to the bot
 */
async function triggerStreamOnline(broadcasterUserName = 'testbroadcaster') {
    console.log(`🚀 Triggering stream.online event for ${broadcasterUserName}...`);
    
    const { event, messageId, timestamp } = createStreamOnlineEvent(broadcasterUserName);
    const body = JSON.stringify(event);
    const signature = createEventSubSignature(messageId, timestamp, body, EVENTSUB_SECRET);
    
    const headers = {
        'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
        'Twitch-Eventsub-Message-Type': 'notification',
        'Twitch-Eventsub-Subscription-Type': 'stream.online',
        'Twitch-Eventsub-Subscription-Version': '1'
    };
    
    try {
        console.log(`📡 Sending POST request to: ${WEBHOOK_ENDPOINT}`);
        console.log(`📋 Event details:`);
        console.log(`   - Broadcaster: ${broadcasterUserName}`);
        console.log(`   - Message ID: ${messageId}`);
        console.log(`   - Timestamp: ${timestamp}`);
        
        const response = await axios.post(WEBHOOK_ENDPOINT, body, { 
            headers,
            timeout: 30000 // 30 second timeout
        });
        
        console.log(`✅ Successfully triggered stream.online event!`);
        console.log(`   - Response status: ${response.status}`);
        console.log(`   - Response headers:`, response.headers);
        
        if (response.data) {
            console.log(`   - Response data:`, response.data);
        }
        
        console.log('');
        console.log('🎉 The bot should now be starting up on Google Cloud!');
        console.log('   You can check the logs in Google Cloud Console to verify.');
        
    } catch (error) {
        console.error('❌ Failed to trigger stream.online event:');
        
        if (error.response) {
            console.error(`   - Status: ${error.response.status}`);
            console.error(`   - Status Text: ${error.response.statusText}`);
            console.error(`   - Response Data:`, error.response.data);
        } else if (error.request) {
            console.error('   - No response received from server');
            console.error('   - This might mean the bot is scaled to zero and starting up');
        } else {
            console.error(`   - Error: ${error.message}`);
        }
        
        console.log('');
        console.log('💡 Even if this shows an error, the bot might still be starting up.');
        console.log('   Check Google Cloud Run logs to see if the bot received the event.');
    }
}

// Run the script
const broadcasterName = process.argv[2] || 'testbroadcaster';
triggerStreamOnline(broadcasterName).catch(console.error);