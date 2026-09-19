import { describe, expect, it } from 'vitest';

import {
    classify,
    computeContentFingerprint,
    computeStatusFingerprint,
    firstString,
    normalizeNotice,
    shouldDeliver,
    stringArray,
    toStoredFingerprint,
} from '../src/deltaEngine.js';
import type { DeltaState, RawNotice } from '../src/types.js';

/**
 * A real-shaped raw notice matching TED's actual `POST /v3/notices/search` envelope (per
 * types.ts's TedFieldValue doc comment and tedClient.ts's DEFAULT_FIELDS list) - loosely modeled
 * on the real award example cited in deltaEngine.ts's own comments (599727-2026, a single-lot
 * German geotechnical-services award reporting its amount only at result-value-notice).
 */
function rawNotice(overrides: Partial<RawNotice> = {}): RawNotice {
    return {
        'notice-identifier': '24-599727-2026',
        'publication-number': '00599727-2026',
        'publication-date': '2026-08-15+02:00',
        'notice-title': { eng: 'Geotechnical investigation services for the A61 motorway extension' },
        'buyer-name': { eng: 'Landesbetrieb Straßenbau NRW' },
        'organisation-country-buyer': 'DEU',
        'classification-cpv': ['71332000', '71332000', '71351910'],
        'deadline-receipt-tender-date-lot': ['2026-09-30+02:00'],
        'procedure-type': 'open',
        'estimated-value-lot': ['185000.00'],
        'estimated-value-cur-lot': ['EUR'],
        'result-value-notice': ['104290.00'],
        'result-value-cur-notice': 'EUR',
        'winner-identifier': ['DE123456789'],
        'winner-country': ['DEU'],
        'winner-size': ['SME'],
        links: {
            htmlDirect: { ENG: 'https://ted.europa.eu/en/notice/-/detail/599727-2026' },
        },
        ...overrides,
    };
}

function emptyState(): DeltaState {
    return { notices: {}, baselineComplete: false };
}

describe('firstString', () => {
    it('returns null for undefined', () => {
        expect(firstString(undefined)).toBeNull();
    });

    it('returns null for an empty string', () => {
        expect(firstString('')).toBeNull();
    });

    it('returns a plain string as-is', () => {
        expect(firstString('open')).toBe('open');
    });

    it('returns the first element of a string array', () => {
        expect(firstString(['DE123456789', 'DE987654321'])).toBe('DE123456789');
    });

    it('returns null for an empty array', () => {
        expect(firstString([])).toBeNull();
    });

    it('returns null when the first element of a string array is an empty-string placeholder', () => {
        // Defense-in-depth: if TED ever returns an array-valued field with a leading empty-string
        // element, this must fall through to null the same way the plain-string branch already
        // does above - not silently accept '' as a valid value that firstNumber() would then
        // coerce into a fabricated 0 downstream.
        expect(firstString(['', 'DE987654321'])).toBeNull();
    });

    it('resolves a real `{ lang: string }` i18n map (confirmed live shape for notice-title) preferring eng', () => {
        expect(firstString({ eng: 'Title text', deu: 'Titeltext' })).toBe('Title text');
    });

    it('falls back to any available language when eng is absent', () => {
        expect(firstString({ fra: 'Texte français' })).toBe('Texte français');
    });

    it('resolves a real `{ lang: string[] }` i18n map (documented spec shape for other fields) to its first element - the exact regression this function documents fixing', () => {
        // A prior version of this function assumed array-shaped i18n values and indexed with
        // [0] on the STRING case too, which returned the first CHARACTER instead. This asserts
        // the full string is returned, not just its first character ("T").
        expect(firstString({ eng: ['Two-stage restricted procedure'] })).toBe('Two-stage restricted procedure');
    });

    it('returns null for an i18n map whose resolved language value is an empty array', () => {
        expect(firstString({ eng: [] })).toBeNull();
    });

    it('returns null for a completely empty i18n map', () => {
        expect(firstString({})).toBeNull();
    });

    it('returns null when the i18n map resolves to an empty string for the chosen language', () => {
        expect(firstString({ eng: '' })).toBeNull();
    });
});

