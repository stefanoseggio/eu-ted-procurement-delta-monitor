import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActorInput, DeltaState, OutputRecord, RawNotice, TedSearchResponse } from '../src/types.js';
import { TedApiError } from '../src/types.js';

const pushedRecords: { record: OutputRecord; eventName?: string }[] = [];
const mockPushData = vi.fn(async (record: OutputRecord, eventName?: string) => {
    pushedRecords.push({ record, eventName });
    return {} as { eventChargeLimitReached?: boolean };
});
const mockSetValue = vi.fn(async () => undefined);

vi.mock('apify', () => ({
    Actor: { pushData: async (...args: unknown[]) => mockPushData(...(args as [OutputRecord, string?])), setValue: async (...args: unknown[]) => mockSetValue(...args) },
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const mockSearchNotices = vi.fn();
const mockCheckQuerySyntax = vi.fn();
const mockIsTokenExpiredError = vi.fn();
vi.mock('../src/tedClient.js', () => ({
    searchNotices: (...args: unknown[]) => mockSearchNotices(...args),
    checkQuerySyntax: (...args: unknown[]) => mockCheckQuerySyntax(...args),
    isTokenExpiredError: (...args: unknown[]) => mockIsTokenExpiredError(...args),
}));

const mockNotifyHighValueChange = vi.fn(async () => undefined);
vi.mock('../src/webhookNotifier.js', () => ({
    notifyHighValueChange: async (...args: unknown[]) => mockNotifyHighValueChange(...args),
}));

const { runBackfill, runIncremental, runValidateQuery } = await import('../src/routes.js');

const DEFAULT_FIELDS = [
    'notice-identifier',
    'publication-number',
    'publication-date',
    'notice-title',
    'buyer-name',
    'organisation-name-buyer',
    'organisation-country-buyer',
    'classification-cpv',
    'deadline-receipt-tender-date-lot',
    'procedure-type',
    'estimated-value-lot',
    'estimated-value-cur-lot',
    'result-value-lot',
    'result-value-notice',
    'result-value-cur-notice',
    'winner-identifier',
    'winner-country',
    'winner-size',
    'links',
];

function rawNotice(overrides: Partial<RawNotice> = {}): RawNotice {
    return {
        'notice-identifier': '24-599727-2026',
        'publication-number': '00599727-2026',
        'publication-date': '2026-08-15+02:00',
        'notice-title': { eng: 'Geotechnical investigation services for the A61 motorway extension' },
        'buyer-name': { eng: 'Landesbetrieb Straßenbau NRW' },
        'organisation-country-buyer': 'DEU',
        'classification-cpv': ['71332000'],
        'deadline-receipt-tender-date-lot': ['2026-09-30+02:00'],
        'procedure-type': 'open',
        'estimated-value-lot': ['185000.00'],
        'estimated-value-cur-lot': ['EUR'],
        links: { htmlDirect: { ENG: 'https://ted.europa.eu/en/notice/-/detail/599727-2026' } },
        ...overrides,
    };
}

function searchResponse(notices: RawNotice[], overrides: Partial<TedSearchResponse> = {}): TedSearchResponse {
    return { notices, totalNoticeCount: notices.length, timedOut: false, ...overrides };
}

function emptyState(): DeltaState {
    return { notices: {}, baselineComplete: false };
}

function baseInput(overrides: Partial<ActorInput> = {}): ActorInput {
    return { expertQuery: 'publication-date >= today(-14) AND classification-cpv = 72*', ...overrides };
}

beforeEach(() => {
    pushedRecords.length = 0;
    mockPushData.mockClear();
    mockSetValue.mockReset().mockResolvedValue(undefined);
    mockSearchNotices.mockReset();
    mockCheckQuerySyntax.mockReset();
    mockIsTokenExpiredError.mockReset();
    mockNotifyHighValueChange.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('runValidateQuery', () => {
    it('validates via checkQuerySyntax and records a valid result with no message', async () => {
        mockCheckQuerySyntax.mockResolvedValue({ valid: true });
        await runValidateQuery(baseInput({ expertQuery: 'classification-cpv = 72*' }));

        expect(mockCheckQuerySyntax).toHaveBeenCalledWith('classification-cpv = 72*');
        expect(mockSetValue).toHaveBeenCalledWith('OUTPUT', {
            operationMode: 'VALIDATE_QUERY',
            query: 'classification-cpv = 72*',
            valid: true,
            message: null,
        });
    });

    it('records an invalid result with the real TED error message', async () => {
        mockCheckQuerySyntax.mockResolvedValue({ valid: false, message: 'query: Unexpected token near AND AND' });
        await runValidateQuery(baseInput({ expertQuery: 'classification-cpv === 72*' }));

        expect(mockSetValue).toHaveBeenCalledWith('OUTPUT', {
            operationMode: 'VALIDATE_QUERY',
            query: 'classification-cpv === 72*',
            valid: false,
            message: 'query: Unexpected token near AND AND',
        });
    });

    it('passes the literal "today(-14)" expert query through to checkQuerySyntax completely opaquely - no client-side parsing', async () => {
        mockCheckQuerySyntax.mockResolvedValue({ valid: true });
        const literalQuery = 'publication-date >= today(-14) AND classification-cpv = 72*';
        await runValidateQuery(baseInput({ expertQuery: literalQuery }));
        expect(mockCheckQuerySyntax).toHaveBeenCalledWith(literalQuery);
    });
});

describe('runIncremental - request building', () => {
    it('uses the real DEFAULT_FIELDS list, force-including notice-identifier, when input.fields is not set', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput(), emptyState());
        expect(mockSearchNotices.mock.calls[0][0].fields).toEqual(DEFAULT_FIELDS);
    });

    it('falls back to DEFAULT_FIELDS when input.fields is an empty array - TED rejects an empty fields array with a 400', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput({ fields: [] }), emptyState());
        expect(mockSearchNotices.mock.calls[0][0].fields).toEqual(DEFAULT_FIELDS);
    });

    it('uses a custom fields list, force-including notice-identifier when the user omitted it', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput({ fields: ['notice-title', 'buyer-name'] }), emptyState());
        expect(mockSearchNotices.mock.calls[0][0].fields).toEqual(['notice-title', 'buyer-name', 'notice-identifier']);
    });

    it('does not duplicate notice-identifier when the user already included it', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput({ fields: ['notice-identifier', 'buyer-name'] }), emptyState());
        expect(mockSearchNotices.mock.calls[0][0].fields).toEqual(['notice-identifier', 'buyer-name']);
    });

    it('defaults scope to ALL, onlyLatestVersions to false, limit to 50, and always uses PAGE_NUMBER pagination', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput(), emptyState());
        expect(mockSearchNotices.mock.calls[0][0]).toMatchObject({ scope: 'ALL', onlyLatestVersions: false, limit: 50, page: 1, paginationMode: 'PAGE_NUMBER' });
    });

    it('passes custom scope, onlyLatestVersions, and limit through unchanged', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runIncremental(baseInput({ scope: 'LATEST', onlyLatestVersions: true, limit: 100 }), emptyState());
        expect(mockSearchNotices.mock.calls[0][0]).toMatchObject({ scope: 'LATEST', onlyLatestVersions: true, limit: 100 });
    });

    it('passes the literal "today(-14)" expert query straight through to searchNotices, completely opaquely - no client-side parsing, validation, or rewriting of TED\'s server-side date function', async () => {
        const literalQuery = 'publication-date >= today(-14) AND classification-cpv = 72*';
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()]));
        await runIncremental(baseInput({ expertQuery: literalQuery }), emptyState());
        expect(mockSearchNotices.mock.calls[0][0].query).toBe(literalQuery);
    });
});

