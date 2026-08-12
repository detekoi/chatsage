import {
    resolveServiceTier,
    retryWithFlexFallback,
    executeWithFlexFallback
} from '../../../../src/components/llm/retryUtils.js';

describe('LLM Retry Utilities', () => {
    describe('resolveServiceTier', () => {
        test('should resolve serviceTier when passed as camelCase', () => {
            expect(resolveServiceTier({ serviceTier: 'flex' })).toBe('flex');
            expect(resolveServiceTier({ serviceTier: 'auto' })).toBe('auto');
        });

        test('should resolve service_tier when passed as snake_case', () => {
            expect(resolveServiceTier({ service_tier: 'flex' })).toBe('flex');
            expect(resolveServiceTier({ service_tier: 'auto' })).toBe('auto');
        });

        test('should return undefined when options object is empty or missing tier', () => {
            expect(resolveServiceTier({})).toBeUndefined();
            expect(resolveServiceTier(null)).toBeUndefined();
            expect(resolveServiceTier({ model: 'gpt-5.6-luna' })).toBeUndefined();
        });
    });

    describe('retryWithFlexFallback', () => {
        test('should return result when Flex function succeeds on first attempt', async () => {
            const flexFn = jest.fn().mockResolvedValue('flex success');
            const standardFn = jest.fn().mockResolvedValue('standard success');

            const result = await retryWithFlexFallback(flexFn, standardFn, 'TestOp');
            expect(result).toBe('flex success');
            expect(flexFn).toHaveBeenCalledTimes(1);
            expect(standardFn).not.toHaveBeenCalled();
        });

        test('should fallback to standardFn when flexFn throws a 429 Resource Unavailable error', async () => {
            const flexErr = new Error('429 Resource Unavailable');
            flexErr.status = 429;
            const flexFn = jest.fn().mockRejectedValue(flexErr);
            const standardFn = jest.fn().mockResolvedValue('standard fallback success');

            const result = await retryWithFlexFallback(flexFn, standardFn, 'TestOp');
            expect(result).toBe('standard fallback success');
            expect(standardFn).toHaveBeenCalledTimes(1);
        });

        test('should fallback to standardFn when flexFn throws a 503 Service Unavailable error', async () => {
            const flexErr = new Error('503 Service Unavailable');
            flexErr.status = 503;
            const flexFn = jest.fn().mockRejectedValue(flexErr);
            const standardFn = jest.fn().mockResolvedValue('standard fallback success');

            const result = await retryWithFlexFallback(flexFn, standardFn, 'TestOp');
            expect(result).toBe('standard fallback success');
            expect(standardFn).toHaveBeenCalledTimes(1);
        });

        test('should fallback to standardFn on any non-retryable or unexpected error (e.g. 400)', async () => {
            const err400 = new Error('Bad Request');
            err400.status = 400;
            const flexFn = jest.fn().mockRejectedValue(err400);
            const standardFn = jest.fn().mockResolvedValue('fallback success');

            const result = await retryWithFlexFallback(flexFn, standardFn, 'TestOp');
            expect(result).toBe('fallback success');
            expect(standardFn).toHaveBeenCalledTimes(1);
        });

        test('should rethrow error if standardFn fails as well', async () => {
            const flexErr = new Error('429 Resource Unavailable');
            flexErr.status = 429;
            const flexFn = jest.fn().mockRejectedValue(flexErr);

            const stdErr = new Error('Standard tier failed');
            stdErr.status = 500;
            const standardFn = jest.fn().mockRejectedValue(stdErr);

            await expect(retryWithFlexFallback(flexFn, standardFn, 'TestOp')).rejects.toThrow('Standard tier failed');
        });
    });

    describe('executeWithFlexFallback', () => {
        test('should execute apiCallFn directly when serviceTier is undefined', async () => {
            const apiCallFn = jest.fn().mockResolvedValue('normal result');
            const basePayload = { model: 'gpt-5.6-luna', input: 'hello' };

            const result = await executeWithFlexFallback(apiCallFn, basePayload, {}, 'TestExecute');
            expect(result).toBe('normal result');
            expect(apiCallFn).toHaveBeenCalledWith(basePayload, undefined);
        });

        test('should split payloads and call retryWithFlexFallback when serviceTier is flex', async () => {
            const apiCallFn = jest.fn().mockImplementation((payload) => {
                if (payload.service_tier === 'flex') {
                    const err = new Error('Resource Unavailable');
                    err.status = 429;
                    return Promise.reject(err);
                }
                return Promise.resolve('fallback result');
            });

            const basePayload = { model: 'gpt-5.6-luna', input: 'hello' };
            const result = await executeWithFlexFallback(apiCallFn, basePayload, { serviceTier: 'flex' }, 'TestExecuteFlex');

            expect(result).toBe('fallback result');
            expect(apiCallFn).toHaveBeenCalledWith(expect.objectContaining({ service_tier: 'flex' }), undefined);
            expect(apiCallFn).toHaveBeenCalledWith(expect.not.objectContaining({ service_tier: 'flex' }), undefined);
        });
    });
});
