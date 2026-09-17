import { log } from 'apify';

import type { OutputRecord } from './types.js';

/**
 * Best-effort delivery: a webhook failure must never fail or interrupt the actor run - the
 * dataset push (the record of truth) has already succeeded by the time this is called.
 * Mirrors singapore-acra-registry-monitor's webhookNotifier.ts.
 */
export async function notifyHighValueChange(webhookUrl: string, record: OutputRecord): Promise<void> {
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `[TED Delta Monitor] ${record.event_type}: ${record.notice_title ?? record.notice_identifier} (${record.buyer_name ?? 'unknown buyer'}, ${record.buyer_country ?? 'unknown country'}) - awarded value: ${record.awarded_value ?? 'n/a'} ${record.awarded_value_currency ?? ''}`,
                record,
            }),
        });
        if (!response.ok) {
            log.warning(`Webhook notification failed with status ${response.status} - continuing run (webhook delivery is best-effort, not a run-blocking dependency).`);
        }
    } catch (error) {
        log.warning(`Webhook notification threw an error - continuing run: ${error instanceof Error ? error.message : String(error)}`);
    }
}
