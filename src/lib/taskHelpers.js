// src/lib/taskHelpers.js
import { CloudTasksClient } from '@google-cloud/tasks';
import logger from './logger.js';

const client = new CloudTasksClient();

/**
 * Creates a Cloud Task that repeatedly pings the /healthz endpoint to keep the instance alive
 * @returns {Promise<string>} The task name for later deletion
 */
export async function createKeepAliveTask() {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GCP_REGION || 'us-central1';
    const queue = process.env.KEEP_ALIVE_QUEUE || 'self-ping';
    const url = process.env.PUBLIC_URL + '/healthz';
    
    if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
    }
    
    if (!process.env.PUBLIC_URL) {
        throw new Error('PUBLIC_URL environment variable is required for keep-alive tasks');
    }

    try {
        logger.info({ project, location, queue, url }, 'Creating keep-alive task');
        
        // Validate all path components before creating the queue path
        if (!project || !location || !queue) {
            throw new Error(`Missing required parameters for queue path: project=${project}, location=${location}, queue=${queue}`);
        }
        
        const queuePath = client.queuePath(project, location, queue);
        logger.info({ queuePath }, 'Generated queue path');
        
        const [task] = await client.createTask({
            parent: queuePath,
            task: {
                httpRequest: {
                    httpMethod: 'HEAD',
                    url,
                    oidcToken: { 
                        serviceAccountEmail: `${project}@appspot.gserviceaccount.com` 
                    }
                },
                scheduleTime: { 
                    seconds: Math.floor(Date.now() / 1000) + 30 // first ping in 30 seconds
                },
                dispatchDeadline: { seconds: 10 }
            }
        });

        logger.info({ taskName: task.name }, 'Keep-alive task created successfully');
        return task.name;
        
    } catch (error) {
        logger.error({ err: error, project, location, queue }, 'Failed to create keep-alive task');
        throw error;
    }
}

/**
 * Schedules the next keep-alive ping
 * @param {number} delaySeconds - Seconds to wait before next ping (default 240 = 4 minutes)
 * @returns {Promise<string>} The task name
 */
export async function scheduleNextKeepAlivePing(delaySeconds = 240) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GCP_REGION || 'us-central1';
    const queue = process.env.KEEP_ALIVE_QUEUE || 'self-ping';
    const url = process.env.PUBLIC_URL + '/keep-alive';
    
    // Validate all required parameters
    if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
    }
    if (!process.env.PUBLIC_URL) {
        throw new Error('PUBLIC_URL environment variable is required');
    }
    if (!project || !location || !queue) {
        throw new Error(`Missing required parameters for queue path: project=${project}, location=${location}, queue=${queue}`);
    }
    
    try {
        logger.debug({ project, location, queue, url, delaySeconds }, 'Scheduling next keep-alive ping');
        
        const queuePath = client.queuePath(project, location, queue);
        logger.debug({ queuePath }, 'Generated queue path for next ping');
        
        const [task] = await client.createTask({
            parent: queuePath,
            task: {
                httpRequest: {
                    httpMethod: 'POST',
                    url,
                    oidcToken: { 
                        serviceAccountEmail: `${project}@appspot.gserviceaccount.com` 
                    }
                },
                scheduleTime: { 
                    seconds: Math.floor(Date.now() / 1000) + delaySeconds
                },
                dispatchDeadline: { seconds: 10 }
            }
        });

        logger.debug({ taskName: task.name, delaySeconds }, 'Next keep-alive ping scheduled');
        return task.name;
        
    } catch (error) {
        logger.error({ err: error, delaySeconds }, 'Failed to schedule next keep-alive ping');
        throw error;
    }
}

/**
 * Deletes a Cloud Task
 * @param {string} taskName - The full task name to delete
 * @returns {Promise<void>}
 */
export async function deleteTask(taskName) {
    if (!taskName) return;
    
    try {
        await client.deleteTask({ name: taskName });
        logger.info({ taskName }, 'Keep-alive task deleted successfully');
    } catch (error) {
        // Task might already be deleted or executed, which is fine
        logger.debug({ err: error, taskName }, 'Failed to delete task (might already be gone)');
    }
}

/**
 * Creates the Cloud Tasks queue if it doesn't exist
 * This should be called during deployment setup
 */
export async function ensureKeepAliveQueue() {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GCP_REGION || 'us-central1';
    const queue = process.env.KEEP_ALIVE_QUEUE || 'self-ping';
    
    try {
        const queuePath = client.queuePath(project, location, queue);
        
        // Try to get the queue first
        try {
            await client.getQueue({ name: queuePath });
            logger.info({ queue, location }, 'Keep-alive queue already exists');
            return;
        } catch (error) {
            if (error.code !== 5) { // NOT_FOUND
                throw error;
            }
        }
        
        // Queue doesn't exist, create it
        await client.createQueue({
            parent: client.locationPath(project, location),
            queue: {
                name: queuePath,
                retryConfig: {
                    maxAttempts: 1 // Don't retry failed keep-alive pings
                }
            }
        });
        
        logger.info({ queue, location }, 'Keep-alive queue created successfully');
        
    } catch (error) {
        logger.error({ err: error, queue, location }, 'Failed to ensure keep-alive queue exists');
        throw error;
    }
}