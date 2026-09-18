// tests/unit/components/memory/memoryExtractor.test.js

jest.mock('../../../../src/components/llm/llmClient.js', () => ({
    generateStructuredJson: jest.fn(),
}));

jest.mock('../../../../src/components/memory/memoryStorage.js', () => ({
    savePendingMessages: jest.fn().mockResolvedValue(),
    takePendingMessages: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../../src/components/memory/memoryManager.js', () => ({
    isMemoryEnabled: jest.fn().mockResolvedValue(true),
    onMemoryDisabled: jest.fn(),
    isUserOptedOut: jest.fn().mockResolvedValue(false),
    findRelatedMemories: jest.fn().mockResolvedValue([]),
    saveMemory: jest.fn().mockResolvedValue({ action: 'added' }),
    reviseAutoMemory: jest.fn().mockResolvedValue({ action: 'updated' }),
    reinforceMemory: jest.fn().mockResolvedValue({ action: 'reinforced' }),
    normalizeText: jest.requireActual('../../../../src/components/memory/memoryManager.js').normalizeText,
    sanitizeSubjects: jest.requireActual('../../../../src/components/memory/memoryManager.js').sanitizeSubjects,
}));

jest.mock('../../../../src/lib/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { generateStructuredJson } = require('../../../../src/components/llm/llmClient.js');
const storage = require('../../../../src/components/memory/memoryStorage.js');
const manager = require('../../../../src/components/memory/memoryManager.js');
const config = require('../../../../src/config/index.js').default;
const {
    captureMemories,
    stashUnextractedMessages,
    structureManualMemory,
    _resetExtractorState,
} = require('../../../../src/components/memory/memoryExtractor.js');

// Registered once at module load, so grab it before beforeEach clears the mock's call log.
const memoryDisabledListener = manager.onMemoryDisabled.mock.calls[0][0];

const BOT = String(config.twitch.username).toLowerCase();
let clock = 1000;
const line = (username, message) => ({ username, message, timestamp: new Date(clock++) });
const chat = (n, username = 'alice') => Array.from({ length: n }, (_, i) => line(username, `message number ${i}`));

beforeEach(() => {
    jest.clearAllMocks();
    _resetExtractorState();
    manager.isMemoryEnabled.mockResolvedValue(true);
    manager.isUserOptedOut.mockResolvedValue(false);
    manager.findRelatedMemories.mockResolvedValue([]);
    storage.takePendingMessages.mockResolvedValue([]);
    generateStructuredJson.mockResolvedValue({ operations: [] });
});

describe('captureMemories', () => {
    it('runs one flex-tier lite call and stores added lore', async () => {
        generateStructuredJson.mockResolvedValue({
            operations: [{ op: 'add', text: 'Ball knowledge means X here.', keys: ['ball knowledge'], subjects: [], kind: 'joke' }],
        });
        await captureMemories('Chan', chat(6));

        expect(generateStructuredJson).toHaveBeenCalledTimes(1);
        expect(generateStructuredJson).toHaveBeenCalledWith(expect.objectContaining({ model: 'lite', serviceTier: 'flex' }));
        expect(manager.saveMemory).toHaveBeenCalledWith('chan', expect.objectContaining({ keys: ['ball knowledge'], source: 'auto' }));
    });

    it('is a no-op when the model finds nothing worth keeping', async () => {
        await captureMemories('chan', chat(6));
        expect(manager.saveMemory).not.toHaveBeenCalled();
    });

    it('captures nothing when the channel opted out, and discards any stash left for it', async () => {
        manager.isMemoryEnabled.mockResolvedValue(false);
        const history = chat(10);
        await captureMemories('chan', history);
        await captureMemories('chan', history);
        expect(generateStructuredJson).not.toHaveBeenCalled();
        // Read-and-delete, once per process, so an orphaned stash cannot linger or be replayed.
        expect(storage.takePendingMessages).toHaveBeenCalledTimes(1);

        // Nothing was held in RAM while opted out either.
        await stashUnextractedMessages(new Map());
        expect(storage.savePendingMessages).not.toHaveBeenCalled();
    });

    it('filters out the bot, commands and opted-out users before calling the model', async () => {
        manager.isUserOptedOut.mockImplementation(async (channel, login) => login === 'ghost');
        const messages = [
            ...chat(5, 'alice'),
            line(BOT, 'i am the bot'),
            line('alice', '!quote add something'),
            line('ghost', 'please do not remember me'),
        ];
        await captureMemories('chan', messages);

        const prompt = generateStructuredJson.mock.calls[0][0].prompt;
        expect(prompt).toContain('alice: message number 0');
        expect(prompt).not.toContain('i am the bot');
        expect(prompt).not.toContain('!quote');
        expect(prompt).not.toContain('ghost');
    });

    it('holds a slice that is too small for a call instead of dropping it', async () => {
        await captureMemories('chan', chat(3));
        expect(generateStructuredJson).not.toHaveBeenCalled();

        // e.g. a quiet stream goes offline with 3 lines, then 3 more arrive next stream
        await captureMemories('chan', chat(3, 'bob'));
        expect(generateStructuredJson).toHaveBeenCalledTimes(1);
        const prompt = generateStructuredJson.mock.calls[0][0].prompt;
        expect(prompt).toContain('alice: message number 0');
        expect(prompt).toContain('bob: message number 2');
    });

    it('does not look up opt-outs for a backlog that is too small to extract anyway', async () => {
        await captureMemories('chan', chat(3));
        expect(manager.isUserOptedOut).not.toHaveBeenCalled();
    });

    it('drops waiting chat from RAM as soon as the channel turns memory off', async () => {
        await captureMemories('chan', chat(4, 'alice'));
        memoryDisabledListener('chan');

        // Had the 4 held lines survived, these 4 would make 8 and be stashed.
        await stashUnextractedMessages(new Map([['chan', { chatHistory: chat(4, 'bob') }]]));
        expect(storage.savePendingMessages).not.toHaveBeenCalled();
    });

    it('queues a slice that arrives while a call is in flight and extracts it afterwards', async () => {
        let releaseFirst;
        generateStructuredJson
            .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve({ operations: [] }); }))
            .mockResolvedValue({ operations: [] });

        const first = captureMemories('chan', chat(6, 'alice'));
        await new Promise(resolve => setImmediate(resolve));
        expect(generateStructuredJson).toHaveBeenCalledTimes(1);

        // contextManager evicts again while the first call is still running
        await captureMemories('chan', chat(6, 'bob'));
        expect(generateStructuredJson).toHaveBeenCalledTimes(1);

        releaseFirst();
        await first;
        expect(generateStructuredJson).toHaveBeenCalledTimes(2);
        expect(generateStructuredJson.mock.calls[1][0].prompt).toContain('bob: message number 5');
        expect(generateStructuredJson.mock.calls[1][0].prompt).not.toContain('alice:');
    });

    it('drops a batch whose extraction failed rather than retrying it', async () => {
        generateStructuredJson.mockRejectedValueOnce(new Error('boom'));
        await captureMemories('chan', chat(6, 'alice'));
        await captureMemories('chan', chat(6, 'bob'));
        expect(generateStructuredJson).toHaveBeenCalledTimes(2);
        expect(generateStructuredJson.mock.calls[1][0].prompt).not.toContain('alice:');
    });

    it('never looks at the same line twice', async () => {
        const first = chat(6);
        await captureMemories('chan', first);
        await captureMemories('chan', first);
        expect(generateStructuredJson).toHaveBeenCalledTimes(1);

        await captureMemories('chan', [...first, ...chat(6, 'bob')]);
        expect(generateStructuredJson).toHaveBeenCalledTimes(2);
        expect(generateStructuredJson.mock.calls[1][0].prompt).not.toContain('alice:');
    });

    it('only applies update/reinforce to ids it showed the model', async () => {
        manager.findRelatedMemories.mockResolvedValue([{ id: 'known', text: 'Gary is the duck.', keys: ['gary'] }]);
        generateStructuredJson.mockResolvedValue({
            operations: [
                { op: 'reinforce', id: 'known' },
                { op: 'update', id: 'known', text: 'Gary is the rubber duck.' },
                { op: 'update', id: 'invented', text: 'nope' },
            ],
        });
        await captureMemories('chan', chat(6));

        expect(generateStructuredJson.mock.calls[0][0].prompt).toContain('[known] Gary is the duck.');
        expect(manager.reinforceMemory).toHaveBeenCalledWith('chan', 'known');
        expect(manager.reviseAutoMemory).toHaveBeenCalledTimes(1);
        expect(manager.reviseAutoMemory).toHaveBeenCalledWith('chan', 'known', expect.objectContaining({ text: 'Gary is the rubber duck.' }));
    });

    it('caps how many memories one slice can add', async () => {
        generateStructuredJson.mockResolvedValue({
            operations: Array.from({ length: 6 }, (_, i) => ({ op: 'add', text: `lore ${i}`, keys: [`lore ${i}`] })),
        });
        await captureMemories('chan', chat(6));
        expect(manager.saveMemory).toHaveBeenCalledTimes(3);
    });

    it('picks up lines stashed by a previous process, once', async () => {
        storage.takePendingMessages.mockResolvedValueOnce(
            Array.from({ length: 5 }, (_, i) => ({ username: 'carol', message: `stashed ${i}`, ts: i + 1 }))
        );
        await captureMemories('chan', []);
        expect(generateStructuredJson.mock.calls[0][0].prompt).toContain('carol: stashed 0');

        await captureMemories('chan', chat(6));
        expect(storage.takePendingMessages).toHaveBeenCalledTimes(1);
    });

    it('never throws, even when the model call fails', async () => {
        generateStructuredJson.mockRejectedValue(new Error('boom'));
        await expect(captureMemories('chan', chat(6))).resolves.toBeUndefined();
    });
});

