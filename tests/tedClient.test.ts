import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkQuerySyntax, isTokenExpiredError, searchNotices } from '../src/tedClient.js';
import type { TedSearchRequest } from '../src/types.js';
import { TedApiError } from '../src/types.js';

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function sampleRequest(overrides: Partial<TedSearchRequest> = {}): TedSearchRequest {
    return {
        query: 'publication-date >= today(-14) AND classification-cpv = 72*',
        fields: ['notice-identifier', 'publication-date'],
        page: 1,
        limit: 50,
        scope: 'ALL',
        paginationMode: 'PAGE_NUMBER',
        onlyLatestVersions: false,
        ...overrides,
    };
}

/** A real-shaped TED search response envelope (types.ts TedSearchResponse). */
function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function realSearchResponse() {
    return {
        notices: [
            {
                'notice-identifier': '24-599727-2026',
                'publication-date': '2026-08-15+02:00',
            },
        ],
        totalNoticeCount: 1,
        timedOut: false,
    };
}

/**
 * Runs `work` while auto-advancing fake timers, so this actor's real 1s-30s exponential backoff
 * between retries doesn't make the suite slow - the pattern already established fleet-wide (e.g.
 * sovereign-debt/tests/dataSource.test.ts's withFakeRetryTimers).
 */
async function withFakeRetryTimers<T>(work: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const resultPromise = work();
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- suppress unhandled-rejection warning during the advance window; the caller still awaits/asserts on resultPromise itself
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(120_000);
    return resultPromise;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('searchNotices', () => {
    it('returns the parsed JSON body on a successful request', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await searchNotices(sampleRequest());
        expect(result.notices).toHaveLength(1);
        expect(result.notices[0]['notice-identifier']).toBe('24-599727-2026');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('POSTs to the real TED search endpoint with the request body as JSON', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const request = sampleRequest();
        await searchNotices(request);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.ted.europa.eu/v3/notices/search');
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toEqual(request);
    });

    it('passes the literal query string through completely opaquely, with no client-side parsing or rewriting', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const literalQuery = 'publication-date >= today(-14) AND classification-cpv = 72*';
        await searchNotices(sampleRequest({ query: literalQuery }));
        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse(options.body).query).toBe(literalQuery);
    });

    it('retries on a 5xx response and succeeds once the server recovers', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ message: 'Internal error' }, 503))
            .mockResolvedValueOnce(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => searchNotices(sampleRequest()));
        expect(result.notices).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on a 429 (rate limited) - a real, classified-but-transient failure, not a hard defect', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ message: 'Too many requests' }, 429))
            .mockResolvedValueOnce(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => searchNotices(sampleRequest()));
        expect(result.notices).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on a genuine network-level failure (a rejected fetch), not just a resolved bad-status response', async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const result = await withFakeRetryTimers(async () => searchNotices(sampleRequest()));
        expect(result.notices).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a real 400 QUERY_ERROR - fails immediately, using TED\'s real { message, error: [...] } body shape', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse(
                {
                    message: 'Validation error',
                    error: [{ objectName: 'searchRequest', field: 'query', message: 'Unexpected token near AND AND' }],
                },
                400,
            ),
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchNotices(sampleRequest())).rejects.toThrow(/query: Unexpected token near AND AND/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('classifies a 400 as a TedApiError with failureClass QUERY_ERROR', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad request' }, 400));
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchNotices(sampleRequest())).rejects.toMatchObject({ failureClass: 'QUERY_ERROR', httpStatus: 400 });
    });

    it('falls back to a real body\'s top-level "detail" string when no message/error array is present', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'Malformed request syntax' }, 400));
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchNotices(sampleRequest())).rejects.toThrow('Malformed request syntax');
    });

    it('falls back to a real body\'s top-level "error" string when message/error-array/detail are all absent', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Bad Request' }, 400));
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchNotices(sampleRequest())).rejects.toThrow('Bad Request');
    });

    it('uses the generic QUERY_ERROR guidance message when a 400 body carries no extractable message at all', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 400));
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchNotices(sampleRequest())).rejects.toThrow(/most likely an invalid expertQuery/);
    });

    it('exhausts all retry attempts against a persistent 5xx and throws an UPSTREAM_OUTAGE error', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'down' }, 500));
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => searchNotices(sampleRequest()))).rejects.toMatchObject({ failureClass: 'UPSTREAM_OUTAGE' });
        expect(fetchMock).toHaveBeenCalledTimes(5); // MAX_RETRY_ATTEMPTS
    });

    it('exhausts all retry attempts against a persistently unreachable network and throws', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND api.ted.europa.eu'));
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => searchNotices(sampleRequest()))).rejects.toMatchObject({ failureClass: 'UPSTREAM_OUTAGE' });
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('falls back to the response text when the error body is not valid JSON', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => {
                throw new Error('not json');
            },
            text: async () => 'Internal Server Error (plain text)',
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => searchNotices(sampleRequest()))).rejects.toMatchObject({
            failureClass: 'UPSTREAM_OUTAGE',
            responseBody: 'Internal Server Error (plain text)',
        });
    });

    it('waits at least the documented base backoff delay before the first retry, and not before that (exponential backoff, tested indirectly since backoffDelay is not exported)', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ message: 'down' }, 503))
            .mockResolvedValueOnce(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const resultPromise = searchNotices(sampleRequest());
        resultPromise.catch(() => undefined);

        // BASE_BACKOFF_MS is 1000ms and jitter only ever ADDS delay - a real retry can never fire sooner.
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Max possible delay for the first retry is 1000ms * 1.3 = 1300ms; well past that by now.
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const result = await resultPromise;
        expect(result.notices).toHaveLength(1);
    });

    it('increases the wait between successive retries (exponential growth), not a fixed delay', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse({ message: 'down' }, 503))
            .mockResolvedValueOnce(jsonResponse({ message: 'down' }, 503))
            .mockResolvedValueOnce(jsonResponse(realSearchResponse()));
        vi.stubGlobal('fetch', fetchMock);

        const resultPromise = searchNotices(sampleRequest());
        resultPromise.catch(() => undefined);

        // First retry: base delay ~1000-1300ms.
        await vi.advanceTimersByTimeAsync(1300);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Immediately after the 2nd call returns, the 2nd retry's delay (~2000-2600ms) has not
        // elapsed yet - a fixed (non-exponential) backoff would already have fired by +700ms.
        await vi.advanceTimersByTimeAsync(700);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Advance well past the 2nd retry's max possible delay.
        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        const result = await resultPromise;
        expect(result.notices).toHaveLength(1);
    });
});

