// src/components/commands/handlers/quote.js
import logger from '../../../lib/logger.js';
import { enqueueMessage } from '../../../lib/ircSender.js';
import {
    addQuote,
    getQuoteById,
    getRandomQuote,
    getLastQuote,
    searchQuotes,
    deleteQuote as deleteQuoteFromStorage,
    editQuote as editQuoteInStorage
} from '../../quotes/quoteStorage.js';

// Local helper (pattern used in other handlers)
function isPrivilegedUser(tags, channelName) {
    const isMod = tags.mod === '1' || tags.badges?.moderator === '1';
    const isBroadcaster = tags.badges?.broadcaster === '1' || tags.username === channelName;
    return isMod || isBroadcaster;
}

// Parse text of form: 'some quote text - author' or 'some quote text-author'
// Supports '-', '–', '—' with optional spaces
// Returns { text, saidBy }
function parseQuoteText(raw) {
    let s = String(raw || '').trim();
    
    // Remove surrounding quotes first
    s = s.replace(/^["""]+|["""]+$/g, '');
    
    // Find the last occurrence of any dash type
    const lastHyphen = s.lastIndexOf('-');
    const lastEnDash = s.lastIndexOf('–');
    const lastEmDash = s.lastIndexOf('—');
    const lastDashPos = Math.max(lastHyphen, lastEnDash, lastEmDash);
    
    if (lastDashPos === -1) {
        return { text: s.trim(), saidBy: null };
    }
    
    // Split at the last dash position
    const beforeDash = s.substring(0, lastDashPos).trim();
    const afterDash = s.substring(lastDashPos + 1).trim();
    
    // Remove any leading dashes/spaces from author part
    const author = afterDash.replace(/^[\-–—\s]+/, '').trim();
    
    // If there's no actual content after the dash, treat the dash as part of the quote text
    if (!author) {
        return { text: s.trim(), saidBy: null };
    }
    
    // Also remove any trailing quotes from the text part
    const text = beforeDash.replace(/["""]+$/, '').trim();
    
    return { 
        text, 
        saidBy: author || null 
    };
}

const MAX_QUOTE_LENGTH = 500;

const quoteHandler = {
    name: 'quote',
    description: 'Add, view, or search quotes. Usage: !quote [add|<id>|last|search <term>|delete <id>|edit <id> <text>]',
    usage: '!quote | !quote 12 | !quote add <text [- author]> | !quote last | !quote search <term> | !quote delete <id> | !quote edit <id> <text [- author]>',
    permission: 'everyone',
    execute: async (context) => {
        const { channel, user, args } = context;
        const channelName = channel.replace(/^#/, '');
        const replyToId = user?.id || user?.['message-id'] || null;

        try {
            if (!args || args.length === 0) {
                // Random
                const q = await getRandomQuote(channelName);
                if (!q) return enqueueMessage(channel, `No quotes yet. Add one with "!quote add <text [- author]>"`, { replyToId });
                const suffix = q.saidBy ? ` — ${q.saidBy}` : '';
                return enqueueMessage(channel, `[#${q.quoteId}] "${q.text}"${suffix}`, { replyToId });
            }

            const sub = String(args[0]).toLowerCase();
            const recognizedCommands = ['last', 'search', 'add', 'delete', 'remove', 'del', 'edit', 'update'];

            if (/^\d+$/.test(sub)) {
                const id = parseInt(sub, 10);
                const q = await getQuoteById(channelName, id);
                if (!q) return enqueueMessage(channel, `Quote #${id} not found.`, { replyToId });
                const suffix = q.saidBy ? ` — ${q.saidBy}` : '';
                return enqueueMessage(channel, `[#${q.quoteId}] "${q.text}"${suffix}`, { replyToId });
            }

            if (sub === 'last') {
                const q = await getLastQuote(channelName);
                if (!q) return enqueueMessage(channel, `No quotes yet.`, { replyToId });
                const suffix = q.saidBy ? ` — ${q.saidBy}` : '';
                return enqueueMessage(channel, `[#${q.quoteId}] "${q.text}"${suffix}`, { replyToId });
            }

            if (sub === 'search') {
                const term = args.slice(1).join(' ').trim();
                if (!term) return enqueueMessage(channel, `Usage: !quote search <term>`, { replyToId });
                const results = await searchQuotes(channelName, term);
                if (!results || results.length === 0) {
                    return enqueueMessage(channel, `No quotes matching "${term}".`, { replyToId });
                }
                const q = results[0];
                const suffix = q.saidBy ? ` — ${q.saidBy}` : '';
                return enqueueMessage(channel, `[#${q.quoteId}] "${q.text}"${suffix}`, { replyToId });
            }

            // If not a recognized command, treat as search
            if (!recognizedCommands.includes(sub)) {
                const term = args.join(' ').trim();
                if (!term) return enqueueMessage(channel, `Usage: !quote | !quote 12 | !quote add <text [- author]> | !quote last | !quote search <term> | !quote delete <id> | !quote edit <id> <text>`, { replyToId });
                const results = await searchQuotes(channelName, term);
                if (!results || results.length === 0) {
                    return enqueueMessage(channel, `No quotes matching "${term}".`, { replyToId });
                }
                const q = results[0];
                const suffix = q.saidBy ? ` — ${q.saidBy}` : '';
                return enqueueMessage(channel, `[#${q.quoteId}] "${q.text}"${suffix}`, { replyToId });
            }

            if (sub === 'add') {
                const raw = args.slice(1).join(' ').trim();
                if (!raw) return enqueueMessage(channel, `Usage: !quote add <text [- author]>`, { replyToId });
                if (raw.length > MAX_QUOTE_LENGTH) {
                    return enqueueMessage(channel, `Quote too long (max ${MAX_QUOTE_LENGTH} chars).`, { replyToId });
                }
                const { text, saidBy } = parseQuoteText(raw);
                const addedBy = user?.['display-name'] || user?.username || 'unknown';
                const { quoteId } = await addQuote(channelName, text, saidBy, addedBy);
                const suffix = saidBy ? ` — ${saidBy}` : '';
                return enqueueMessage(channel, `Added quote #${quoteId}: "${text}"${suffix}`, { replyToId });
            }

            if (sub === 'delete' || sub === 'remove' || sub === 'del') {
                if (!isPrivilegedUser(user, channelName)) {
                    return enqueueMessage(channel, `Only mods/broadcaster can delete quotes.`, { replyToId });
                }
                if (args.length < 2 || !/^\d+$/.test(args[1])) {
                    return enqueueMessage(channel, `Usage: !quote delete <id>`, { replyToId });
                }
                const id = parseInt(args[1], 10);
                const ok = await deleteQuoteFromStorage(channelName, id);
                return enqueueMessage(channel, ok ? `Deleted quote #${id}.` : `Quote #${id} not found.`, { replyToId });
            }

            if (sub === 'edit' || sub === 'update') {
                if (!isPrivilegedUser(user, channelName)) {
                    return enqueueMessage(channel, `Only mods/broadcaster can edit quotes.`, { replyToId });
                }
                if (args.length < 3 || !/^\d+$/.test(args[1])) {
                    return enqueueMessage(channel, `Usage: !quote edit <id> <text [- author]>`, { replyToId });
                }
                const id = parseInt(args[1], 10);
                const raw = args.slice(2).join(' ').trim();
                if (!raw) return enqueueMessage(channel, `Usage: !quote edit <id> <text [- author]>`, { replyToId });
                if (raw.length > MAX_QUOTE_LENGTH) {
                    return enqueueMessage(channel, `Quote too long (max ${MAX_QUOTE_LENGTH} chars).`, { replyToId });
                }
                const { text, saidBy } = parseQuoteText(raw);
                const ok = await editQuoteInStorage(channelName, id, text, saidBy);
                return enqueueMessage(channel, ok ? `Updated quote #${id}.` : `Quote #${id} not found.`, { replyToId });
            }

            return enqueueMessage(channel, `Usage: !quote | !quote 12 | !quote add <text [- author]> | !quote last | !quote search <term> | !quote delete <id> | !quote edit <id> <text>`, { replyToId });
        } catch (err) {
            logger.error({ 
                err, 
                errorMessage: err?.message,
                errorCode: err?.code,
                errorStack: err?.stack,
                channel: channelName, 
                user: user?.username,
                args: args 
            }, '[QuoteCommand] Error executing quote command');
            return enqueueMessage(channel, `Sorry, something went wrong handling !quote.`, { replyToId });
        }
    },
};

export default quoteHandler;