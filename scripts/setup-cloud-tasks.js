#!/usr/bin/env node

// scripts/setup-cloud-tasks.js
// One-time setup script to create the Cloud Tasks queue for keep-alive pings

import { ensureKeepAliveQueue } from '../src/lib/taskHelpers.js';
import logger from '../src/lib/logger.js';

async function main() {
    try {
        logger.info('Setting up Cloud Tasks queue for keep-alive pings...');
        
        if (!process.env.GOOGLE_CLOUD_PROJECT) {
            throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
        }
        
        await ensureKeepAliveQueue();
        
        logger.info('✅ Cloud Tasks queue setup completed successfully');
        logger.info('You can now deploy your application with EventSub and dynamic keep-alive support');
        
    } catch (error) {
        logger.error({ err: error }, '❌ Failed to set up Cloud Tasks queue');
        process.exit(1);
    }
}

main();