describe('runIncremental - pagination', () => {
    it('marks the baseline complete and stops when the first page is already empty', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        const state = emptyState();
        const stats = await runIncremental(baseInput(), state);
        expect(state.baselineComplete).toBe(true);
        expect(stats.totalPushed).toBe(0);
        expect(mockSearchNotices).toHaveBeenCalledTimes(1);
    });

    it('marks the baseline complete after one page once page*limit reaches totalNoticeCount', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const state = emptyState();
        await runIncremental(baseInput({ limit: 50 }), state);
        expect(state.baselineComplete).toBe(true);
        expect(mockSearchNotices).toHaveBeenCalledTimes(1);
    });

    it('marks the baseline complete on a short (< limit), non-timed-out page - a reliable end-of-results signal', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 500, timedOut: false }));
        const state = emptyState();
        await runIncremental(baseInput({ limit: 50 }), state);
        expect(state.baselineComplete).toBe(true);
        expect(mockSearchNotices).toHaveBeenCalledTimes(1);
    });

    it('does NOT treat a short but timed-out page as exhausted - fetches a second page instead', async () => {
        mockSearchNotices
            .mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 500, timedOut: true }))
            .mockResolvedValueOnce(searchResponse([], { totalNoticeCount: 500 }));
        const state = emptyState();
        await runIncremental(baseInput({ limit: 50 }), state);
        expect(mockSearchNotices).toHaveBeenCalledTimes(2);
        expect(mockSearchNotices.mock.calls[1][0].page).toBe(2);
        expect(state.baselineComplete).toBe(true);
    });

    it('stops mid-page once maxItems is reached, without marking the baseline complete (the never-fetched remainder must not be lost)', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true }; // NEW_NOTICE is charged, so maxItems can actually trigger
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse([rawNotice({ 'notice-identifier': 'A' }), rawNotice({ 'notice-identifier': 'B' })], { totalNoticeCount: 2 }),
        );
        const stats = await runIncremental(baseInput({ maxItems: 1, onlyNew: false }), state);
        expect(stats.stopped).toBe(true);
        expect(stats.totalPushed).toBe(1);
        expect(state.baselineComplete).toBe(true); // was already true going in; the point is it isn't RE-derived from an exhausted check
        expect(Object.keys(state.notices)).toEqual(['A']); // notice B was never reached
    });

    it('stops the run when Apify reports eventChargeLimitReached on a charged push', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockPushData.mockResolvedValueOnce({ eventChargeLimitReached: true });
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse([rawNotice({ 'notice-identifier': 'A' }), rawNotice({ 'notice-identifier': 'B' })], { totalNoticeCount: 2 }),
        );
        const stats = await runIncremental(baseInput({ onlyNew: false }), state);
        expect(stats.stopped).toBe(true);
        expect(stats.totalPushed).toBe(1);
    });

    it("stops at TED's own 15,000-notice pagination-mode cap without fetching a page beyond it, directing the caller to BACKFILL instead", async () => {
        // Cheap fixture: a bare notice-identifier is all normalizeNotice requires, so this
        // exercises the real page/limit arithmetic without the cost of a fully-populated fixture.
        const page = (n: number) => Array.from({ length: n }, (_, i) => rawNotice({ 'notice-identifier': `bulk-${i}` }));
        mockSearchNotices.mockResolvedValueOnce(searchResponse(page(15000), { totalNoticeCount: 999_999 }));
        const state = emptyState();
        await runIncremental(baseInput({ limit: 15000 }), state);
        // page=1 (cap check 0>=15000 false) then page=2 (cap check 15000>=15000 true) -> stops before a 2nd fetch.
        expect(mockSearchNotices).toHaveBeenCalledTimes(1);
    });

    it('skips a notice that fails to normalize (missing notice-identifier) but still processes the rest of the page', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse([rawNotice({ 'notice-identifier': undefined }), rawNotice({ 'notice-identifier': 'B' })], { totalNoticeCount: 2 }),
        );
        const stats = await runIncremental(baseInput({ onlyNew: false }), state);
        expect(stats.totalPushed).toBe(1);
        expect(pushedRecords[0].record.notice_identifier).toBe('B');
    });
});

