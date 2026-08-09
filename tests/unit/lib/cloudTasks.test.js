// tests/unit/lib/cloudTasks.test.js
import {
    isCloudTasksEnabled,
    buildTaskId,
    scheduleTask,
    cancelTask,
    verifyTaskRequest,
    _reset,
} from '../../../src/lib/cloudTasks.js';

const mockCreateTask = jest.fn();
const mockDeleteTask = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock('../../../src/lib/logger.js');

// Read lazily through a getter: the mock factory is hoisted above any local
// const, so it cannot close over one directly.
jest.mock('../../../src/config/index.js', () => ({
    __esModule: true,
    default: {
        get cloudTasks() {
            return globalThis.__cloudTasksTestConfig || {};
        },
    },
}));

jest.mock('@google-cloud/tasks', () => ({
    CloudTasksClient: jest.fn().mockImplementation(() => ({
        createTask: mockCreateTask,
        deleteTask: mockDeleteTask,
        queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
        taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
    })),
}));

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: mockVerifyIdToken,
    })),
}));

const ENABLED_CONFIG = {
    projectId: 'streamsage-bot',
    location: 'us-central1',
    queue: 'scheduled-messages',
    targetUrl: 'https://chatsage.example.app/internal/scheduled-task',
    invokerServiceAccount: 'chatsage-tasks-invoker@streamsage-bot.iam.gserviceaccount.com',
};

