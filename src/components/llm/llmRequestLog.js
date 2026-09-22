import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '../../lib/logger.js';

/**
 * One log line per outbound LLM HTTP request, emitted at the SDK boundary so every
 * call path (facade helpers, chat sessions, direct genAI usage) is counted, including
 * each retry attempt. Query in Cloud Logging with:
 *   jsonPayload.message:"[LLM] Request" — then group by jsonPayload.provider / caller.
 *
 * Feature attribution comes from withLlmCaller(): the outermost wrapper is the
 * `caller` (the feature that triggered the request), the innermost is the `op`
 * (e.g. a translation made on behalf of a !ask reply logs caller=cmd.ask, op=translate).
 */

const callerStore = new AsyncLocalStorage();

/**
 * Runs fn with an LLM caller label attached to the async context.
 * @param {string} name - Feature label, e.g. 'checkin', 'timer', 'cmd.ask'
 * @param {Function} fn - Async function to run
 */
export function withLlmCaller(name, fn) {
    const outer = callerStore.getStore();
    return callerStore.run({ caller: outer?.caller ?? name, op: name }, fn);
}

export function getLlmCaller() {
    return callerStore.getStore() ?? null;
}

function emit(fields, startedAt, error) {
    const durationMs = Date.now() - startedAt;
    const ctx = callerStore.getStore();
    const entry = { ...fields, caller: ctx?.caller ?? null, op: ctx?.op ?? null, durationMs };
    if (error) {
        const status = error?.status || error?.response?.status || error?.statusCode || null;
        logger.warn({ ...entry, status, errorMessage: error?.message }, '[LLM] Request failed');
    } else {
        logger.info(entry, '[LLM] Request completed');
    }
}

/**
 * Wraps openai.responses.create so each request is logged with model, tier, tools and token usage.
 */
export function instrumentOpenAiClient(client) {
    const original = client?.responses?.create;
    if (typeof original !== 'function') return client;

    client.responses.create = async function create(payload, ...rest) {
        const startedAt = Date.now();
        const fields = {
            provider: 'openai',
            model: payload?.model ?? null,
            serviceTier: payload?.service_tier ?? null,
            tools: Array.isArray(payload?.tools) ? payload.tools.map(t => t?.type ?? 'unknown') : [],
            structured: !!payload?.text?.format,
            reasoningEffort: payload?.reasoning?.effort ?? null,
        };
        try {
            const response = await original.call(this, payload, ...rest);
            const usage = response?.usage;
            emit({
                ...fields,
                inputTokens: usage?.input_tokens ?? null,
                cachedTokens: usage?.input_tokens_details?.cached_tokens ?? null,
                outputTokens: usage?.output_tokens ?? null,
                reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
            }, startedAt);
            return response;
        } catch (error) {
            emit(fields, startedAt, error);
            throw error;
        }
    };
    return client;
}

/**
 * Wraps genAI.models.generateContent so each request is logged with model, tier, tools and token usage.
 */
export function instrumentGenAiClient(genAI) {
    const original = genAI?.models?.generateContent;
    if (typeof original !== 'function') return genAI;

    genAI.models.generateContent = async function generateContent(payload, ...rest) {
        const startedAt = Date.now();
        const cfg = payload?.config ?? {};
        const fields = {
            provider: 'gemini',
            model: payload?.model ?? null,
            serviceTier: cfg.serviceTier ?? null,
            tools: Array.isArray(cfg.tools) ? cfg.tools.flatMap(t => Object.keys(t ?? {})) : [],
            structured: !!cfg.responseSchema || cfg.responseMimeType === 'application/json',
            thinkingLevel: cfg.thinkingConfig?.thinkingLevel ?? null,
        };
        try {
            const response = await original.call(this, payload, ...rest);
            const usage = response?.usageMetadata;
            emit({
                ...fields,
                inputTokens: usage?.promptTokenCount ?? null,
                cachedTokens: usage?.cachedContentTokenCount ?? null,
                outputTokens: usage?.candidatesTokenCount ?? null,
                reasoningTokens: usage?.thoughtsTokenCount ?? null,
            }, startedAt);
            return response;
        } catch (error) {
            emit(fields, startedAt, error);
            throw error;
        }
    };
    return genAI;
}