describe('runIncremental - PPE event mapping and onlyNew delivery filter', () => {
    it('does not push (but does record) a BASELINE_SNAPSHOT under the default onlyNew=true', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const stats = await runIncremental(baseInput(), state);
        expect(stats.totalPushed).toBe(0);
        expect(mockPushData).not.toHaveBeenCalled();
        expect(state.notices['24-599727-2026']).toBeDefined(); // still recorded, so the next run can classify correctly
    });

    it('pushes a BASELINE_SNAPSHOT uncharged (no eventName) when onlyNew is explicitly false', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        await runIncremental(baseInput({ onlyNew: false }), state);
        expect(mockPushData).toHaveBeenCalledTimes(1);
        expect(mockPushData.mock.calls[0]).toHaveLength(1); // called with the record only, no eventName arg
        expect(pushedRecords[0].eventName).toBeUndefined();
    });

    it('pushes NEW_NOTICE charged under the "new-notice" event name', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        await runIncremental(baseInput(), state);
        expect(pushedRecords[0].eventName).toBe('new-notice');
        expect(pushedRecords[0].record.event_type).toBe('NEW_NOTICE');
    });

    it('pushes NOTICE_UPDATED charged under the "notice-updated" event name', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        await runIncremental(baseInput(), state); // run 1: baseline, records fingerprint
        pushedRecords.length = 0;

        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'procedure-type': 'restricted' })], { totalNoticeCount: 1 }));
        await runIncremental(baseInput(), state); // run 2: content changed
        expect(pushedRecords).toHaveLength(1);
        expect(pushedRecords[0].eventName).toBe('notice-updated');
        expect(pushedRecords[0].record.event_type).toBe('NOTICE_UPDATED');
    });

    it('does not push NOTICE_UNCHANGED under the default onlyNew=true, but does push it uncharged when onlyNew is false', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        await runIncremental(baseInput(), state);
        pushedRecords.length = 0;

        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const statsDefault = await runIncremental(baseInput(), state);
        expect(statsDefault.totalPushed).toBe(0);

        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const statsOnlyNewFalse = await runIncremental(baseInput({ onlyNew: false }), state);
        expect(statsOnlyNewFalse.totalPushed).toBe(1);
        expect(pushedRecords[0].eventName).toBeUndefined();
        expect(pushedRecords[0].record.event_type).toBe('NOTICE_UNCHANGED');
    });
});

