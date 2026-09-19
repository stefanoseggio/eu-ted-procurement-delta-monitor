import { createHash } from 'node:crypto';

import type { ClassifiedEvent, DeltaState, EventType, NormalizedNotice, NoticeLinks, RawNotice, StoredFingerprint, TedFieldValue } from './types.js';

const TED_WEBSITE_BASE = 'https://ted.europa.eu';

/** Extracts a real per-notice deep link from TED's own `links` field - never a guessed URL pattern. */
function extractSourceUrl(links: NoticeLinks | undefined): string {
    const byLang = links?.htmlDirect ?? links?.html;
    if (byLang) {
        const preferred = byLang.ENG ?? byLang.eng ?? Object.values(byLang)[0];
        if (preferred) return preferred;
    }
    return TED_WEBSITE_BASE;
}

/**
 * Extracts a single display string from a TED field value, regardless of which real shape it
 * arrives in (see types.ts TedFieldValue for how these were confirmed): a plain string, a
 * string[] (first element), or an i18n map that is EITHER `{ lang: string }` (confirmed live
 * for `notice-title`) OR `{ lang: string[] }` (documented in the spec for other fields) - both
 * handled explicitly. A previous version of this function assumed the i18n value was always
 * array-shaped and indexed it with `[0]`; against a real `{ lang: string }` value that silently
 * returned the first CHARACTER of the string instead of the string itself (e.g. a real notice
 * title came back as `"F"`) - caught only by testing against TED's live API, not by
 * type-checking or linting, since both shapes satisfy TedFieldValue's type.
 */
export function firstString(value: TedFieldValue): string | null {
    if (value === undefined) return null;
    if (typeof value === 'string') return value.length > 0 ? value : null;
    if (Array.isArray(value)) {
        const [first] = value;
        if (typeof first === 'string') return first.length > 0 ? first : null;
        return null;
    }
    // i18n map: prefer English, then any available language.
    const preferred = value.eng ?? Object.values(value)[0];
    if (preferred === undefined) return null;
    if (typeof preferred === 'string') return preferred.length > 0 ? preferred : null;
    return preferred.length > 0 ? preferred[0] : null;
}

export function stringArray(value: TedFieldValue): string[] {
    if (value === undefined) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    return Object.values(value).flat();
}

function firstNumber(value: TedFieldValue): number | null {
    const str = firstString(value);
    if (str === null) return null;
    const parsed = Number(str);
    return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeNotice(raw: RawNotice): NormalizedNotice {
    const noticeIdentifier = firstString(raw['notice-identifier']);
    if (!noticeIdentifier) {
        throw new Error('TED notice response is missing notice-identifier - cannot track this record. Ensure "notice-identifier" is included in the fields input.');
    }

    return {
        noticeIdentifier,
        publicationNumber: firstString(raw['publication-number']),
        publicationDate: firstString(raw['publication-date']),
        noticeTitle: firstString(raw['notice-title']),
        buyerName: firstString(raw['buyer-name']) ?? firstString(raw['organisation-name-buyer']),
        buyerCountry: firstString(raw['organisation-country-buyer']),
        // TED's real response can list the same CPV code multiple times (confirmed live - a
        // notice with several lots that share a code repeats it once per lot) - deduplicated
        // here since it's not meaningful signal and would otherwise pollute both the output and
        // the content fingerprint with lot-count noise unrelated to the classification itself.
        cpvCodes: Array.from(new Set(stringArray(raw['classification-cpv']))).sort(),
        submissionDeadline: firstString(raw['deadline-receipt-tender-date-lot']),
        procedureType: firstString(raw['procedure-type']),
        estimatedValue: firstNumber(raw['estimated-value-lot']),
        estimatedValueCurrency: firstString(raw['estimated-value-cur-lot']),
        // See NormalizedNotice.rawLotValues: TED's '-lot' fields are genuinely multi-valued on a
        // multi-lot notice, but the scalars above only show the first lot for display. Keeping
        // the full arrays here (fed into the content fingerprint via hashableFields) means a
        // change to a NON-first lot's value is still detected as a real content change instead
        // of being silently invisible to the delta engine.
        rawLotValues: {
            estimatedValues: stringArray(raw['estimated-value-lot']),
            estimatedValueCurrencies: stringArray(raw['estimated-value-cur-lot']),
            submissionDeadlines: stringArray(raw['deadline-receipt-tender-date-lot']),
        },
        // TED's real per-lot award amount (result-value-lot) is only populated for some
        // notices - a live-tested real award notice (599727-2026, a single-lot German
        // geotechnical-services award) reported its amount only at the notice-aggregate level
        // (result-value-notice = "104290.00"), with result-value-lot absent entirely. Both are
        // requested and the more specific per-lot figure is preferred when present.
        awardedValue: firstNumber(raw['result-value-lot']) ?? firstNumber(raw['result-value-notice']),
        awardedValueCurrency: firstString(raw['result-value-cur-notice']),
        winnerIdentifier: firstString(raw['winner-identifier']),
        winnerCountry: firstString(raw['winner-country']),
        winnerSize: firstString(raw['winner-size']),
        sourceUrl: extractSourceUrl(raw.links),
    };
}

/**
 * Recursive key-sort canonicalization (ARCHITECTURE.md section 1.2). A flat, top-level-only
 * sort would silently under-canonicalize any nested structure - this notice shape has none
 * left after normalizeNotice flattens TED's raw i18n/array shapes, but the function is written
 * generically (rather than assuming flatness) so it stays correct if a future field addition
 * reintroduces nesting.
 */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => [key, canonicalize(val)] as const);
        return Object.fromEntries(sortedEntries);
    }
    return value;
}

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/** The narrow, buyer-escalation-relevant subset of fields (ARCHITECTURE.md section 1.1). */
function statusRelevantFields(notice: NormalizedNotice) {
    return {
        procedureType: notice.procedureType,
        submissionDeadline: notice.submissionDeadline,
        awardedValue: notice.awardedValue,
        awardedValueCurrency: notice.awardedValueCurrency,
        winnerIdentifier: notice.winnerIdentifier,
    };
}

