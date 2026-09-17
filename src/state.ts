import { Actor } from 'apify';

import type { DeltaState, StoredFingerprint } from './types.js';

/** Mirrors this fleet's `deltaStateName` convention: scope the KV store name per schedule/query. */
export function stateStoreName(deltaStateName: string): string {
    return `TED-DELTA-STATE-${deltaStateName}`;
}

const STATE_KEY = 'STATE';

export async function loadState(storeName: string, resetState: boolean): Promise<DeltaState> {
    if (resetState) {
        return { notices: {}, baselineComplete: false };
    }
    const store = await Actor.openKeyValueStore(storeName);
    const stored = await store.getValue<DeltaState>(STATE_KEY);
    return stored ?? { notices: {}, baselineComplete: false };
}

export async function saveState(storeName: string, state: DeltaState): Promise<void> {
    const store = await Actor.openKeyValueStore(storeName);
    await store.setValue(STATE_KEY, state);
}

export function recordSeen(state: DeltaState, noticeIdentifier: string, fingerprint: StoredFingerprint): void {
    // `state` is an explicit mutable accumulator passed in by design, mirroring the same
    // pattern already used in this fleet's other delta-tracking actors (e.g.
    // singapore-acra-registry-monitor's `seen` accumulator).
    // eslint-disable-next-line no-param-reassign
    state.notices[noticeIdentifier] = fingerprint;
}