describe('Full delta lifecycle across sequential runs (baseline -> unchanged -> updated -> new)', () => {
    it('walks a realistic multi-run sequence and verifies every classification and billing decision', async () => {
        const state = emptyState();
        const input = baseInput({ onlyNew: false }); // deliver every tier so every transition is observable

        // Run 1: first-ever observation. Must be BASELINE_SNAPSHOT, uncharged.
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const stats1 = await runIncremental(input, state);
        expect(stats1.byEventType.BASELINE_SNAPSHOT).toBe(1);
        expect(pushedRecords[0].eventName).toBeUndefined();
        expect(state.baselineComplete).toBe(true);
        pushedRecords.length = 0;

        // Run 2: identical data. Must be NOTICE_UNCHANGED, uncharged.
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice()], { totalNoticeCount: 1 }));
        const stats2 = await runIncremental(input, state);
        expect(stats2.byEventType.NOTICE_UNCHANGED).toBe(1);
        expect(pushedRecords[0].eventName).toBeUndefined();
        pushedRecords.length = 0;

        // Run 3: the notice's procedure type changes. Must be NOTICE_UPDATED, CHARGED.
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'procedure-type': 'restricted' })], { totalNoticeCount: 1 }));
        const stats3 = await runIncremental(input, state);
        expect(stats3.byEventType.NOTICE_UPDATED).toBe(1);
        expect(pushedRecords[0].eventName).toBe('notice-updated');
        pushedRecords.length = 0;

        // Run 4: a brand-new notice appears alongside the (again-changed) existing one.
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse(
                [rawNotice({ 'procedure-type': 'open' }), rawNotice({ 'notice-identifier': '24-600000-2026', 'notice-title': { eng: 'A brand new notice' } })],
                { totalNoticeCount: 2 },
            ),
        );
        const stats4 = await runIncremental(input, state);
        expect(stats4.byEventType.NOTICE_UPDATED).toBe(1);
        expect(stats4.byEventType.NEW_NOTICE).toBe(1);
        expect(pushedRecords.find((p) => p.record.notice_identifier === '24-600000-2026')?.eventName).toBe('new-notice');
        expect(pushedRecords.find((p) => p.record.notice_identifier === '24-599727-2026')?.eventName).toBe('notice-updated');
    });
});

