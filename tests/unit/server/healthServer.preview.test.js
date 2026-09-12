// tests/unit/server/healthServer.preview.test.js
// Covers the dashboard preview endpoint: auth, validation, and success/failure shapes.

jest.mock('../../../src/lib/logger.js');
jest.mock('../../../src/components/twitch/eventsub.js', () => ({ eventSubHandler: jest.fn() }));
jest.mock('../../../src/lib/cloudTasks.js', () => ({ verifyTaskRequest: jest.fn() }));
jest.mock('../../../src/components/twitch/adSchedulePoller.js', () => ({ handleAdNotificationTask: jest.fn() }));
jest.mock('../../../src/lib/secretManager.js', () => ({
    getSecretManagerStatus: jest.fn(() => ({ initialized: true, mode: 'mock' })),
    getSecretValue: jest.fn(),
}));
// The real validator is covered in previewService.test.js; here it is a stub
// that only enforces `kind`, enough to prove the route wires validation in.
jest.mock('../../../src/components/customCommands/previewService.js', () => ({
    generatePreview: jest.fn(),
    validatePreviewRequest: jest.fn((body) =>
        ['command', 'timer', 'checkin'].includes(body?.kind) ? null : 'kind must be one of: command, timer, checkin.'),
}));

import { createHealthServer, closeHealthServer } from '../../../src/server/healthServer.js';
import { getSecretValue } from '../../../src/lib/secretManager.js';
import { generatePreview } from '../../../src/components/customCommands/previewService.js';
import config from '../../../src/config/index.js';

const TOKEN = 'shared-secret-value';

describe('POST /internal/preview', () => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        server = await createHealthServer({ port: 0, isDev: false, getIsFullyInitialized: () => true });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await closeHealthServer(server);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // env.setup.js seeds WEBUI_INTERNAL_TOKEN; the 503 test below clears it.
        config.webui.internalToken = 'projects/p/secrets/webui-token/versions/latest';
        getSecretValue.mockResolvedValue(TOKEN);
        generatePreview.mockResolvedValue({ kind: 'command', resolvedPrompt: 'Hi chan', response: 'Hello!', language: null });
    });

    const post = (body, token = TOKEN, raw = false) => fetch(`${baseUrl}/internal/preview`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: raw ? body : JSON.stringify(body),
    });

    const validBody = { channel: 'testchannel', kind: 'command', prompt: 'Say hi to $(user)', name: 'hello' };

    test('returns the preview on success', async () => {
        const res = await post({ ...validBody, args: 'foo' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ success: true, preview: { kind: 'command', resolvedPrompt: 'Hi chan', response: 'Hello!', language: null } });
        expect(generatePreview).toHaveBeenCalledWith({ channel: 'testchannel', kind: 'command', prompt: 'Say hi to $(user)', name: 'hello', args: 'foo' });
    });

    test('rejects a missing token with 401', async () => {
        const res = await post(validBody, null);
        expect(res.status).toBe(401);
        expect(generatePreview).not.toHaveBeenCalled();
    });

    test('rejects a wrong token with 401', async () => {
        const res = await post(validBody, 'nope');
        expect(res.status).toBe(401);
        expect(generatePreview).not.toHaveBeenCalled();
    });

    test('returns 503 when the internal token is not configured', async () => {
        config.webui.internalToken = null;
        const res = await post(validBody);
        expect(res.status).toBe(503);
        expect(getSecretValue).not.toHaveBeenCalled();
    });

    test('returns 503 when the secret cannot be read', async () => {
        getSecretValue.mockResolvedValue(null);
        const res = await post(validBody);
        expect(res.status).toBe(503);
    });

    test('rejects malformed JSON with 400', async () => {
        const res = await post('{not json', TOKEN, true);
        expect(res.status).toBe(400);
    });

    test('rejects an invalid body with 400 and a reason', async () => {
        const res = await post({ ...validBody, kind: 'persona' });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.success).toBe(false);
        expect(data.message).toMatch(/kind/);
        expect(generatePreview).not.toHaveBeenCalled();
    });

    test('returns 500 when generation throws', async () => {
        generatePreview.mockRejectedValue(new Error('boom'));
        const res = await post(validBody);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data).toEqual({ success: false, message: 'Failed to generate preview' });
    });

    test('other internal paths still 404', async () => {
        const res = await fetch(`${baseUrl}/internal/nope`, { method: 'POST' });
        expect(res.status).toBe(404);
    });
});
