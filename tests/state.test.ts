import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeltaState } from '../src/types.js';

const storeData = new Map<string, unknown>();
const mockStore = {
    getValue: vi.fn(async (key: string) => storeData.get(key) ?? null),
    setValue: vi.fn(async (key: string, value: unknown) => {
        storeData.set(key, value);
    }),
};

vi.mock('apify', () => ({
    Actor: { openKeyValueStore: vi.fn(async () => mockStore) },
}));

const { loadState, recordSeen, saveState, stateStoreName } = await import('../src/state.js');

afterEach(() => {
    storeData.clear();
    vi.clearAllMocks();
});

describe('stateStoreName', () => {
    it('scopes the KV store name by deltaStateName, matching this fleet\'s convention', () => {
        expect(stateStoreName('default')).toBe('TED-DELTA-STATE-default');
        expect(stateStoreName('weekly-cpv72')).toBe('TED-DELTA-STATE-weekly-cpv72');
    });
});

describe('loadState / saveState', () => {
    it('returns an empty, not-yet-baselined state when nothing has been saved yet', async () => {
        const state = await loadState('test-store', false);
        expect(state).toEqual({ notices: {}, baselineComplete: false });
    });

    it('returns a fresh empty state (never a stale one) when resetState is true, even if something was previously saved', async () => {
        await saveState('test-store', {
            notices: { '24-599727-2026': { statusFingerprint: 'a', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' } },
            baselineComplete: true,
        });
        const state = await loadState('test-store', true);
        expect(state).toEqual({ notices: {}, baselineComplete: false });
    });

    it('round-trips a real state object, including the BACKFILL scroll token, through save and load', async () => {
        const original: DeltaState = {
            notices: {
                '24-599727-2026': { statusFingerprint: 'sf1', contentFingerprint: 'cf1', lastSeen: '2026-01-01T00:00:00.000Z' },
            },
            iterationNextToken: 'scroll-token-xyz',
            baselineComplete: true,
        };
        await saveState('test-store', original);
        const loaded = await loadState('test-store', false);
        expect(loaded).toEqual(original);
    });

    it('does not hit the KV store at all when resetState is true - a fresh state is synthesized directly', async () => {
        await loadState('test-store', true);
        expect(mockStore.getValue).not.toHaveBeenCalled();
    });
});

describe('recordSeen', () => {
    it('mutates the given state object in place, keyed by noticeIdentifier', () => {
        const state: DeltaState = { notices: {}, baselineComplete: false };
        recordSeen(state, '24-599727-2026', { statusFingerprint: 'sf', contentFingerprint: 'cf', lastSeen: '2026-01-01T00:00:00.000Z' });
        expect(state.notices['24-599727-2026']).toEqual({ statusFingerprint: 'sf', contentFingerprint: 'cf', lastSeen: '2026-01-01T00:00:00.000Z' });
    });

    it('overwrites a previous fingerprint for the same notice rather than accumulating history', () => {
        const state: DeltaState = { notices: {}, baselineComplete: false };
        recordSeen(state, 'x', { statusFingerprint: 'v1', contentFingerprint: 'v1', lastSeen: '2026-01-01T00:00:00.000Z' });
        recordSeen(state, 'x', { statusFingerprint: 'v2', contentFingerprint: 'v2', lastSeen: '2026-01-02T00:00:00.000Z' });
        expect(state.notices.x.statusFingerprint).toBe('v2');
        expect(Object.keys(state.notices)).toHaveLength(1);
    });

    it('tracks each notice independently - recording one does not affect another', () => {
        const state: DeltaState = { notices: {}, baselineComplete: false };
        recordSeen(state, 'A', { statusFingerprint: 'a', contentFingerprint: 'a', lastSeen: '2026-01-01T00:00:00.000Z' });
        recordSeen(state, 'B', { statusFingerprint: 'b', contentFingerprint: 'b', lastSeen: '2026-01-01T00:00:00.000Z' });
        expect(state.notices.A.statusFingerprint).toBe('a');
        expect(state.notices.B.statusFingerprint).toBe('b');
    });
});