/**
 * Excludes `noticeIdentifier` (the state key itself - constant per notice, contributes nothing)
 * and `sourceUrl` (TED's own link payload can vary in trivial ways, e.g. which language variant
 * is returned first, with zero change to the notice's actual procurement content - hashing it
 * would risk a false-positive, falsely-billed delta on a field that isn't real content).
 */
function hashableFields(notice: NormalizedNotice): Omit<NormalizedNotice, 'noticeIdentifier' | 'sourceUrl'> {
    const { noticeIdentifier: _id, sourceUrl: _url, ...rest } = notice;
    return rest;
}

export function computeContentFingerprint(notice: NormalizedNotice): string {
    return sha256(JSON.stringify(canonicalize(hashableFields(notice))));
}

export function computeStatusFingerprint(notice: NormalizedNotice): string {
    return sha256(JSON.stringify(canonicalize(statusRelevantFields(notice))));
}

/**
 * Classifies one notice against the persisted delta state (ARCHITECTURE.md section 2 - the
 * zero-cost no-change guarantee). This function determines the notice's TRUE event type only -
 * it deliberately does not know about `onlyNew`. Whether a given event type is actually
 * delivered (pushed + charged) is a separate decision, made by `shouldDeliver` below - the same
 * classify/filter separation already shipped in singapore-acra-registry-monitor's
 * classify()/shouldDeliver() pair. Conflating the two here previously produced a real bug: a
 * ternary that made a not-yet-baselined actor report `onlyNew=false` runs as permanently stuck
 * on BASELINE_SNAPSHOT even after the baseline completed. Never mutates `state` - the caller
 * commits the new fingerprint only after a successful, non-charge-limited push, mirroring the
 * crash-safety invariant already shipped in singapore-acra-registry-monitor's main.ts.
 */
export function classify(notice: NormalizedNotice, state: DeltaState): ClassifiedEvent {
    const contentFingerprint = computeContentFingerprint(notice);
    const statusFingerprint = computeStatusFingerprint(notice);
    const previous = state.notices[notice.noticeIdentifier];

    let eventType: EventType;
    if (!previous) {
        eventType = state.baselineComplete ? 'NEW_NOTICE' : 'BASELINE_SNAPSHOT';
    } else if (previous.contentFingerprint !== contentFingerprint) {
        eventType = 'NOTICE_UPDATED';
    } else {
        eventType = 'NOTICE_UNCHANGED';
    }

    return {
        notice,
        eventType,
        // The stored state only keeps fingerprints, not the full previous notice (state-size
        // discipline - this actor can track tens of thousands of notices per query, and storing
        // full snapshots would multiply the Key-Value Store payload for no benefit most callers
        // need). `changed_fields` is therefore reported as "this notice's content changed"
        // rather than a reconstructed field-by-field before/after this actor does not retain.
        changedFields: [],
        statusFingerprint,
        contentFingerprint,
    };
}

/**
 * Delivery filter, kept separate from classify() (see above). NEW_NOTICE and NOTICE_UPDATED are
 * always delivered - they are the two charged, buyer-relevant tiers (ARCHITECTURE.md section 2).
 * BASELINE_SNAPSHOT and NOTICE_UNCHANGED are only delivered when `onlyNew` is false, matching
 * this fleet's standard "onlyNew" convention (see singapore-acra-registry-monitor's
 * deliveryFilter.ts).
 */
export function shouldDeliver(classified: ClassifiedEvent, onlyNew: boolean): boolean {
    if (classified.eventType === 'NEW_NOTICE' || classified.eventType === 'NOTICE_UPDATED') return true;
    return !onlyNew;
}

export function toStoredFingerprint(classified: ClassifiedEvent, seenAt: string): StoredFingerprint {
    return {
        statusFingerprint: classified.statusFingerprint,
        contentFingerprint: classified.contentFingerprint,
        lastSeen: seenAt,
    };
}
