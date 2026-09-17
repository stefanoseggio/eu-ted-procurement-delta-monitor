import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';

import { classify, normalizeNotice, shouldDeliver, toStoredFingerprint } from './deltaEngine.js';
import { recordSeen } from './state.js';
import { checkQuerySyntax, isTokenExpiredError, searchNotices } from './tedClient.js';
import type { ActorInput, ClassifiedEvent, DeltaState, OutputRecord, RawNotice } from './types.js';
import { TedApiError } from './types.js';
import { notifyHighValueChange } from './webhookNotifier.js';

const TED_PAGINATION_LIMIT = 15_000;

// Two distinct pay-per-event names, matching the fleet's established two-tier pricing pattern
// (singapore-acra-registry-monitor's EVENT_RESULT/EVENT_RESULT_SUMMARY). A previous version of
// this actor funnelled both NEW_NOTICE and NOTICE_UPDATED through a single 'notice-change' event
// name, which would have made README.md's $0.02/$0.01 price differentiation impossible to
// actually configure in Apify's pay-per-event billing (billing is keyed by event name).
const EVENT_NEW_NOTICE = 'new-notice';
const EVENT_NOTICE_UPDATED = 'notice-updated';

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

/**
 * Resolves the real `fields` array sent to TED for a search call. Two real gaps this guards
 * against, found by adversarial review and confirmed live: (1) TED's API rejects an empty
 * `fields` array with a 400 (QUERY_ERROR) even for a real search - a user who deselects every
 * entry in the input's multi-select would otherwise abort the whole run; (2) `notice-identifier`
 * is not enum-locked as mandatory in the input schema, but normalizeNotice() hard-requires it
 * per notice - without it, every notice silently fails to normalize and the run "succeeds" with
 * zero pushed records, a worse failure mode than a crash. Falling back to DEFAULT_FIELDS and
 * force-including notice-identifier fixes both at the code level (not just the Console UI),
 * since this actor can also be called directly via the Apify API with an arbitrary input body.
 */
function resolveFields(input: ActorInput): string[] {
    const base = input.fields && input.fields.length > 0 ? input.fields : DEFAULT_FIELDS;
    return Array.from(new Set([...base, 'notice-identifier']));
}

interface RunStats {
    totalPushed: number;
    stopped: boolean;
    byEventType: Record<string, number>;
}

function computeEventId(classified: ClassifiedEvent): string {
    return createHash('sha1')
        .update(`${classified.notice.noticeIdentifier}|${classified.eventType}|${classified.statusFingerprint}|${classified.contentFingerprint}`)
        .digest('hex');
}

function toOutputRecord(classified: ClassifiedEvent, scrapedAt: string): OutputRecord {
    const { notice } = classified;
    return {
        '@type': 'schema:GovernmentPermit',
        event_id: computeEventId(classified),
        event_type: classified.eventType,
        record_id: notice.noticeIdentifier,
        notice_identifier: notice.noticeIdentifier,
        publication_number: notice.publicationNumber,
        publication_date: notice.publicationDate,
        notice_title: notice.noticeTitle,
        buyer_name: notice.buyerName,
        buyer_country: notice.buyerCountry,
        cpv_codes: notice.cpvCodes,
        submission_deadline: notice.submissionDeadline,
        procedure_type: notice.procedureType,
        estimated_value: notice.estimatedValue,
        estimated_value_currency: notice.estimatedValueCurrency,
        awarded_value: notice.awardedValue,
        awarded_value_currency: notice.awardedValueCurrency,
        winner_identifier: notice.winnerIdentifier,
        winner_country: notice.winnerCountry,
        winner_size: notice.winnerSize,
        changed_fields: classified.changedFields,
        status_fingerprint: classified.statusFingerprint,
        content_fingerprint: classified.contentFingerprint,
        is_new: classified.eventType === 'NEW_NOTICE' || classified.eventType === 'BASELINE_SNAPSHOT',
        source_url: notice.sourceUrl,
        scraped_at: scrapedAt,
    };
}

/** Returns the pay-per-event charge event name for a given classification, or undefined for uncharged deliveries. */
function eventNameFor(eventType: ClassifiedEvent['eventType']): string | undefined {
    switch (eventType) {
        case 'NEW_NOTICE':
            return EVENT_NEW_NOTICE;
        case 'NOTICE_UPDATED':
            return EVENT_NOTICE_UPDATED;
        default:
            return undefined; // BASELINE_SNAPSHOT / NOTICE_UNCHANGED - never charged, see README Pricing section
    }
}

