import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutputRecord } from '../src/types.js';
import { notifyHighValueChange } from '../src/webhookNotifier.js';

vi.mock('apify', () => ({
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function sampleRecord(overrides: Partial<OutputRecord> = {}): OutputRecord {
    return {
        '@type': 'schema:GovernmentPermit',
        event_id: 'abc123',
        event_type: 'NEW_NOTICE',
        record_id: '24-599727-2026',
        notice_identifier: '24-599727-2026',
        publication_number: '00599727-2026',
        publication_date: '2026-08-15+02:00',
        notice_title: 'Geotechnical investigation services for the A61 motorway extension',
        buyer_name: 'Landesbetrieb Straßenbau NRW',
        buyer_country: 'DEU',
        cpv_codes: ['71332000'],
        submission_deadline: '2026-09-30+02:00',
        procedure_type: 'open',
        estimated_value: 185000,
        estimated_value_currency: 'EUR',
        awarded_value: 104290,
        awarded_value_currency: 'EUR',
        winner_identifier: 'DE123456789',
        winner_country: 'DEU',
        winner_size: 'SME',
        changed_fields: [],
        status_fingerprint: 'status-fp',
        content_fingerprint: 'content-fp',
        is_new: true,
        source_url: 'https://ted.europa.eu/en/notice/-/detail/599727-2026',
        scraped_at: '2026-09-16T12:00:00.000Z',
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('notifyHighValueChange', () => {
    it('POSTs a JSON payload with a human-readable text summary and the full record', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await notifyHighValueChange('https://example.com/hook', sampleRecord());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');

        const body = JSON.parse(options.body);
        expect(body.record).toEqual(sampleRecord());
        expect(body.text).toContain('NEW_NOTICE');
        expect(body.text).toContain('Geotechnical investigation services for the A61 motorway extension');
        expect(body.text).toContain('Landesbetrieb Straßenbau NRW');
        expect(body.text).toContain('DEU');
        expect(body.text).toContain('104290');
        expect(body.text).toContain('EUR');
    });

    it('falls back to notice_identifier, "unknown buyer", "unknown country", and "n/a" when the display fields are null', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        await notifyHighValueChange(
            'https://example.com/hook',
            sampleRecord({ notice_title: null, buyer_name: null, buyer_country: null, awarded_value: null, awarded_value_currency: null }),
        );

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.text).toContain('24-599727-2026'); // notice_identifier fallback
        expect(body.text).toContain('unknown buyer');
        expect(body.text).toContain('unknown country');
        expect(body.text).toContain('n/a');
    });

    it('never throws when the webhook responds with a non-ok status - delivery is best-effort and must not block the run', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', fetchMock);

        await expect(notifyHighValueChange('https://example.com/hook', sampleRecord())).resolves.toBeUndefined();
    });

    it('never throws when the fetch itself rejects (e.g. DNS failure or an unreachable host)', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));
        vi.stubGlobal('fetch', fetchMock);

        await expect(notifyHighValueChange('https://example.com/hook', sampleRecord())).resolves.toBeUndefined();
    });
});