describe('stringArray', () => {
    it('returns an empty array for undefined', () => {
        expect(stringArray(undefined)).toEqual([]);
    });

    it('wraps a plain string in a single-element array', () => {
        expect(stringArray('open')).toEqual(['open']);
    });

    it('returns a string array unchanged', () => {
        expect(stringArray(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('filters out non-string entries, e.g. a real boolean[] field value', () => {
        expect(stringArray([true, false])).toEqual([]);
    });

    it('flattens a real i18n map (mixed scalar and array language values) into one flat array', () => {
        expect(stringArray({ eng: 'x', fra: ['y', 'z'] })).toEqual(['x', 'y', 'z']);
    });
});

describe('normalizeNotice', () => {
    it('throws a descriptive error when notice-identifier is missing - never fabricates a record identity', () => {
        expect(() => normalizeNotice(rawNotice({ 'notice-identifier': undefined }))).toThrow(/notice-identifier/);
    });

    it('maps a real award notice into the normalized envelope', () => {
        const notice = normalizeNotice(rawNotice());
        expect(notice.noticeIdentifier).toBe('24-599727-2026');
        expect(notice.publicationNumber).toBe('00599727-2026');
        expect(notice.noticeTitle).toBe('Geotechnical investigation services for the A61 motorway extension');
        expect(notice.buyerName).toBe('Landesbetrieb Straßenbau NRW');
        expect(notice.buyerCountry).toBe('DEU');
        expect(notice.procedureType).toBe('open');
        expect(notice.estimatedValue).toBe(185000);
        expect(notice.estimatedValueCurrency).toBe('EUR');
        expect(notice.winnerIdentifier).toBe('DE123456789');
        expect(notice.winnerCountry).toBe('DEU');
        expect(notice.winnerSize).toBe('SME');
        expect(notice.sourceUrl).toBe('https://ted.europa.eu/en/notice/-/detail/599727-2026');
    });

    it('deduplicates and sorts repeated CPV codes (a notice with several lots sharing a code repeats it once per lot on the real API)', () => {
        const notice = normalizeNotice(rawNotice({ 'classification-cpv': ['71351910', '71332000', '71332000'] }));
        expect(notice.cpvCodes).toEqual(['71332000', '71351910']);
    });

    it('falls back to organisation-name-buyer when buyer-name is absent', () => {
        const notice = normalizeNotice(rawNotice({ 'buyer-name': undefined, 'organisation-name-buyer': { eng: 'Org Buyer Name' } }));
        expect(notice.buyerName).toBe('Org Buyer Name');
    });

    it('prefers the more specific per-lot award amount (result-value-lot) over the notice-aggregate figure when both are present', () => {
        const notice = normalizeNotice(rawNotice({ 'result-value-lot': ['50000.00'] }));
        expect(notice.awardedValue).toBe(50000);
    });

    it('falls back to result-value-notice when result-value-lot is absent (real, live-tested case: 599727-2026 reports only the notice-aggregate figure)', () => {
        const notice = normalizeNotice(rawNotice({ 'result-value-lot': undefined, 'result-value-notice': ['104290.00'] }));
        expect(notice.awardedValue).toBe(104290);
    });

    it('parses a non-numeric estimated value as null rather than NaN', () => {
        const notice = normalizeNotice(rawNotice({ 'estimated-value-lot': ['not-a-number'] }));
        expect(notice.estimatedValue).toBeNull();
    });

    it('falls back to the TED website base URL when no links field is present at all', () => {
        const notice = normalizeNotice(rawNotice({ links: undefined }));
        expect(notice.sourceUrl).toBe('https://ted.europa.eu');
    });

    it('falls back to the html link map when htmlDirect is absent', () => {
        const notice = normalizeNotice(rawNotice({ links: { html: { ENG: 'https://ted.europa.eu/en/notice/-/detail/000-2026' } } }));
        expect(notice.sourceUrl).toBe('https://ted.europa.eu/en/notice/-/detail/000-2026');
    });

    it('falls back to a lowercase "eng" key when "ENG" is absent', () => {
        const notice = normalizeNotice(rawNotice({ links: { htmlDirect: { eng: 'https://ted.europa.eu/en/notice/-/detail/lower-2026' } } }));
        expect(notice.sourceUrl).toBe('https://ted.europa.eu/en/notice/-/detail/lower-2026');
    });

    it('falls back to any available language link when neither ENG nor eng is present', () => {
        const notice = normalizeNotice(rawNotice({ links: { htmlDirect: { fra: 'https://ted.europa.eu/fr/notice/-/detail/fra-2026' } } }));
        expect(notice.sourceUrl).toBe('https://ted.europa.eu/fr/notice/-/detail/fra-2026');
    });

    it('falls back to the TED website base URL when the resolved link value is an empty string, not a usable URL', () => {
        const notice = normalizeNotice(rawNotice({ links: { htmlDirect: { ENG: '' } } }));
        expect(notice.sourceUrl).toBe('https://ted.europa.eu');
    });

    it('keeps only the first lot value in the display scalar, but retains every lot in rawLotValues', () => {
        const notice = normalizeNotice(rawNotice({ 'estimated-value-lot': ['100.00', '200.00'] }));
        expect(notice.estimatedValue).toBe(100);
        expect(notice.rawLotValues.estimatedValues).toEqual(['100.00', '200.00']);
    });

    it('detects a content change caused only by a NON-first lot value, invisible to the display scalar alone', () => {
        // This is the exact behavior rawLotValues exists for (see NormalizedNotice's doc comment):
        // the display scalar (first lot only) is unchanged, but the fingerprint must still change.
        const a = normalizeNotice(rawNotice({ 'estimated-value-lot': ['100.00', '200.00'] }));
        const b = normalizeNotice(rawNotice({ 'estimated-value-lot': ['100.00', '999.00'] }));
        expect(a.estimatedValue).toBe(b.estimatedValue);
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });
});

describe('computeContentFingerprint', () => {
    it('is deterministic - the same normalized notice hashes identically every time', () => {
        const notice = normalizeNotice(rawNotice());
        expect(computeContentFingerprint(notice)).toBe(computeContentFingerprint(notice));
        expect(computeContentFingerprint(normalizeNotice(rawNotice()))).toBe(computeContentFingerprint(normalizeNotice(rawNotice())));
    });

    it('produces a real 64-character hex SHA-256 digest', () => {
        const fingerprint = computeContentFingerprint(normalizeNotice(rawNotice()));
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when real notice content changes (title)', () => {
        const a = normalizeNotice(rawNotice());
        const b = normalizeNotice(rawNotice({ 'notice-title': { eng: 'A completely different title' } }));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });

    it('is unaffected by noticeIdentifier alone, since it is deliberately excluded from the content hash', () => {
        const a = normalizeNotice(rawNotice({ 'notice-identifier': '24-000001-2026' }));
        const b = normalizeNotice(rawNotice({ 'notice-identifier': '24-000002-2026' }));
        expect(computeContentFingerprint(a)).toBe(computeContentFingerprint(b));
    });

    it('is unaffected by sourceUrl alone, since it is deliberately excluded from the content hash', () => {
        const a = normalizeNotice(rawNotice({ links: { htmlDirect: { ENG: 'https://ted.europa.eu/en/notice/-/detail/a-2026' } } }));
        const b = normalizeNotice(rawNotice({ links: { htmlDirect: { ENG: 'https://ted.europa.eu/en/notice/-/detail/b-2026' } } }));
        expect(computeContentFingerprint(a)).toBe(computeContentFingerprint(b));
    });
});

describe('computeStatusFingerprint', () => {
    it('is unaffected by a non-status field change (buyerName), even though the content fingerprint does change', () => {
        const a = normalizeNotice(rawNotice());
        const b = normalizeNotice(rawNotice({ 'buyer-name': { eng: 'A completely different buyer' } }));
        expect(computeStatusFingerprint(a)).toBe(computeStatusFingerprint(b));
        expect(computeContentFingerprint(a)).not.toBe(computeContentFingerprint(b));
    });

    it('is unaffected by winnerCountry/winnerSize, which are not in the narrow status-relevant subset', () => {
        const a = normalizeNotice(rawNotice());
        const b = normalizeNotice(rawNotice({ 'winner-country': ['FRA'], 'winner-size': ['LARGE'] }));
        expect(computeStatusFingerprint(a)).toBe(computeStatusFingerprint(b));
    });

    it('changes when winnerIdentifier changes - a genuine buyer-escalation-relevant status field', () => {
        const a = normalizeNotice(rawNotice({ 'winner-identifier': ['DE111111111'] }));
        const b = normalizeNotice(rawNotice({ 'winner-identifier': ['DE222222222'] }));
        expect(computeStatusFingerprint(a)).not.toBe(computeStatusFingerprint(b));
    });

    it('changes when awardedValue changes', () => {
        const a = normalizeNotice(rawNotice({ 'result-value-notice': ['104290.00'] }));
        const b = normalizeNotice(rawNotice({ 'result-value-notice': ['999999.00'] }));
        expect(computeStatusFingerprint(a)).not.toBe(computeStatusFingerprint(b));
    });
});

describe('classify', () => {
    it('classifies a never-before-seen notice as BASELINE_SNAPSHOT before the query baseline is complete', () => {
        const notice = normalizeNotice(rawNotice());
        const classified = classify(notice, emptyState());
        expect(classified.eventType).toBe('BASELINE_SNAPSHOT');
    });

    it('classifies a never-before-seen notice as NEW_NOTICE once the query baseline is complete', () => {
        const notice = normalizeNotice(rawNotice());
        const state: DeltaState = { notices: {}, baselineComplete: true };
        const classified = classify(notice, state);
        expect(classified.eventType).toBe('NEW_NOTICE');
    });

    it('classifies a seen-before notice with a changed content fingerprint as NOTICE_UPDATED', () => {
        const state = emptyState();
        const first = normalizeNotice(rawNotice());
        const firstClassified = classify(first, state);
        state.notices[first.noticeIdentifier] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');
        state.baselineComplete = true;

        const second = normalizeNotice(rawNotice({ 'procedure-type': 'restricted' }));
        const secondClassified = classify(second, state);
        expect(secondClassified.eventType).toBe('NOTICE_UPDATED');
    });

    it('classifies a seen-before, byte-for-byte-unchanged notice as NOTICE_UNCHANGED', () => {
        const state = emptyState();
        const first = normalizeNotice(rawNotice());
        const firstClassified = classify(first, state);
        state.notices[first.noticeIdentifier] = toStoredFingerprint(firstClassified, '2026-01-01T00:00:00.000Z');
        state.baselineComplete = true;

        const second = normalizeNotice(rawNotice());
        const secondClassified = classify(second, state);
        expect(secondClassified.eventType).toBe('NOTICE_UNCHANGED');
    });

    it('never mutates the passed-in state - committing the fingerprint is the caller\'s responsibility (recordSeen)', () => {
        const state = emptyState();
        const notice = normalizeNotice(rawNotice());
        classify(notice, state);
        expect(state.notices).toEqual({});
        expect(state.baselineComplete).toBe(false);
    });

    it('always reports an empty changedFields array (state stores fingerprints only, not full snapshots)', () => {
        const classified = classify(normalizeNotice(rawNotice()), emptyState());
        expect(classified.changedFields).toEqual([]);
    });

    it('returns statusFingerprint/contentFingerprint matching the standalone compute functions', () => {
        const notice = normalizeNotice(rawNotice());
        const classified = classify(notice, emptyState());
        expect(classified.contentFingerprint).toBe(computeContentFingerprint(notice));
        expect(classified.statusFingerprint).toBe(computeStatusFingerprint(notice));
    });
});

describe('shouldDeliver', () => {
    it('always delivers NEW_NOTICE regardless of onlyNew', () => {
        const state: DeltaState = { notices: {}, baselineComplete: true };
        const classified = classify(normalizeNotice(rawNotice()), state);
        expect(classified.eventType).toBe('NEW_NOTICE');
        expect(shouldDeliver(classified, true)).toBe(true);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('always delivers NOTICE_UPDATED regardless of onlyNew', () => {
        const state = emptyState();
        const first = classify(normalizeNotice(rawNotice()), state);
        state.notices[first.notice.noticeIdentifier] = toStoredFingerprint(first, '2026-01-01T00:00:00.000Z');
        state.baselineComplete = true;
        const updated = classify(normalizeNotice(rawNotice({ 'procedure-type': 'restricted' })), state);
        expect(updated.eventType).toBe('NOTICE_UPDATED');
        expect(shouldDeliver(updated, true)).toBe(true);
        expect(shouldDeliver(updated, false)).toBe(true);
    });

    it('delivers BASELINE_SNAPSHOT only when onlyNew is false', () => {
        const classified = classify(normalizeNotice(rawNotice()), emptyState());
        expect(classified.eventType).toBe('BASELINE_SNAPSHOT');
        expect(shouldDeliver(classified, true)).toBe(false);
        expect(shouldDeliver(classified, false)).toBe(true);
    });

    it('delivers NOTICE_UNCHANGED only when onlyNew is false', () => {
        const state = emptyState();
        const first = classify(normalizeNotice(rawNotice()), state);
        state.notices[first.notice.noticeIdentifier] = toStoredFingerprint(first, '2026-01-01T00:00:00.000Z');
        state.baselineComplete = true;
        const unchanged = classify(normalizeNotice(rawNotice()), state);
        expect(unchanged.eventType).toBe('NOTICE_UNCHANGED');
        expect(shouldDeliver(unchanged, true)).toBe(false);
        expect(shouldDeliver(unchanged, false)).toBe(true);
    });
});

describe('toStoredFingerprint', () => {
    it('carries statusFingerprint, contentFingerprint, and the given seenAt timestamp', () => {
        const classified = classify(normalizeNotice(rawNotice()), emptyState());
        const stored = toStoredFingerprint(classified, '2026-03-01T12:00:00.000Z');
        expect(stored).toEqual({
            statusFingerprint: classified.statusFingerprint,
            contentFingerprint: classified.contentFingerprint,
            lastSeen: '2026-03-01T12:00:00.000Z',
        });
    });
});