/**
 * Is this update one a procurement-BD or compliance buyer would actually escalate on? See
 * ARCHITECTURE.md section 1.1/4. Fires only when the notice's STATUS-TIER fields (procedure
 * status, deadline, award value, winner identity - the same set hashed into statusFingerprint)
 * actually changed THIS event, not merely whenever those fields happen to be non-null - a
 * previous version checked only current-value presence, so a NOTICE_UPDATED caused by an
 * unrelated field (e.g. notice_title) with an already-populated awardedValue from a prior run
 * would incorrectly re-fire the webhook.
 */
function isHighValueChange(classified: ClassifiedEvent, previousStatusFingerprint: string | undefined): boolean {
    if (classified.eventType !== 'NEW_NOTICE' && classified.eventType !== 'NOTICE_UPDATED') return false;
    const hasStatusData = classified.notice.awardedValue !== null || classified.notice.winnerIdentifier !== null || classified.notice.procedureType !== null;
    if (!hasStatusData) return false;
    if (classified.eventType === 'NEW_NOTICE') return true;
    return previousStatusFingerprint !== classified.statusFingerprint;
}

/* eslint-disable no-param-reassign -- `state` and `stats` are explicit mutable accumulators
   passed in by design (see runIncremental/runBackfill), not incidental parameter mutation -
   mirrors the same pattern already shipped in singapore-acra-registry-monitor's main.ts. */
