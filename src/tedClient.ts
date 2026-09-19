import { log } from 'apify';

import type { TedSearchRequest, TedSearchResponse } from './types.js';
import { TedApiError } from './types.js';

/**
 * TED's real public Search API, confirmed live from `https://api.ted.europa.eu/api-v3.yaml`
 * and `https://docs.ted.europa.eu/api/latest/index.html`:
 *   - Base URL: https://api.ted.europa.eu
 *   - POST /v3/notices/search
 *   - No authentication required for search/retrieval (anonymous, public access).
 * See ARCHITECTURE.md section 0 for why this actor deliberately does NOT implement any
 * anti-bot / stealth / TLS-fingerprint-impersonation layer: there is no bot detection here
 * to bypass, and building one against an official, no-auth government API would be
 * inappropriate, not just unnecessary.
 */
const TED_SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';

const USER_AGENT = 'DeltaRegistryTEDMonitor/1.0 (+https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor)';

const MAX_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Matches this fleet's established pattern (e.g. dataSource.ts/csvSource.ts) - found by
 * adversarial review to be a real gap here: with no timeout at all, a response that connects
 * but then stalls indefinitely on headers or body has no code-level bound. The AbortController
 * below covers the fetch call AND the subsequent body read within the same signal/attempt, not
 * just the initial connection, so a stall during either one is caught and retried like any
 * other transient failure.
 */
const REQUEST_TIMEOUT_MS = 60_000;

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function backoffDelay(attempt: number): number {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * exponential * 0.3;
    return exponential + jitter;
}

/**
 * Classifies a non-2xx TED response into the same outage-vs-defect separation this fleet
 * already applies elsewhere (e.g. uk-hse-enforcement-monitor): a real upstream problem must
 * never be confused with a code/query defect, since only the latter should ever surface as
 * an actionable fix to the caller.
 */
function classifyHttpError(status: number, body: unknown): TedApiError {
    if (status === 429) {
        return new TedApiError('RATE_LIMITED', 'TED Search API returned 429 (rate limited).', status, body);
    }
    if (status === 400) {
        const message = extractErrorMessage(body) ?? 'TED rejected the request (400) - most likely an invalid expertQuery. Use operationMode=VALIDATE_QUERY to check syntax before a real run.';
        return new TedApiError('QUERY_ERROR', message, status, body);
    }
    if (status >= 500) {
        return new TedApiError('UPSTREAM_OUTAGE', `TED Search API returned a server error (${status}).`, status, body);
    }
    return new TedApiError('QUERY_ERROR', `TED Search API returned an unexpected status ${status}.`, status, body);
}

/**
 * TED's real 400 error body, confirmed by live-testing this endpoint directly, is
 * `{ message: string, error: [{ objectName, field, message }, ...] }` - a top-level summary
 * plus a field-level detail array, not a single flat message. Both are surfaced so a caller
 * sees exactly which field/constraint failed, not just "Validation error".
 */
function extractErrorMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const record = body as Record<string, unknown>;
    const summary = typeof record.message === 'string' ? record.message : null;

    if (Array.isArray(record.error)) {
        const details = record.error
            .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
            .filter((entry): entry is Record<string, unknown> => entry !== null)
            .map((entry) => `${typeof entry.field === 'string' ? `${entry.field}: ` : ''}${typeof entry.message === 'string' ? entry.message : JSON.stringify(entry)}`)
            .join('; ');
        if (details) return summary ? `${summary} (${details})` : details;
    }

    if (summary) return summary;
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.error === 'string') return record.error;
    return null;
}

/**
 * Executes one search request against TED's real API, with real network-level retry
 * (exponential backoff + jitter) for connection failures and 5xx responses. A 4xx (other
 * than 429) is a query/request defect, not a transient failure, and is never retried.
 */
export async function searchNotices(request: TedSearchRequest): Promise<TedSearchResponse> {
    let lastError: TedApiError | undefined;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            const delay = backoffDelay(attempt - 1);
            log.info(`Retrying TED Search API call (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}) after ${Math.round(delay)}ms backoff...`);
            await sleep(delay);
        }

        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(TED_SEARCH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': USER_AGENT,
                },
                body: JSON.stringify(request),
                signal: timeoutController.signal,
            });

            if (response.ok) {
                return (await response.json()) as TedSearchResponse;
            }

            let body: unknown;
            try {
                body = await response.json();
            } catch {
                body = await response.text().catch(() => undefined);
            }

            const classified = classifyHttpError(response.status, body);
            if (classified.failureClass === 'QUERY_ERROR') {
                // A query/request defect is never transient - retrying it would just waste calls
                // and time without changing the outcome. Fail fast.
                throw classified;
            }
            lastError = classified;
        } catch (error) {
            if (error instanceof TedApiError) {
                throw error;
            }
            // Covers a genuine network-level failure AND a per-request timeout abort (the
            // AbortController fires whether the connection itself stalls or a response connects
            // but then never finishes delivering its body) - both are transient outage
            // conditions, not code/query defects, so both are retried the same way.
            lastError = new TedApiError(
                'UPSTREAM_OUTAGE',
                `Network-level failure reaching api.ted.europa.eu: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    throw lastError ?? new TedApiError('UPSTREAM_OUTAGE', 'TED Search API call failed with no further detail after retries.');
}

/**
 * Free syntax-only pre-flight, backed by TED's own `checkQuerySyntax: true` request flag -
 * confirmed real in the live spec. Runs no search and returns no notices; a 200 means the
 * query is syntactically valid, a 400 with QUERY_ERROR means it is not. This is what powers
 * this actor's VALIDATE_QUERY operation mode.
 */
export async function checkQuerySyntax(query: string): Promise<{ valid: boolean; message?: string }> {
    try {
        await searchNotices({
            query,
            // TED's real API rejects an empty `fields` array even for a pure syntax check
            // ("fields must not be empty") - confirmed by live-testing this endpoint directly.
            // `notice-identifier` is the minimal real field that satisfies this without
            // fetching anything meaningful.
            fields: ['notice-identifier'],
            limit: 1,
            scope: 'ALL',
            checkQuerySyntax: true,
            paginationMode: 'PAGE_NUMBER',
            onlyLatestVersions: false,
        });
        return { valid: true };
    } catch (error) {
        if (error instanceof TedApiError && error.failureClass === 'QUERY_ERROR') {
            return { valid: false, message: error.message };
        }
        throw error;
    }
}

/** Detects an expired Elasticsearch point-in-time scroll token from a QUERY_ERROR's response body. */
export function isTokenExpiredError(error: TedApiError): boolean {
    if (error.failureClass !== 'QUERY_ERROR') return false;
    const message = error.message.toLowerCase();
    return message.includes('token') && (message.includes('expired') || message.includes('invalid'));
}
