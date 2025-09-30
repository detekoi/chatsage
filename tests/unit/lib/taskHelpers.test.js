// tests/unit/lib/taskHelpers.test.js

jest.mock('@google-cloud/tasks');
jest.mock('../../../src/lib/logger.js');

import { CloudTasksClient } from '@google-cloud/tasks';
import * as taskHelpers from '../../../src/lib/taskHelpers.js';
import logger from '../../../src/lib/logger.js';

const {
    createKeepAliveTask,
    scheduleNextKeepAlivePing,
    deleteTask,
    ensureKeepAliveQueue
} = taskHelpers;

describe('taskHelpers', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock CloudTasksClient
        mockClient = {
            queuePath: jest.fn(),
            locationPath: jest.fn(),
            createTask: jest.fn(),
            deleteTask: jest.fn(),
            getQueue: jest.fn(),
            createQueue: jest.fn()
        };

        CloudTasksClient.mockImplementation(() => mockClient);

        // Mock process.env for tests
        process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
        process.env.PUBLIC_URL = 'https://test.example.com';
    });

    afterEach(() => {
        // Clean up process.env
        delete process.env.GOOGLE_CLOUD_PROJECT;
        delete process.env.PUBLIC_URL;
        delete process.env.GCP_REGION;
        delete process.env.KEEP_ALIVE_QUEUE;
    });

    describe('createKeepAliveTask', () => {
        beforeEach(() => {
            // Set default environment variables for tests
            process.env.GCP_REGION = 'us-central1';
            process.env.KEEP_ALIVE_QUEUE = 'test-queue';
        });

        it('should throw error when GOOGLE_CLOUD_PROJECT is missing', async () => {
            delete process.env.GOOGLE_CLOUD_PROJECT;

            await expect(createKeepAliveTask()).rejects.toThrow('GOOGLE_CLOUD_PROJECT environment variable is required');
        });

        it('should throw error when PUBLIC_URL is missing', async () => {
            delete process.env.PUBLIC_URL;

            await expect(createKeepAliveTask()).rejects.toThrow('PUBLIC_URL environment variable is required for keep-alive tasks');
        });

        it('should create keep-alive task successfully', async () => {
            const mockTask = {
                name: 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id'
            };

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockResolvedValue([mockTask]);

            const taskName = await createKeepAliveTask();

            expect(taskName).toBe(mockTask.name);
            expect(mockClient.queuePath).toHaveBeenCalledWith('test-project', 'us-central1', 'test-queue');
            expect(mockClient.createTask).toHaveBeenCalledWith({
                parent: 'projects/test-project/locations/us-central1/queues/test-queue',
                task: {
                    httpRequest: {
                        httpMethod: 'HEAD',
                        url: 'https://test.example.com/healthz',
                        oidcToken: {
                            serviceAccountEmail: 'test-project@appspot.gserviceaccount.com'
                        }
                    },
                    scheduleTime: {
                        seconds: expect.any(Number) // Should be current time + 30 seconds
                    },
                    dispatchDeadline: { seconds: 30 }
                }
            });
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({
                    project: 'test-project',
                    location: 'us-central1',
                    queue: 'test-queue',
                    url: 'https://test.example.com/healthz'
                }),
                'Creating keep-alive task'
            );
        });

        it('should handle task creation errors', async () => {
            const error = new Error('Queue not found');
            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockRejectedValue(error);

            await expect(createKeepAliveTask()).rejects.toThrow(error);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: error,
                    project: 'test-project',
                    location: 'us-central1',
                    queue: 'test-queue'
                }),
                'Failed to create keep-alive task'
            );
        });

        it('should validate queue path parameters', async () => {
            delete process.env.GCP_REGION;
            delete process.env.KEEP_ALIVE_QUEUE;

            await expect(createKeepAliveTask()).rejects.toThrow('Missing required parameters for queue path');
        });

        it('should use default values for optional environment variables', async () => {
            delete process.env.GCP_REGION;
            delete process.env.KEEP_ALIVE_QUEUE;

            // Set only required variables
            process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
            process.env.PUBLIC_URL = 'https://test.example.com';

            const error = new Error('Missing parameters');
            mockClient.queuePath.mockImplementation(() => {
                throw error;
            });

            await expect(createKeepAliveTask()).rejects.toThrow('Missing required parameters for queue path');
        });
    });

    describe('scheduleNextKeepAlivePing', () => {
        beforeEach(() => {
            process.env.GCP_REGION = 'us-central1';
            process.env.KEEP_ALIVE_QUEUE = 'test-queue';
        });

        it('should throw error when GOOGLE_CLOUD_PROJECT is missing', async () => {
            delete process.env.GOOGLE_CLOUD_PROJECT;

            await expect(scheduleNextKeepAlivePing()).rejects.toThrow('GOOGLE_CLOUD_PROJECT environment variable is required');
        });

        it('should throw error when PUBLIC_URL is missing', async () => {
            delete process.env.PUBLIC_URL;

            await expect(scheduleNextKeepAlivePing()).rejects.toThrow('PUBLIC_URL environment variable is required');
        });

        it('should schedule next ping with default delay', async () => {
            const mockTask = {
                name: 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id'
            };

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockResolvedValue([mockTask]);

            const taskName = await scheduleNextKeepAlivePing();

            expect(taskName).toBe(mockTask.name);
            expect(mockClient.createTask).toHaveBeenCalledWith({
                parent: 'projects/test-project/locations/us-central1/queues/test-queue',
                task: {
                    httpRequest: {
                        httpMethod: 'POST',
                        url: 'https://test.example.com/keep-alive',
                        oidcToken: {
                            serviceAccountEmail: 'test-project@appspot.gserviceaccount.com'
                        }
                    },
                    scheduleTime: {
                        seconds: expect.any(Number) // Should be current time + 240 seconds (default)
                    },
                    dispatchDeadline: { seconds: 30 }
                }
            });
        });

        it('should schedule next ping with custom delay', async () => {
            const mockTask = {
                name: 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id'
            };
            const customDelay = 120; // 2 minutes

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockResolvedValue([mockTask]);

            const taskName = await scheduleNextKeepAlivePing(customDelay);

            expect(taskName).toBe(mockTask.name);

            const callArgs = mockClient.createTask.mock.calls[0][0];
            expect(callArgs.task.scheduleTime.seconds).toBeGreaterThan(Date.now() / 1000 + customDelay - 5);
            expect(callArgs.task.scheduleTime.seconds).toBeLessThan(Date.now() / 1000 + customDelay + 5);
        });

        it('should retry on retryable errors with exponential backoff', async () => {
            const retryableError = new Error('Deadline exceeded');
            retryableError.code = 4; // DEADLINE_EXCEEDED

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');

            // Fail first two attempts, succeed on third
            mockClient.createTask
                .mockRejectedValueOnce(retryableError)
                .mockRejectedValueOnce(retryableError)
                .mockResolvedValue([{
                    name: 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id'
                }]);

            // Mock setTimeout to avoid actual delays in tests
            jest.useFakeTimers();

            const taskPromise = scheduleNextKeepAlivePing();

            // Fast-forward through retry delays
            jest.advanceTimersByTime(250); // First retry delay
            await Promise.resolve(); // Let promise resolve

            jest.advanceTimersByTime(500); // Second retry delay
            await Promise.resolve(); // Let promise resolve

            const taskName = await taskPromise;

            expect(taskName).toBeDefined();
            expect(mockClient.createTask).toHaveBeenCalledTimes(3);

            jest.useRealTimers();
        });

        it('should not retry on non-retryable errors', async () => {
            const nonRetryableError = new Error('Not found');
            nonRetryableError.code = 5; // NOT_FOUND

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockRejectedValue(nonRetryableError);

            await expect(scheduleNextKeepAlivePing()).rejects.toThrow(nonRetryableError);
            expect(mockClient.createTask).toHaveBeenCalledTimes(1); // Only one attempt
        });

        it('should give up after max attempts on retryable errors', async () => {
            const retryableError = new Error('Unavailable');
            retryableError.code = 14; // UNAVAILABLE

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.createTask.mockRejectedValue(retryableError);

            jest.useFakeTimers();

            await expect(scheduleNextKeepAlivePing()).rejects.toThrow(retryableError);
            expect(mockClient.createTask).toHaveBeenCalledTimes(4); // Max attempts

            jest.useRealTimers();
        });
    });

    describe('deleteTask', () => {
        it('should delete task successfully', async () => {
            const taskName = 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id';

            await deleteTask(taskName);

            expect(mockClient.deleteTask).toHaveBeenCalledWith({ name: taskName });
            expect(logger.info).toHaveBeenCalledWith({ taskName }, 'Keep-alive task deleted successfully');
        });

        it('should handle missing task name gracefully', async () => {
            await deleteTask('');

            expect(mockClient.deleteTask).not.toHaveBeenCalled();
        });

        it('should handle task deletion errors gracefully', async () => {
            const taskName = 'projects/test-project/locations/us-central1/queues/test-queue/tasks/test-task-id';
            const error = new Error('Task not found');

            mockClient.deleteTask.mockRejectedValue(error);

            await deleteTask(taskName);

            expect(logger.debug).toHaveBeenCalledWith(
                { err: error, taskName },
                'Failed to delete task (might already be gone)'
            );
        });
    });

    describe('ensureKeepAliveQueue', () => {
        beforeEach(() => {
            process.env.GCP_REGION = 'us-central1';
            process.env.KEEP_ALIVE_QUEUE = 'test-queue';
        });

        it('should create queue when it does not exist', async () => {
            const notFoundError = new Error('Not found');
            notFoundError.code = 5; // NOT_FOUND

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.getQueue.mockRejectedValue(notFoundError);
            mockClient.locationPath.mockReturnValue('projects/test-project/locations/us-central1');
            mockClient.createQueue.mockResolvedValue();

            await ensureKeepAliveQueue();

            expect(mockClient.getQueue).toHaveBeenCalledWith({
                name: 'projects/test-project/locations/us-central1/queues/test-queue'
            });
            expect(mockClient.createQueue).toHaveBeenCalledWith({
                parent: 'projects/test-project/locations/us-central1',
                queue: {
                    name: 'projects/test-project/locations/us-central1/queues/test-queue',
                    retryConfig: {
                        maxAttempts: 1
                    }
                }
            });
            expect(logger.info).toHaveBeenCalledWith(
                { queue: 'test-queue', location: 'us-central1' },
                'Keep-alive queue created successfully'
            );
        });

        it('should not create queue when it already exists', async () => {
            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.getQueue.mockResolvedValue({}); // Queue exists

            await ensureKeepAliveQueue();

            expect(mockClient.getQueue).toHaveBeenCalledWith({
                name: 'projects/test-project/locations/us-central1/queues/test-queue'
            });
            expect(mockClient.createQueue).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                { queue: 'test-queue', location: 'us-central1' },
                'Keep-alive queue already exists'
            );
        });

        it('should throw error for non-NOT_FOUND errors when getting queue', async () => {
            const error = new Error('Permission denied');
            error.code = 7; // PERMISSION_DENIED

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.getQueue.mockRejectedValue(error);

            await expect(ensureKeepAliveQueue()).rejects.toThrow(error);
            expect(mockClient.createQueue).not.toHaveBeenCalled();
        });

        it('should throw error when creating queue fails', async () => {
            const notFoundError = new Error('Not found');
            notFoundError.code = 5; // NOT_FOUND

            const createError = new Error('Failed to create queue');

            mockClient.queuePath.mockReturnValue('projects/test-project/locations/us-central1/queues/test-queue');
            mockClient.getQueue.mockRejectedValue(notFoundError);
            mockClient.locationPath.mockReturnValue('projects/test-project/locations/us-central1');
            mockClient.createQueue.mockRejectedValue(createError);

            await expect(ensureKeepAliveQueue()).rejects.toThrow(createError);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: createError,
                    queue: 'test-queue',
                    location: 'us-central1'
                }),
                'Failed to ensure keep-alive queue exists'
            );
        });
    });
});