async function processPage(
    notices: RawNotice[],
    state: DeltaState,
    input: ActorInput,
    scrapedAt: string,
    stats: RunStats,
): Promise<void> {
    const onlyNew = input.onlyNew ?? true;
    for (const raw of notices) {
        let notice;
        try {
            notice = normalizeNotice(raw);
        } catch (error) {
            log.warning(`Skipping one notice that could not be normalized: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        // Captured before recordSeen() below overwrites this notice's stored fingerprint - the
        // only way to know whether THIS event actually changed the status-tier fields, not just
        // whether they're currently non-null (see isHighValueChange's doc comment).
        const previousStatusFingerprint = state.notices[notice.noticeIdentifier]?.statusFingerprint;
        const classified = classify(notice, state);

        if (!shouldDeliver(classified, onlyNew)) {
            recordSeen(state, notice.noticeIdentifier, toStoredFingerprint(classified, scrapedAt));
            continue;
        }

        const record = toOutputRecord(classified, scrapedAt);
        const eventName = eventNameFor(classified.eventType);
        const pushResult = eventName ? await Actor.pushData(record, eventName) : ({} as { eventChargeLimitReached?: boolean });
        if (!eventName) await Actor.pushData(record);

        stats.totalPushed += 1;
        stats.byEventType[classified.eventType] = (stats.byEventType[classified.eventType] ?? 0) + 1;

        if (input.webhookUrl && isHighValueChange(classified, previousStatusFingerprint)) {
            await notifyHighValueChange(input.webhookUrl, record);
        }

        // Only commit the new fingerprint for a row that was successfully pushed (or filtered
        // out above, before any charge risk) - mirrors singapore-acra-registry-monitor's
        // invariant that a record held back by a charge/item limit must remain eligible to be
        // correctly reclassified next run, not silently marked seen with a fingerprint it was
        // never billed for.
        recordSeen(state, notice.noticeIdentifier, toStoredFingerprint(classified, scrapedAt));

        if (pushResult.eventChargeLimitReached || (input.maxItems && stats.totalPushed >= input.maxItems)) {
            stats.stopped = true;
            return;
        }
    }
}
/* eslint-enable no-param-reassign */

export async function runValidateQuery(input: ActorInput): Promise<void> {
    log.info(`Validating expert query syntax against TED's real checkQuerySyntax pre-flight (no notices fetched, nothing charged): ${input.expertQuery}`);
    const result = await checkQuerySyntax(input.expertQuery);
    if (result.valid) {
        log.info('Query is syntactically valid. Switch operationMode to INCREMENTAL or BACKFILL to run it for real.');
    } else {
        log.warning(`Query is NOT valid: ${result.message}`);
    }
    await Actor.setValue('OUTPUT', { operationMode: 'VALIDATE_QUERY', query: input.expertQuery, valid: result.valid, message: result.message ?? null });
}

/* eslint-disable no-param-reassign -- `state` is an explicit mutable accumulator passed in by
   design (baselineComplete/iterationNextToken are updated in place across pages within one run),
   not incidental parameter mutation. */
export async function runIncremental(input: ActorInput, state: DeltaState): Promise<RunStats> {
    const scrapedAt = new Date().toISOString();
    const stats: RunStats = { totalPushed: 0, stopped: false, byEventType: {} };
    const limit = input.limit ?? 50;
    const fields = resolveFields(input);
    let page = 1;

    while (!stats.stopped) {
        if ((page - 1) * limit >= TED_PAGINATION_LIMIT) {
            log.info(`Reached TED's own pagination-mode cap of ${TED_PAGINATION_LIMIT} retrievable notices for this query. Switch operationMode to BACKFILL (uncapped ITERATION mode) to retrieve the full result set.`);
            break;
        }

        const response = await searchNotices({
            query: input.expertQuery,
            fields,
            page,
            limit,
            scope: input.scope ?? 'ALL',
            paginationMode: 'PAGE_NUMBER',
            onlyLatestVersions: input.onlyLatestVersions ?? false,
        });

        if (response.notices.length === 0) {
            state.baselineComplete = true;
            break;
        }

        if (response.timedOut) {
            log.warning("TED's own search backend reported a server-side timeout for this page (response.timedOut=true) - the returned notices are still valid, but this page's length is not a reliable end-of-results signal (see the `exhausted` check below).");
        }

        await processPage(response.notices, state, input, scrapedAt, stats);

        // Only mark the baseline complete when the result set was genuinely exhausted, not when
        // `stats.stopped` cut the walk short on `maxItems` - otherwise a maxItems-truncated run
        // would leave the remaining, never-actually-fetched backlog notices to be misclassified
        // as genuinely NEW_NOTICE (charged) in a later run, when they are really just
        // pre-existing notices this run never got to.
        if (stats.stopped) break;

        // `page * limit >= totalNoticeCount` is reliable regardless of timedOut (it's TED's own
        // count, unaffected by a short page). A short page (`notices.length < limit`) is NOT a
        // reliable end-of-results signal when `timedOut` is true - TED itself warns the page can
        // be truncated by a server-side timeout while more notices remain. Treating a timed-out
        // short page as "exhausted" would prematurely latch baselineComplete=true and cause
        // never-fetched backlog notices to be misclassified (and billed) as NEW_NOTICE later.
        const exhausted = page * limit >= response.totalNoticeCount || (!response.timedOut && response.notices.length < limit);
        if (exhausted) {
            state.baselineComplete = true;
            break;
        }
        page += 1;
    }

    return stats;
}

export async function runBackfill(input: ActorInput, state: DeltaState): Promise<RunStats> {
    const scrapedAt = new Date().toISOString();
    const stats: RunStats = { totalPushed: 0, stopped: false, byEventType: {} };
    const limit = input.limit ?? 50;
    const fields = resolveFields(input);
    let token = state.iterationNextToken;
    let restartedAfterExpiry = false;

    while (!stats.stopped) {
        let response;
        try {
            response = await searchNotices({
                query: input.expertQuery,
                fields,
                limit,
                scope: input.scope ?? 'ALL',
                paginationMode: 'ITERATION',
                onlyLatestVersions: input.onlyLatestVersions ?? false,
                iterationNextToken: token,
            });
        } catch (error) {
            if (error instanceof TedApiError && isTokenExpiredError(error) && !restartedAfterExpiry) {
                log.warning("BACKFILL scroll token expired (TED's point-in-time window is next OJ S release + 24h) - restarting the scroll from the beginning. Already-recorded notices are unaffected; only the scroll position resets.");
                token = undefined;
                restartedAfterExpiry = true;
                continue;
            }
            throw error;
        }

        if (response.notices.length === 0) {
            state.baselineComplete = true;
            state.iterationNextToken = undefined;
            break;
        }

        if (response.timedOut) {
            log.warning("TED's own search backend reported a server-side timeout for this page (response.timedOut=true) - the returned notices are still valid, but consider a narrower expertQuery if this recurs.");
        }

        await processPage(response.notices, state, input, scrapedAt, stats);

        // If maxItems/eventChargeLimitReached cut this page short, do NOT advance the scroll
        // token - `token` (and state.iterationNextToken) are left pointing at the START of THIS
        // page, so the next run re-requests it from the beginning instead of skipping the
        // unprocessed tail. TED's ITERATION token is forward-only: once advanced past a page,
        // that page's remaining notices can never be re-requested. Already-recorded notices in
        // this page will simply reclassify as NOTICE_UNCHANGED next run (harmless, no
        // double-charge - see the crash-safety invariant in processPage), while the
        // never-reached tail gets processed for the first time.
        if (stats.stopped) break;

        // Advance the scroll position to the token TED just returned for the NEXT page, and
        // persist it after every FULLY-processed page (not just at the end of the run) - if the
        // process is killed mid-BACKFILL, a restart resumes from the last completed page via the
        // persisted token instead of re-walking the whole query from scratch. ITERATION mode
        // makes this token mandatory in the response per the live spec, but the fallback keeps
        // the loop from silently stalling if that ever isn't true for a given page.
        token = response.iterationNextToken ?? token;
        state.iterationNextToken = token;
    }

    return stats;
}
/* eslint-enable no-param-reassign */