describe('checkQuerySyntax', () => {
    it('sends a real checkQuerySyntax pre-flight request with the minimal notice-identifier field and limit 1', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ notices: [], totalNoticeCount: 0 }));
        vi.stubGlobal('fetch', fetchMock);

        await checkQuerySyntax('publication-date >= today(-14)');
        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
            query: 'publication-date >= today(-14)',
            fields: ['notice-identifier'],
            limit: 1,
            scope: 'ALL',
            checkQuerySyntax: true,
            paginationMode: 'PAGE_NUMBER',
            onlyLatestVersions: false,
        });
    });

    it('returns { valid: true } when TED accepts the query', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ notices: [], totalNoticeCount: 0 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await checkQuerySyntax('classification-cpv = 72*');
        expect(result).toEqual({ valid: true });
    });

    it('returns { valid: false, message } when TED rejects the query with a real 400 QUERY_ERROR body', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({ message: 'Validation error', error: [{ field: 'query', message: 'Unexpected token' }] }, 400),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await checkQuerySyntax('classification-cpv === 72*');
        expect(result.valid).toBe(false);
        expect(result.message).toContain('Unexpected token');
    });

    it('rethrows a non-QUERY_ERROR failure (e.g. a persistent upstream outage) instead of reporting it as an invalid query', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'down' }, 500));
        vi.stubGlobal('fetch', fetchMock);

        await expect(withFakeRetryTimers(async () => checkQuerySyntax('classification-cpv = 72*'))).rejects.toMatchObject({ failureClass: 'UPSTREAM_OUTAGE' });
    });
});

describe('isTokenExpiredError', () => {
    it('returns false for a non-QUERY_ERROR failure class', () => {
        const error = new TedApiError('UPSTREAM_OUTAGE', 'token expired');
        expect(isTokenExpiredError(error)).toBe(false);
    });

    it('returns true when the QUERY_ERROR message mentions an expired token', () => {
        const error = new TedApiError('QUERY_ERROR', 'The iteration token has expired');
        expect(isTokenExpiredError(error)).toBe(true);
    });

    it('returns true when the QUERY_ERROR message mentions an invalid token', () => {
        const error = new TedApiError('QUERY_ERROR', 'Supplied scroll token is invalid');
        expect(isTokenExpiredError(error)).toBe(true);
    });

    it('is case-insensitive', () => {
        const error = new TedApiError('QUERY_ERROR', 'TOKEN EXPIRED');
        expect(isTokenExpiredError(error)).toBe(true);
    });

    it('returns false when the message mentions a token but not expiry/invalidity', () => {
        const error = new TedApiError('QUERY_ERROR', 'token field is required');
        expect(isTokenExpiredError(error)).toBe(false);
    });

    it('returns false when the message does not mention a token at all', () => {
        const error = new TedApiError('QUERY_ERROR', 'fields must not be empty');
        expect(isTokenExpiredError(error)).toBe(false);
    });
});