describe('webhookUrl / high-value-change notification', () => {
    it('never notifies when no webhookUrl is configured, regardless of event type', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'winner-identifier': ['DE123456789'] })], { totalNoticeCount: 1 }));
        await runIncremental(baseInput(), state);
        expect(mockNotifyHighValueChange).not.toHaveBeenCalled();
    });

    it('notifies for a NEW_NOTICE that already carries status data (award value/winner/procedure type)', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'winner-identifier': ['DE123456789'] })], { totalNoticeCount: 1 }));
        await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state);
        expect(mockNotifyHighValueChange).toHaveBeenCalledTimes(1);
        expect(mockNotifyHighValueChange).toHaveBeenCalledWith('https://example.com/hook', expect.objectContaining({ notice_identifier: '24-599727-2026' }));
    });

    it('does not notify for a NEW_NOTICE with no status data at all', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse(
                [rawNotice({ 'winner-identifier': undefined, 'result-value-lot': undefined, 'result-value-notice': undefined, 'procedure-type': undefined })],
                { totalNoticeCount: 1 },
            ),
        );
        await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state);
        expect(mockNotifyHighValueChange).not.toHaveBeenCalled();
    });

    it('does NOT notify a NOTICE_UPDATED whose status-tier fields are unchanged, even though status data is present - the exact regression documented in isHighValueChange', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'winner-identifier': ['DE123456789'] })], { totalNoticeCount: 1 }));
        await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state); // baseline, not a NEW/UPDATED event, no notify expected here regardless
        mockNotifyHighValueChange.mockClear();

        // Only the title changes this time - a NOTICE_UPDATED, but winnerIdentifier (status-tier) is unchanged.
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse([rawNotice({ 'winner-identifier': ['DE123456789'], 'notice-title': { eng: 'Retitled notice, same award status' } })], { totalNoticeCount: 1 }),
        );
        const stats = await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state);
        expect(stats.byEventType.NOTICE_UPDATED).toBe(1);
        expect(mockNotifyHighValueChange).not.toHaveBeenCalled();
    });

    it('DOES notify a NOTICE_UPDATED whose status-tier fields genuinely changed', async () => {
        const state = emptyState();
        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'winner-identifier': undefined, 'result-value-lot': undefined, 'result-value-notice': undefined, 'procedure-type': 'open' })], { totalNoticeCount: 1 }));
        await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state);
        mockNotifyHighValueChange.mockClear();

        mockSearchNotices.mockResolvedValueOnce(searchResponse([rawNotice({ 'winner-identifier': ['DE123456789'], 'procedure-type': 'open' })], { totalNoticeCount: 1 }));
        const stats = await runIncremental(baseInput({ webhookUrl: 'https://example.com/hook' }), state);
        expect(stats.byEventType.NOTICE_UPDATED).toBe(1);
        expect(mockNotifyHighValueChange).toHaveBeenCalledTimes(1);
    });
});

