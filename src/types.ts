export type OperationMode = 'VALIDATE_QUERY' | 'INCREMENTAL' | 'BACKFILL';

export type SearchScope = 'LATEST' | 'ACTIVE' | 'ALL';

export interface ActorInput {
    operationMode?: OperationMode;
    expertQuery: string;
    fields?: string[];
    scope?: SearchScope;
    onlyLatestVersions?: boolean;
    limit?: number;
    maxItems?: number;
    deltaStateName?: string;
    resetState?: boolean;
    onlyNew?: boolean;
    webhookUrl?: string;
}

/**
 * TED's real response shape for a single notice field, per the live OpenAPI spec
 * (`https://api.ted.europa.eu/api-v3.yaml`, schema `NoticeResponse`) AND per live-tested
 * responses: most fields are `string[]` or `boolean[]`, a minority are a plain scalar
 * `string`, and multilingual text fields are an i18n map keyed by ISO 639-2 language code -
 * but that i18n map is NOT uniformly array-valued. The OpenAPI spec documents
 * `option-description-lot`'s i18n shape as `{ lang: string[] }`, but a real live call
 * confirmed `notice-title` is actually `{ lang: string }` (a flat string per language, no
 * array wrapping) - two different real shapes for the same general "i18n field" concept.
 * Both are represented here; firstString() below handles both explicitly rather than
 * assuming one.
 */
export type TedFieldValue = string | string[] | boolean[] | Record<string, string | string[]> | undefined;

/**
 * The real `links` field, confirmed in the live spec: a per-notice map of format
 * (html/htmlDirect/pdf/pdfs/xml) to a language-code-keyed map of URLs. Distinct shape from
 * TedFieldValue, so kept as its own type rather than folded into that union.
 */
export interface NoticeLinks {
    html?: Record<string, string>;
    htmlDirect?: Record<string, string>;
    pdf?: Record<string, string>;
    pdfs?: Record<string, string>;
    xml?: Record<string, string>;
}

/** A single notice as returned by `POST /v3/notices/search` - a flat map keyed by requested field ID. */
export type RawNotice = Record<string, TedFieldValue> & { links?: NoticeLinks };

export interface TedSearchRequest {
    query: string;
    fields: string[];
    page?: number;
    limit: number;
    scope: SearchScope;
    checkQuerySyntax?: boolean;
    paginationMode: 'PAGE_NUMBER' | 'ITERATION';
    onlyLatestVersions: boolean;
    iterationNextToken?: string;
}

export interface TedSearchResponse {
    notices: RawNotice[];
    totalNoticeCount: number;
    /** Optional in PAGE_NUMBER mode, mandatory (per the live spec) in ITERATION mode. */
    iterationNextToken?: string;
    /** Real field confirmed in the live spec: true if TED's own search timed out server-side. */
    timedOut?: boolean;
}

export type EventType = 'NEW_NOTICE' | 'NOTICE_UPDATED' | 'NOTICE_UNCHANGED' | 'BASELINE_SNAPSHOT';

/** The normalized, human/analyst-friendly shape extracted from a RawNotice - what gets hashed and output. */
export interface NormalizedNotice {
    noticeIdentifier: string;
    publicationNumber: string | null;
    publicationDate: string | null;
    noticeTitle: string | null;
    buyerName: string | null;
    buyerCountry: string | null;
    cpvCodes: string[];
    submissionDeadline: string | null;
    procedureType: string | null;
    estimatedValue: number | null;
    estimatedValueCurrency: string | null;
    awardedValue: number | null;
    awardedValueCurrency: string | null;
    winnerIdentifier: string | null;
    winnerCountry: string | null;
    winnerSize: string | null;
    sourceUrl: string;
    /**
     * Full raw per-lot arrays for the fields above that TED can report per-lot (estimatedValue,
     * estimatedValueCurrency, submissionDeadline all read TED's '-lot'-suffixed fields, which are
     * genuinely multi-valued on a multi-lot notice). The scalar fields above show only the first
     * lot's value for display simplicity, but a change to any OTHER lot's value must still be
     * detectable as a real content change - these arrays exist purely so the content fingerprint
     * (deltaEngine.ts's hashableFields) is sensitive to every lot, not just the first. Not
     * surfaced in OutputRecord/dataset_schema.json; internal to change-detection only.
     */
    rawLotValues: { estimatedValues: string[]; estimatedValueCurrencies: string[]; submissionDeadlines: string[] };
}

export interface StoredFingerprint {
    statusFingerprint: string;
    contentFingerprint: string;
    lastSeen: string;
}

export interface DeltaState {
    /** Keyed by noticeIdentifier. */
    notices: Record<string, StoredFingerprint>;
    /** Only used in BACKFILL mode - the Elasticsearch point-in-time scroll token, persisted across runs. */
    iterationNextToken?: string;
    /** True once a BACKFILL (or the initial INCREMENTAL) run has observed this state's full query result at least once. */
    baselineComplete: boolean;
}

export interface ClassifiedEvent {
    notice: NormalizedNotice;
    eventType: EventType;
    changedFields: { field: string; previous: unknown; current: unknown }[];
    statusFingerprint: string;
    contentFingerprint: string;
}

export interface OutputRecord {
    '@type': 'schema:GovernmentPermit';
    event_id: string;
    event_type: EventType;
    record_id: string;
    notice_identifier: string;
    publication_number: string | null;
    publication_date: string | null;
    notice_title: string | null;
    buyer_name: string | null;
    buyer_country: string | null;
    cpv_codes: string[];
    submission_deadline: string | null;
    procedure_type: string | null;
    estimated_value: number | null;
    estimated_value_currency: string | null;
    awarded_value: number | null;
    awarded_value_currency: string | null;
    winner_identifier: string | null;
    winner_country: string | null;
    winner_size: string | null;
    changed_fields: { field: string; previous: unknown; current: unknown }[];
    status_fingerprint: string;
    content_fingerprint: string;
    is_new: boolean;
    source_url: string;
    scraped_at: string;
}

/** Real failure classes for api.ted.europa.eu, mirroring this fleet's outage-vs-defect separation pattern. */
export type TedFailureClass = 'UPSTREAM_OUTAGE' | 'QUERY_ERROR' | 'TOKEN_EXPIRED' | 'RATE_LIMITED';

export class TedApiError extends Error {
    constructor(
        public readonly failureClass: TedFailureClass,
        message: string,
        public readonly httpStatus?: number,
        public readonly responseBody?: unknown,
    ) {
        super(message);
        this.name = 'TedApiError';
    }
}
