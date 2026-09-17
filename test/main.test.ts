import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockExit = vi.fn().mockResolvedValue(undefined);
const mockGetInput = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarning = vi.fn();
const mockLogError = vi.fn();

vi.mock('apify', () => ({
    Actor: {
        init: mockInit,
        exit: mockExit,
        getInput: mockGetInput,
        on: mockOn,
        off: mockOff,
    },
    log: { info: mockLogInfo, warning: mockLogWarning, error: mockLogError },
}));

const mockRunValidateQuery = vi.fn();
const mockRunIncremental = vi.fn();
const mockRunBackfill = vi.fn();
vi.mock('../src/routes.js', () => ({
    runValidateQuery: (...args: unknown[]) => mockRunValidateQuery(...args),
    runIncremental: (...args: unknown[]) => mockRunIncremental(...args),
    runBackfill: (...args: unknown[]) => mockRunBackfill(...args),
}));

const mockLoadState = vi.fn();
const mockSaveState = vi.fn();
vi.mock('../src/state.js', () => ({
    loadState: (...args: unknown[]) => mockLoadState(...args),
    saveState: (...args: unknown[]) => mockSaveState(...args),
    stateStoreName: (name: string) => `TED-DELTA-STATE-${name}`,
}));

function handlerFor(event: string): () => Promise<void> {
    const call = mockOn.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`No handler registered for '${event}'`);
    return call[1] as () => Promise<void>;
}

beforeEach(() => {
    vi.resetModules();
    mockInit.mockClear();
    mockExit.mockClear();
    mockGetInput.mockReset();
    mockOn.mockClear();
    mockOff.mockClear();
    mockLogInfo.mockClear();
    mockLogWarning.mockClear();
    mockLogError.mockClear();
    mockRunValidateQuery.mockReset();
    mockRunIncremental.mockReset();
    mockRunBackfill.mockReset();
    mockLoadState.mockReset();
    mockSaveState.mockReset().mockResolvedValue(undefined);

    mockGetInput.mockResolvedValue({ expertQuery: 'classification-cpv = 72*', operationMode: 'INCREMENTAL' });
    mockLoadState.mockResolvedValue({ notices: {}, baselineComplete: false });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('main.ts input validation', () => {
    it('throws when expertQuery is missing, before ever touching state or Actor.exit', async () => {
        mockGetInput.mockResolvedValue({ operationMode: 'INCREMENTAL' });

        await expect(import('../src/main.js')).rejects.toThrow(/expertQuery is required/);
        expect(mockInit).toHaveBeenCalledTimes(1); // init still ran - the throw happens inside run()
        expect(mockExit).not.toHaveBeenCalled();
        expect(mockLoadState).not.toHaveBeenCalled();
        expect(mockOn).not.toHaveBeenCalled();
    });

    it('throws when getInput resolves to null entirely', async () => {
        mockGetInput.mockResolvedValue(null);
        await expect(import('../src/main.js')).rejects.toThrow(/expertQuery is required/);
    });
});

describe('main.ts operation-mode dispatch', () => {
    it('defaults to VALIDATE_QUERY when operationMode is omitted, and never touches delta state at all', async () => {
        mockGetInput.mockResolvedValue({ expertQuery: 'classification-cpv = 72*' });
        mockRunValidateQuery.mockResolvedValue(undefined);

        await import('../src/main.js');

        expect(mockRunValidateQuery).toHaveBeenCalledTimes(1);
        expect(mockRunIncremental).not.toHaveBeenCalled();
        expect(mockRunBackfill).not.toHaveBeenCalled();
        expect(mockLoadState).not.toHaveBeenCalled();
        expect(mockSaveState).not.toHaveBeenCalled();
        expect(mockOn).not.toHaveBeenCalled(); // no shutdown-safety wiring needed - nothing to flush
        expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('calls runIncremental (not runBackfill) for operationMode INCREMENTAL', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });
        await import('../src/main.js');
        expect(mockRunIncremental).toHaveBeenCalledTimes(1);
        expect(mockRunBackfill).not.toHaveBeenCalled();
    });

    it('calls runBackfill (not runIncremental) for operationMode BACKFILL', async () => {
        mockGetInput.mockResolvedValue({ expertQuery: 'classification-cpv = 72*', operationMode: 'BACKFILL' });
        mockRunBackfill.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });
        await import('../src/main.js');
        expect(mockRunBackfill).toHaveBeenCalledTimes(1);
        expect(mockRunIncremental).not.toHaveBeenCalled();
    });
});

