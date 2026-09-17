import { Actor, log } from 'apify';

import { runBackfill, runIncremental, runValidateQuery } from './routes.js';
import { loadState, saveState, stateStoreName } from './state.js';
import type { ActorInput } from './types.js';
import { TedApiError } from './types.js';

await Actor.init();
await run();
await Actor.exit();

async function run(): Promise<void> {
    const input = await Actor.getInput<ActorInput>();
    if (!input?.expertQuery) {
        throw new Error('expertQuery is required. See the input schema description for how to build and validate one via TED\'s own Expert Search page.');
    }

    const operationMode = input.operationMode ?? 'VALIDATE_QUERY';
    log.info(`Starting run: operationMode=${operationMode}, scope=${input.scope ?? 'ALL'}, deltaStateName=${input.deltaStateName ?? 'default'}.`);

    if (operationMode === 'VALIDATE_QUERY') {
        await runValidateQuery(input);
        return;
    }

    const storeName = stateStoreName(input.deltaStateName ?? 'default');
    const state = await loadState(storeName, input.resetState ?? false);

    // Apify's platform can send 'migrating' (worker reassignment - the SDK's default
    // `gracefulShutdown` then calls `Actor.reboot()`) or 'aborting' (the SDK then calls
    // `Actor.exit()`) at any point during a long run - confirmed real in the installed `apify`
    // package's own actor.d.ts. Neither is a JS exception, so the try/catch below never runs for
    // either, and without flushing this run's in-memory `state` (fingerprints + BACKFILL scroll
    // token) here, the SDK's default reboot/exit would proceed without ever persisting it - the
    // next run would reload stale state and RE-CHARGE every notice already pushed this run
    // (and, for BACKFILL, restart the scroll from a stale token). The SDK awaits registered event
    // handlers before actually rebooting/exiting, so an async handler here is honored, not raced.
    const flushState = async (): Promise<void> => {
        try {
            await saveState(storeName, state);
        } catch (error) {
            log.error(`Failed to flush state during shutdown: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    Actor.on('migrating', flushState);
    Actor.on('aborting', flushState);

    try {
        const stats = operationMode === 'BACKFILL' ? await runBackfill(input, state) : await runIncremental(input, state);
        log.info(`Run complete. Pushed ${stats.totalPushed} record(s): ${Object.entries(stats.byEventType).map(([type, count]) => `${type}=${count}`).join(', ') || 'none'}. Baseline complete: ${state.baselineComplete}.`);
    } catch (error) {
        if (error instanceof TedApiError) {
            log.error(`TED API call failed (${error.failureClass}): ${error.message}`);
        }
        // State is saved below in the `finally`-equivalent path regardless of success/failure,
        // so progress already made this run (fingerprints recorded, scroll token advanced) is
        // never lost to a later transient failure - only the failing page's own notices are
        // re-evaluated on the next run.
        await saveState(storeName, state);
        throw error;
    } finally {
        Actor.off('migrating', flushState);
        Actor.off('aborting', flushState);
    }

    await saveState(storeName, state);
}
