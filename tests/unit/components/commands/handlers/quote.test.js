// tests/unit/components/commands/handlers/quote.test.js
// Mock dependencies before imports to avoid hoisting issues
jest.mock('../../../../../src/components/quotes/quoteStorage.js');
jest.mock('../../../../../src/lib/logger.js');
jest.mock('../../../../../src/lib/ircSender.js');

import quoteHandler from '../../../../../src/components/commands/handlers/quote.js';
import {
    addQuote,
    getQuoteById,
    getRandomQuote,
    getLastQuote,
    searchQuotes,
    deleteQuote,
    editQuote
} from '../../../../../src/components/quotes/quoteStorage.js';
import { enqueueMessage } from '../../../../../src/lib/ircSender.js';

describe('Quote Command Handler', () => {
    const createMockContext = (args = [], channel = '#testchannel', user = { username: 'testuser', 'display-name': 'TestUser', id: '123' }) => ({
        channel,
        user,
        args,
        message: `!quote ${args.join(' ')}`,
        ircClient: {},
        contextManager: {},
        logger: {}
    });

    beforeEach(() => {
        // Clear all mocks
        addQuote.mockClear();
        getQuoteById.mockClear();
        getRandomQuote.mockClear();
        getLastQuote.mockClear();
        searchQuotes.mockClear();
        deleteQuote.mockClear();
        editQuote.mockClear();
        enqueueMessage.mockClear();
    });

    describe('Command Info', () => {
        test('should have correct command metadata', () => {
            expect(quoteHandler.name).toBe('quote');
            expect(quoteHandler.description).toContain('Add, view, or search quotes');
            expect(quoteHandler.permission).toBe('everyone');
        });
    });

    describe('Random Quote (!quote)', () => {
        test('should return a random quote when no args provided', async () => {
            const mockQuote = {
                quoteId: 1,
                text: 'Hello world',
                saidBy: 'testuser'
            };
            getRandomQuote.mockResolvedValue(mockQuote);

            const context = createMockContext([]);
            await quoteHandler.execute(context);

            expect(getRandomQuote).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#1] "Hello world" — testuser',
                { replyToId: '123' }
            );
        });

        test('should handle quote without author', async () => {
            const mockQuote = {
                quoteId: 2,
                text: 'Just a quote',
                saidBy: null
            };
            getRandomQuote.mockResolvedValue(mockQuote);

            const context = createMockContext([]);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#2] "Just a quote"',
                { replyToId: '123' }
            );
        });

        test('should show message when no quotes exist', async () => {
            getRandomQuote.mockResolvedValue(null);

            const context = createMockContext([]);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'No quotes yet. Add one with "!quote add <text [- author]>"',
                { replyToId: '123' }
            );
        });
    });

    describe('Get Quote by ID (!quote <id>)', () => {
        test('should return quote by ID', async () => {
            const mockQuote = {
                quoteId: 5,
                text: 'Test quote',
                saidBy: 'author'
            };
            getQuoteById.mockResolvedValue(mockQuote);

            const context = createMockContext(['5']);
            await quoteHandler.execute(context);

            expect(getQuoteById).toHaveBeenCalledWith('testchannel', 5);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#5] "Test quote" — author',
                { replyToId: '123' }
            );
        });

        test('should handle quote not found', async () => {
            getQuoteById.mockResolvedValue(null);

            const context = createMockContext(['999']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Quote #999 not found.',
                { replyToId: '123' }
            );
        });
    });

    describe('Last Quote (!quote last)', () => {
        test('should return the last quote', async () => {
            const mockQuote = {
                quoteId: 10,
                text: 'Most recent quote',
                saidBy: 'recentuser'
            };
            getLastQuote.mockResolvedValue(mockQuote);

            const context = createMockContext(['last']);
            await quoteHandler.execute(context);

            expect(getLastQuote).toHaveBeenCalledWith('testchannel');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#10] "Most recent quote" — recentuser',
                { replyToId: '123' }
            );
        });

        test('should handle no quotes', async () => {
            getLastQuote.mockResolvedValue(null);

            const context = createMockContext(['last']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'No quotes yet.',
                { replyToId: '123' }
            );
        });
    });

    describe('Search Quotes (!quote search <term>)', () => {
        test('should search and return first matching quote', async () => {
            const mockResults = [{
                quoteId: 3,
                text: 'Found quote',
                saidBy: 'founduser'
            }];
            searchQuotes.mockResolvedValue(mockResults);

            const context = createMockContext(['search', 'found']);
            await quoteHandler.execute(context);

            expect(searchQuotes).toHaveBeenCalledWith('testchannel', 'found');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#3] "Found quote" — founduser',
                { replyToId: '123' }
            );
        });

        test('should handle search with no term', async () => {
            const context = createMockContext(['search']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote search <term>',
                { replyToId: '123' }
            );
            expect(searchQuotes).not.toHaveBeenCalled();
        });

        test('should handle no search results', async () => {
            searchQuotes.mockResolvedValue([]);

            const context = createMockContext(['search', 'nonexistent']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'No quotes matching "nonexistent".',
                { replyToId: '123' }
            );
        });

        test('should handle implicit search (!quote <term>)', async () => {
            const mockResults = [{
                quoteId: 7,
                text: 'Implicit search result',
                saidBy: null
            }];
            searchQuotes.mockResolvedValue(mockResults);

            const context = createMockContext(['implicit']);
            await quoteHandler.execute(context);

            expect(searchQuotes).toHaveBeenCalledWith('testchannel', 'implicit');
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                '[#7] "Implicit search result"',
                { replyToId: '123' }
            );
        });

        test('should handle multi-word implicit search', async () => {
            const mockResults = [{
                quoteId: 8,
                text: 'Multi word search',
                saidBy: 'user'
            }];
            searchQuotes.mockResolvedValue(mockResults);

            const context = createMockContext(['multi', 'word', 'search']);
            await quoteHandler.execute(context);

            expect(searchQuotes).toHaveBeenCalledWith('testchannel', 'multi word search');
        });
    });

    describe('Add Quote (!quote add <text>)', () => {
        test('should add a quote without author', async () => {
            addQuote.mockResolvedValue({ quoteId: 1 });

            const context = createMockContext(['add', 'This is a test quote']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'This is a test quote',
                null,
                'TestUser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Added quote #1: "This is a test quote"',
                { replyToId: '123' }
            );
        });

        test('should add a quote with author (space around dash)', async () => {
            addQuote.mockResolvedValue({ quoteId: 2 });

            const context = createMockContext(['add', 'Quote text - author']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text',
                'author',
                'TestUser'
            );
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Added quote #2: "Quote text" — author',
                { replyToId: '123' }
            );
        });

        test('should add a quote with author (no space before dash)', async () => {
            addQuote.mockResolvedValue({ quoteId: 3 });

            const context = createMockContext(['add', 'Quote text-author']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text',
                'author',
                'TestUser'
            );
        });

        test('should add a quote with author (no space after dash)', async () => {
            addQuote.mockResolvedValue({ quoteId: 4 });

            const context = createMockContext(['add', 'Quote text- author']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text',
                'author',
                'TestUser'
            );
        });

        test('should handle en-dash and em-dash', async () => {
            addQuote.mockResolvedValue({ quoteId: 5 });

            const context = createMockContext(['add', 'Quote text – author']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text',
                'author',
                'TestUser'
            );
        });

        test('should use last dash when multiple dashes exist', async () => {
            addQuote.mockResolvedValue({ quoteId: 6 });

            const context = createMockContext(['add', 'Quote - with - multiple - dashes - finalauthor']);
            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote - with - multiple - dashes',
                'finalauthor',
                'TestUser'
            );
        });

        test('should handle quote with quotes around it', async () => {
            addQuote.mockResolvedValue({ quoteId: 7 });

            const context = createMockContext(['add', '"Quoted text" - author']);
            await quoteHandler.execute(context);

            // Note: The parser removes quotes from start/end, but the dash parsing happens after
            // So "Quoted text" - author becomes: text="Quoted text", author="author"
            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quoted text',
                'author',
                'TestUser'
            );
        });

        test('should handle empty add command', async () => {
            const context = createMockContext(['add']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote add <text [- author]>',
                { replyToId: '123' }
            );
            expect(addQuote).not.toHaveBeenCalled();
        });

        test('should reject quotes that are too long', async () => {
            const longQuote = 'a'.repeat(501);
            const context = createMockContext(['add', longQuote]);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Quote too long (max 500 chars).',
                { replyToId: '123' }
            );
            expect(addQuote).not.toHaveBeenCalled();
        });

        test('should handle quote with trailing dash but no author', async () => {
            addQuote.mockResolvedValue({ quoteId: 8 });

            const context = createMockContext(['add', 'Quote text -']);
            await quoteHandler.execute(context);

            // If dash has no content after it, treat it as part of the quote text
            // (e.g., kaomoji or intentional dash usage)
            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text -',
                null,
                'TestUser'
            );
        });

        test('should handle quote with trailing em-dash but no author', async () => {
            addQuote.mockResolvedValue({ quoteId: 9 });

            const context = createMockContext(['add', 'Quote text —']);
            await quoteHandler.execute(context);

            // Em-dash with no author should be kept as part of quote
            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text —',
                null,
                'TestUser'
            );
        });

        test('should handle quote with dash and spaces but no author', async () => {
            addQuote.mockResolvedValue({ quoteId: 10 });

            const context = createMockContext(['add', 'Quote text -   ']);
            await quoteHandler.execute(context);

            // Only spaces/dashes after the dash means no author - keep dash in quote
            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Quote text -',
                null,
                'TestUser'
            );
        });

        test('should use username if display-name not available', async () => {
            addQuote.mockResolvedValue({ quoteId: 8 });
            const context = createMockContext(['add', 'Test quote'], '#testchannel', {
                username: 'testuser',
                id: '123'
            });

            await quoteHandler.execute(context);

            expect(addQuote).toHaveBeenCalledWith(
                'testchannel',
                'Test quote',
                null,
                'testuser'
            );
        });
    });

    describe('Delete Quote (!quote delete <id>)', () => {
        test('should delete quote as moderator', async () => {
            deleteQuote.mockResolvedValue(true);
            const context = createMockContext(['delete', '5'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(deleteQuote).toHaveBeenCalledWith('testchannel', 5);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Deleted quote #5.',
                { replyToId: '123' }
            );
        });

        test('should delete quote as broadcaster', async () => {
            deleteQuote.mockResolvedValue(true);
            const context = createMockContext(['delete', '3'], '#testchannel', {
                username: 'testchannel',
                'display-name': 'TestChannel',
                id: '123',
                badges: { broadcaster: '1' }
            });

            await quoteHandler.execute(context);

            expect(deleteQuote).toHaveBeenCalledWith('testchannel', 3);
        });

        test('should reject delete from non-privileged user', async () => {
            const context = createMockContext(['delete', '5'], '#testchannel', {
                username: 'regularuser',
                'display-name': 'RegularUser',
                id: '123'
            });

            await quoteHandler.execute(context);

            expect(deleteQuote).not.toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods/broadcaster can delete quotes.',
                { replyToId: '123' }
            );
        });

        test('should handle delete with invalid ID', async () => {
            const context = createMockContext(['delete', 'invalid'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote delete <id>',
                { replyToId: '123' }
            );
            expect(deleteQuote).not.toHaveBeenCalled();
        });

        test('should handle quote not found on delete', async () => {
            deleteQuote.mockResolvedValue(false);
            const context = createMockContext(['delete', '999'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Quote #999 not found.',
                { replyToId: '123' }
            );
        });

        test('should handle delete aliases (remove, del)', async () => {
            deleteQuote.mockResolvedValue(true);
            const context = createMockContext(['remove', '5'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(deleteQuote).toHaveBeenCalledWith('testchannel', 5);
        });
    });

    describe('Edit Quote (!quote edit <id> <text>)', () => {
        test('should edit quote as moderator', async () => {
            editQuote.mockResolvedValue(true);
            const context = createMockContext(['edit', '5', 'Updated quote text'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(editQuote).toHaveBeenCalledWith('testchannel', 5, 'Updated quote text', null);
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Updated quote #5.',
                { replyToId: '123' }
            );
        });

        test('should edit quote with author', async () => {
            editQuote.mockResolvedValue(true);
            const context = createMockContext(['edit', '5', 'Updated text - newauthor'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(editQuote).toHaveBeenCalledWith('testchannel', 5, 'Updated text', 'newauthor');
        });

        test('should reject edit from non-privileged user', async () => {
            const context = createMockContext(['edit', '5', 'New text'], '#testchannel', {
                username: 'regularuser',
                'display-name': 'RegularUser',
                id: '123'
            });

            await quoteHandler.execute(context);

            expect(editQuote).not.toHaveBeenCalled();
            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Only mods/broadcaster can edit quotes.',
                { replyToId: '123' }
            );
        });

        test('should handle edit with invalid ID', async () => {
            const context = createMockContext(['edit', 'invalid', 'Text'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote edit <id> <text [- author]>',
                { replyToId: '123' }
            );
            expect(editQuote).not.toHaveBeenCalled();
        });

        test('should handle edit with no text', async () => {
            const context = createMockContext(['edit', '5'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote edit <id> <text [- author]>',
                { replyToId: '123' }
            );
        });

        test('should reject edit with quote too long', async () => {
            const longQuote = 'a'.repeat(501);
            const context = createMockContext(['edit', '5', longQuote], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Quote too long (max 500 chars).',
                { replyToId: '123' }
            );
            expect(editQuote).not.toHaveBeenCalled();
        });

        test('should handle quote not found on edit', async () => {
            editQuote.mockResolvedValue(false);
            const context = createMockContext(['edit', '999', 'New text'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Quote #999 not found.',
                { replyToId: '123' }
            );
        });

        test('should handle update alias', async () => {
            editQuote.mockResolvedValue(true);
            const context = createMockContext(['update', '5', 'Updated text'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });

            await quoteHandler.execute(context);

            expect(editQuote).toHaveBeenCalledWith('testchannel', 5, 'Updated text', null);
        });
    });

    describe('Error Handling', () => {
        test('should handle storage errors gracefully', async () => {
            getRandomQuote.mockRejectedValue(new Error('Storage error'));

            const context = createMockContext([]);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, something went wrong handling !quote.',
                { replyToId: '123' }
            );
        });

        test('should handle add quote errors', async () => {
            addQuote.mockRejectedValue(new Error('Failed to add quote'));

            const context = createMockContext(['add', 'Test quote']);
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Sorry, something went wrong handling !quote.',
                { replyToId: '123' }
            );
        });
    });

    describe('Reply ID Handling', () => {
        test('should use user.id for replyToId', async () => {
            getRandomQuote.mockResolvedValue({ quoteId: 1, text: 'Test', saidBy: null });
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                id: '12345'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: '12345' }
            );
        });

        test('should fallback to message-id if user.id not available', async () => {
            getRandomQuote.mockResolvedValue({ quoteId: 1, text: 'Test', saidBy: null });
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser',
                'message-id': 'msg-123'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: 'msg-123' }
            );
        });

        test('should use null if no replyToId available', async () => {
            getRandomQuote.mockResolvedValue({ quoteId: 1, text: 'Test', saidBy: null });
            const context = createMockContext([], '#testchannel', {
                username: 'testuser',
                'display-name': 'TestUser'
            });

            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                expect.any(String),
                { replyToId: null }
            );
        });
    });

    describe('Usage Message', () => {
        test('should show usage for empty search term', async () => {
            // Empty search term should show usage
            const context = createMockContext(['']);
            await quoteHandler.execute(context);

            // Empty args will trigger random quote, so let's test with a recognized command but missing args
            // Actually, let's test with an empty string after a recognized command
            const context2 = createMockContext(['search', '']);
            await quoteHandler.execute(context2);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote search <term>',
                { replyToId: '123' }
            );
        });

        test('should show usage for invalid edit command', async () => {
            // Edit command with missing text should show usage
            // Need to be a mod to get past permission check
            const context = createMockContext(['edit', '5'], '#testchannel', {
                username: 'moduser',
                'display-name': 'ModUser',
                id: '123',
                mod: '1'
            });
            await quoteHandler.execute(context);

            expect(enqueueMessage).toHaveBeenCalledWith(
                '#testchannel',
                'Usage: !quote edit <id> <text [- author]>',
                { replyToId: '123' }
            );
        });
    });
});