describe('cloudTasks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        _reset();
        globalThis.__cloudTasksTestConfig = { ...ENABLED_CONFIG };
    });

    describe('isCloudTasksEnabled', () => {
        test('is false when targetUrl is unset (local dev)', () => {
            globalThis.__cloudTasksTestConfig = { ...ENABLED_CONFIG, targetUrl: null };
            expect(isCloudTasksEnabled()).toBe(false);
        });

        test('is false when the invoker service account is unset', () => {
            globalThis.__cloudTasksTestConfig = { ...ENABLED_CONFIG, invokerServiceAccount: null };
            expect(isCloudTasksEnabled()).toBe(false);
        });

        test('is true when fully configured', () => {
            expect(isCloudTasksEnabled()).toBe(true);
        });
    });

    describe('buildTaskId', () => {
        test('builds a deterministic id from kind, channel and timestamp', () => {
            expect(buildTaskId('ad', 'parfaitfair', 1754688532000)).toBe('ad-parfaitfair-1754688532000');
        });

        test('is stable across calls so duplicates collide', () => {
            expect(buildTaskId('ad', 'parfaitfair', 1)).toBe(buildTaskId('ad', 'parfaitfair', 1));
        });

        test('strips characters Cloud Tasks rejects in a task id', () => {
            expect(buildTaskId('ad', 'weird/name#1', 5)).toBe('ad-weird-name-1-5');
        });
    });

    describe('scheduleTask', () => {
        test('does not call the API when not configured', async () => {
            globalThis.__cloudTasksTestConfig = { ...ENABLED_CONFIG, targetUrl: null };
            const result = await scheduleTask({ taskId: 'ad-x-1', payload: {}, deliverAtMs: Date.now() });

            expect(result).toEqual({ scheduled: false, reason: 'not-configured' });
            expect(mockCreateTask).not.toHaveBeenCalled();
        });

        test('enqueues an OIDC-signed task at the requested time', async () => {
            mockCreateTask.mockResolvedValue([{}]);
            const deliverAtMs = 1754688532000;

            const result = await scheduleTask({
                taskId: 'ad-parfaitfair-1754688592000',
                payload: { kind: 'ad-notification', channelName: 'parfaitfair' },
                deliverAtMs,
            });

            expect(result).toEqual({ scheduled: true });
            const arg = mockCreateTask.mock.calls[0][0];
            expect(arg.task.name).toBe(
                'projects/streamsage-bot/locations/us-central1/queues/scheduled-messages/tasks/ad-parfaitfair-1754688592000'
            );
            expect(arg.task.scheduleTime).toEqual({ seconds: Math.floor(deliverAtMs / 1000) });
            expect(arg.task.httpRequest.url).toBe(ENABLED_CONFIG.targetUrl);
            expect(arg.task.httpRequest.oidcToken).toEqual({
                serviceAccountEmail: ENABLED_CONFIG.invokerServiceAccount,
                audience: ENABLED_CONFIG.targetUrl,
            });
            expect(JSON.parse(Buffer.from(arg.task.httpRequest.body, 'base64').toString('utf8')))
                .toEqual({ kind: 'ad-notification', channelName: 'parfaitfair' });
        });

        test('treats ALREADY_EXISTS as successful de-duplication, not an error', async () => {
            const err = new Error('already exists');
            err.code = 6;
            mockCreateTask.mockRejectedValue(err);

            const result = await scheduleTask({ taskId: 'ad-x-1', payload: {}, deliverAtMs: Date.now() });

            expect(result).toEqual({ scheduled: false, duplicate: true });
        });

        test('reports a real failure so the caller can retry later', async () => {
            mockCreateTask.mockRejectedValue(new Error('queue unavailable'));

            const result = await scheduleTask({ taskId: 'ad-x-1', payload: {}, deliverAtMs: Date.now() });

            expect(result.scheduled).toBe(false);
            expect(result.duplicate).toBeUndefined();
            expect(result.reason).toBe('queue unavailable');
        });
    });

    describe('cancelTask', () => {
        test('deletes a pending task by id', async () => {
            mockDeleteTask.mockResolvedValue([{}]);

            await expect(cancelTask('ad-parfaitfair-1')).resolves.toBe(true);
            expect(mockDeleteTask).toHaveBeenCalledWith({
                name: 'projects/streamsage-bot/locations/us-central1/queues/scheduled-messages/tasks/ad-parfaitfair-1',
            });
        });

        test('treats NOT_FOUND as a no-op rather than an error', async () => {
            const err = new Error('not found');
            err.code = 5;
            mockDeleteTask.mockRejectedValue(err);

            await expect(cancelTask('ad-parfaitfair-1')).resolves.toBe(false);
        });
    });

    describe('verifyTaskRequest', () => {
        test('rejects a request with no bearer token', async () => {
            const result = await verifyTaskRequest(undefined);
            expect(result).toEqual({ valid: false, reason: 'missing-bearer-token' });
        });

        test('accepts a token signed by the invoker service account', async () => {
            mockVerifyIdToken.mockResolvedValue({
                getPayload: () => ({
                    email: ENABLED_CONFIG.invokerServiceAccount,
                    email_verified: true,
                }),
            });

            const result = await verifyTaskRequest(`Bearer good-token`);

            expect(result.valid).toBe(true);
            expect(mockVerifyIdToken).toHaveBeenCalledWith({
                idToken: 'good-token',
                audience: ENABLED_CONFIG.targetUrl,
            });
        });

        test('rejects a valid Google token from a different service account', async () => {
            mockVerifyIdToken.mockResolvedValue({
                getPayload: () => ({ email: 'attacker@evil.iam.gserviceaccount.com', email_verified: true }),
            });

            const result = await verifyTaskRequest('Bearer other-token');

            expect(result).toEqual({ valid: false, reason: 'unexpected-service-account' });
        });

        test('rejects a token whose email is not verified', async () => {
            mockVerifyIdToken.mockResolvedValue({
                getPayload: () => ({ email: ENABLED_CONFIG.invokerServiceAccount, email_verified: false }),
            });

            const result = await verifyTaskRequest('Bearer unverified');

            expect(result).toEqual({ valid: false, reason: 'email-not-verified' });
        });

        test('rejects a token that fails signature or audience validation', async () => {
            mockVerifyIdToken.mockRejectedValue(new Error('Wrong recipient'));

            const result = await verifyTaskRequest('Bearer forged');

            expect(result).toEqual({ valid: false, reason: 'Wrong recipient' });
        });
    });
});