describe('stashUnextractedMessages', () => {
    it('stashes only channels with enough unextracted chat', async () => {
        const states = new Map([
            ['busy', { chatHistory: chat(9) }],
            ['quiet', { chatHistory: chat(2) }],
        ]);
        await stashUnextractedMessages(states);
        expect(storage.savePendingMessages).toHaveBeenCalledTimes(1);
        const [channel, lines] = storage.savePendingMessages.mock.calls[0];
        expect(channel).toBe('busy');
        expect(lines).toHaveLength(9);
        expect(lines[0]).toEqual({ username: 'alice', message: 'message number 0', ts: expect.any(Number) });
    });

    it('stashes lines that were handed over but are still waiting for a call', async () => {
        // Evicted from contextManager already, so the backlog is the only copy.
        await captureMemories('chan', chat(4, 'alice'));
        await stashUnextractedMessages(new Map([['chan', { chatHistory: chat(4, 'bob') }]]));

        const [channel, lines] = storage.savePendingMessages.mock.calls[0];
        expect(channel).toBe('chan');
        expect(lines.map(l => l.username)).toEqual([...Array(4).fill('alice'), ...Array(4).fill('bob')]);
    });

    it('hands stashed lines to the next process only, even if a call in flight finishes first', async () => {
        let releaseFirst;
        generateStructuredJson
            .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve({ operations: [] }); }))
            .mockResolvedValue({ operations: [] });

        const first = captureMemories('chan', chat(6, 'alice'));
        await new Promise(resolve => setImmediate(resolve));
        await captureMemories('chan', chat(8, 'bob')); // queued behind the running call

        await stashUnextractedMessages(new Map());
        expect(storage.savePendingMessages.mock.calls[0][1]).toHaveLength(8);

        // The running call completes before the process exits: it must not extract bob's lines too.
        releaseFirst();
        await first;
        expect(generateStructuredJson).toHaveBeenCalledTimes(1);
    });

    it('does not stash chat from a channel that turned memory off', async () => {
        manager.isMemoryEnabled.mockResolvedValue(false);
        await stashUnextractedMessages(new Map([['busy', { chatHistory: chat(9) }]]));
        expect(storage.savePendingMessages).not.toHaveBeenCalled();
    });

    it('leaves opted-out users out of the stash', async () => {
        manager.isUserOptedOut.mockImplementation(async (channel, login) => login === 'ghost');
        await stashUnextractedMessages(new Map([['busy', { chatHistory: [...chat(8), line('ghost', 'not me')] }]]));
        const [, lines] = storage.savePendingMessages.mock.calls[0];
        expect(lines).toHaveLength(8);
        expect(lines.some(l => l.username === 'ghost')).toBe(false);
    });

    it('does not read channel settings for idle channels at shutdown', async () => {
        await stashUnextractedMessages(new Map([['quiet', { chatHistory: chat(2) }]]));
        expect(manager.isMemoryEnabled).not.toHaveBeenCalled();
    });

    it('does not stash lines that were already extracted', async () => {
        const history = chat(9);
        await captureMemories('busy', history);
        await stashUnextractedMessages(new Map([['busy', { chatHistory: history }]]));
        expect(storage.savePendingMessages).not.toHaveBeenCalled();
    });
});

describe('structureManualMemory', () => {
    it('uses the model output when it is usable', async () => {
        generateStructuredJson.mockResolvedValue({ text: 'Gary is the rubber duck on the desk.', keys: ['gary'], subjects: [], kind: 'lore' });
        const result = await structureManualMemory('gary = the rubber duck on the desk');
        expect(result).toEqual({ text: 'Gary is the rubber duck on the desk.', keys: ['gary'], subjects: [], kind: 'lore' });
    });

    it('derives keys locally when the model is unavailable', async () => {
        generateStructuredJson.mockRejectedValue(new Error('down'));
        const result = await structureManualMemory('ball knowledge = knowing every pokeball, per @akg_1k');
        expect(result.keys).toEqual(['ball knowledge']);
        expect(result.subjects).toEqual(['akg_1k']);
        expect(result.text).toBe('ball knowledge = knowing every pokeball, per @akg_1k');
    });
});