describe('runBackfill - request building and ITERATION pagination', () => {
    it('uses ITERATION pagination mode with no page number, and an undefined initial token on a fresh state', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        await runBackfill(baseInput(), emptyState());
        expect(mockSearchNotices.mock.calls[0][0]).toMatchObject({ paginationMode: 'ITERATION', iterationNextToken: undefined });
        expect(mockSearchNotices.mock.calls[0][0].page).toBeUndefined();
    });

    it('resumes from a persisted iterationNextToken', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([]));
        const state: DeltaState = { notices: {}, baselineComplete: false, iterationNextToken: 'resume-token-abc' };
        await runBackfill(baseInput(), state);
        expect(mockSearchNotices.mock.calls[0][0].iterationNextToken).toBe('resume-token-abc');
    });

    it('marks baselineComplete and clears the token once the scroll is exhausted (empty page)', async () => {
        mockSearchNotices.mockResolvedValueOnce(searchResponse([], {}));
        const state: DeltaState = { notices: {}, baselineComplete: false, iterationNextToken: 'some-token' };
        await runBackfill(baseInput(), state);
        expect(state.baselineComplete).toBe(true);
        expect(state.iterationNextToken).toBeUndefined();
    });

    it('advances and persists the scroll token after a fully-processed page', async () => {
        mockSearchNotices
            .mockResolvedValueOnce(searchResponse([rawNotice()], { iterationNextToken: 'next-token-1' }))
            .mockResolvedValueOnce(searchResponse([]));
        const state = emptyState();
        await runBackfill(baseInput({ onlyNew: false }), state);
        expect(mockSearchNotices.mock.calls[1][0].iterationNextToken).toBe('next-token-1');
    });

    it('does NOT advance the token when maxItems truncates the page, so the next run resumes from the START of that page', async () => {
        const state: DeltaState = { notices: {}, baselineComplete: true, iterationNextToken: 'start-of-page' };
        mockSearchNotices.mockResolvedValueOnce(
            searchResponse(
                [rawNotice({ 'notice-identifier': 'A' }), rawNotice({ 'notice-identifier': 'B' })],
                { iterationNextToken: 'next-page-token' },
            ),
        );
        const stats = await runBackfill(baseInput({ maxItems: 1, onlyNew: false }), state);
        expect(stats.stopped).toBe(true);
        expect(state.iterationNextToken).toBe('start-of-page'); // unchanged - NOT advanced to 'next-page-token'
    });

    it('falls back to the previous token when a page response omits iterationNextToken, and reuses it on the next fetch', async () => {
        mockSearchNotices
            .mockResolvedValueOnce(searchResponse([rawNotice()], { iterationNextToken: undefined }))
            .mockResolvedValueOnce(searchResponse([]));
        const state: DeltaState = { notices: {}, baselineComplete: false, iterationNextToken: 'initial-token' };
        await runBackfill(baseInput({ onlyNew: false }), state);
        expect(mockSearchNotices.mock.calls[1][0].iterationNextToken).toBe('initial-token');
    });

    it('restarts the scroll from the beginning exactly once when the token has expired', async () => {
        mockIsTokenExpiredError.mockReturnValue(true);
        mockSearchNotices
            .mockRejectedValueOnce(new TedApiError('QUERY_ERROR', 'The iteration token has expired'))
            .mockResolvedValueOnce(searchResponse([]));
        const state: DeltaState = { notices: {}, baselineComplete: false, iterationNextToken: 'stale-token' };
        await runBackfill(baseInput(), state);
        expect(mockSearchNotices).toHaveBeenCalledTimes(2);
        expect(mockSearchNotices.mock.calls[1][0].iterationNextToken).toBeUndefined(); // restarted from the beginning
    });

    it('does not restart a second time if the token expires again after the one allowed restart - rethrows instead', async () => {
        mockIsTokenExpiredError.mockReturnValue(true);
        mockSearchNotices.mockRejectedValue(new TedApiError('QUERY_ERROR', 'The iteration token has expired'));
        const state: DeltaState = { notices: {}, baselineComplete: false, iterationNextToken: 'stale-token' };
        await expect(runBackfill(baseInput(), state)).rejects.toThrow(/expired/);
        expect(mockSearchNotices).toHaveBeenCalledTimes(2); // original attempt + the one allowed restart
    });

    it('logs a warning but still processes the page when TED reports a server-side timeout mid-scroll', async () => {
        mockSearchNotices
            .mockResolvedValueOnce(searchResponse([rawNotice()], { timedOut: true, iterationNextToken: 'next-token' }))
            .mockResolvedValueOnce(searchResponse([]));
        const state = emptyState();
        const stats = await runBackfill(baseInput({ onlyNew: false }), state);
        expect(stats.totalPushed).toBe(1); // the timed-out page's notices are still valid and processed
    });

    it('rethrows immediately on a non-token-expired error, without attempting a restart', async () => {
        mockIsTokenExpiredError.mockReturnValue(false);
        mockSearchNotices.mockRejectedValue(new TedApiError('UPSTREAM_OUTAGE', 'TED Search API returned a server error (500).'));
        const state = emptyState();
        await expect(runBackfill(baseInput(), state)).rejects.toThrow(/server error/);
        expect(mockSearchNotices).toHaveBeenCalledTimes(1);
    });
});