describe('main.ts shutdown-safety wiring (INCREMENTAL/BACKFILL only)', () => {
    it('registers migrating and aborting handlers before running, and deregisters them after a successful run', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 1, stopped: false, byEventType: { NEW_NOTICE: 1 } });

        await import('../src/main.js');

        expect(mockOn).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOn).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function));
        expect(mockOff).toHaveBeenCalledWith('aborting', expect.any(Function));
        expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('the registered migrating handler actually flushes state when invoked - the exact regression this wiring exists to prevent', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockClear();
        await migratingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('the registered aborting handler also flushes state when invoked', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');
        const abortingHandler = handlerFor('aborting');

        mockSaveState.mockClear();
        await abortingHandler();

        expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('the shutdown handler does not throw even if saving state fails - a flush failure must not crash the shutdown path', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockRejectedValueOnce(new Error('KV store unavailable'));
        await expect(migratingHandler()).resolves.toBeUndefined();
        expect(mockLogError).toHaveBeenCalled();
    });

    it('formats a non-Error rejection (e.g. a rejected-with-string KV client) via String() rather than crashing on .message', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');
        const migratingHandler = handlerFor('migrating');

        mockSaveState.mockRejectedValueOnce('plain string failure, not an Error instance');
        await expect(migratingHandler()).resolves.toBeUndefined();
        expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('plain string failure, not an Error instance'));
    });

    it('saves state exactly once on success, after the handlers are deregistered', async () => {
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });
        await import('../src/main.js');
        expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('saves state even when the run fails, then rethrows - progress already made must not be lost to a later failure', async () => {
        mockRunIncremental.mockRejectedValue(new Error('simulated TED outage'));

        await expect(import('../src/main.js')).rejects.toThrow('simulated TED outage');

        expect(mockSaveState).toHaveBeenCalledTimes(1);
        expect(mockExit).not.toHaveBeenCalled(); // top-level `await run(); await Actor.exit();` never reaches exit() if run() rethrows
        expect(mockOff).toHaveBeenCalledWith('migrating', expect.any(Function)); // handlers are still deregistered via `finally`
    });

    it('logs a TED-specific error message when the failure is a TedApiError', async () => {
        const { TedApiError } = await import('../src/types.js');
        mockRunIncremental.mockRejectedValue(new TedApiError('UPSTREAM_OUTAGE', 'TED Search API returned a server error (503).'));

        await expect(import('../src/main.js')).rejects.toBeInstanceOf(TedApiError);
        expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('UPSTREAM_OUTAGE'));
    });

    it('defaults deltaStateName to "default" when not provided', async () => {
        mockGetInput.mockResolvedValue({ expertQuery: 'classification-cpv = 72*', operationMode: 'INCREMENTAL' });
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');

        expect(mockLoadState).toHaveBeenCalledWith('TED-DELTA-STATE-default', false);
    });

    it('scopes the store name by a custom deltaStateName and passes resetState through to loadState', async () => {
        mockGetInput.mockResolvedValue({ expertQuery: 'classification-cpv = 72*', operationMode: 'INCREMENTAL', deltaStateName: 'weekly-cpv72', resetState: true });
        mockRunIncremental.mockResolvedValue({ totalPushed: 0, stopped: false, byEventType: {} });

        await import('../src/main.js');

        expect(mockLoadState).toHaveBeenCalledWith('TED-DELTA-STATE-weekly-cpv72', true);
    });
});
