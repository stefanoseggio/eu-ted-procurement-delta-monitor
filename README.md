# EU TED Procurement — Delta Monitor

[![Built for Apify](https://img.shields.io/badge/Built%20for-Apify-00C1A2?style=flat-square&logo=apify&logoColor=white)](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor)
[![Pay-Per-Event](https://img.shields.io/badge/Pay--Per--Event-from%20%240.01%2Fevent-blue?style=flat-square)](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-D22128?style=flat-square&logo=apache&logoColor=white)](./LICENSE)

[![Run on Apify Store](https://img.shields.io/badge/Run%20on-Apify%20Store-00C1A2?style=for-the-badge&logo=apify&logoColor=white)](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor)

Live and public at [apify.com/stefano_seggio/eu-ted-procurement-delta-monitor](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor).

Delta-tracks EU public procurement notices — new tenders, contract awards, winner identity, and
status changes — across all 27 EU member states, via **TED's own official, public, no-auth Search
API** (`api.ted.europa.eu`). Part of [Delta Registry](https://github.com/stefanoseggio), a
pay-per-event regulatory/compliance data fleet.

## Why this actor is different from every other TED scraper on Apify

Every other TED-related Actor on Apify Store today (at least 9, found and priced in the table
below) re-fetches and re-delivers matching notices on every run, charging per record retrieved
regardless of whether that record has ever been seen before. **This actor only charges for what
actually changed.** A notice you've already seen, unchanged, costs nothing — forever. That's not
a marketing claim; it's mechanically enforced by the SHA-256 content-fingerprint comparison in
[`src/deltaEngine.ts`](src/deltaEngine.ts), the same "zero-cost no-change" guarantee standardized
across this fleet's other actors (see [AGENTS.md](AGENTS.md)).

The other structural difference: **there is nothing to bring your own key for.** TED's Search API
is free, public, and requires no authentication at all — confirmed directly from TED's own
developer documentation, not assumed. You don't manage a secret, a subscription, or a rate-limit
tier with a third party. You only need an Apify account.

## Quickstart

### cURL

```bash
curl "https://api.apify.com/v2/acts/stefano_seggio~eu-ted-procurement-delta-monitor/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operationMode": "INCREMENTAL",
    "expertQuery": "publication-date >= 20260101 AND classification-cpv = 72*",
    "maxItems": 100
  }'
```

### Python

```python
from apify_client import ApifyClient

client = ApifyClient("<YOUR_APIFY_TOKEN>")
run = client.actor("stefano_seggio/eu-ted-procurement-delta-monitor").call(run_input={
    "operationMode": "INCREMENTAL",
    "expertQuery": "publication-date >= 20260101 AND classification-cpv = 72*",
    "maxItems": 100,
})

for item in client.dataset(run["defaultDatasetId"]).iterate_items():
    print(f"{item['event_type']}: {item['notice_title']} — {item['buyer_name']} ({item['buyer_country']})")
```

### Node.js

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client.actor('stefano_seggio/eu-ted-procurement-delta-monitor').call({
  operationMode: 'INCREMENTAL',
  expertQuery: 'publication-date >= 20260101 AND classification-cpv = 72*',
  maxItems: 100,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
items.forEach((item) => console.log(`${item.event_type}: ${item.notice_title} — ${item.buyer_name} (${item.buyer_country})`));
```

## Use this from Claude Desktop, Cursor, or Windsurf (via MCP)

This actor is also reachable as a tool through Apify's own hosted `@apify/actors-mcp-server` at `https://mcp.apify.com`, scoped to just this one actor via a `?tools=stefano_seggio/eu-ted-procurement-delta-monitor` query string — it is not a separate "Delta Registry MCP server," and each config below connects an MCP client to this single actor, not the wider fleet. Get a token from [Apify Console → Settings → Integrations](https://console.apify.com/settings/integrations) first.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` on Windows (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS). Claude Desktop connects via the `mcp-remote` stdio bridge, not a direct URL:

```json
{
  "mcpServers": {
    "delta-registry-eu-ted-procurement-delta-monitor": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.apify.com/?tools=stefano_seggio/eu-ted-procurement-delta-monitor",
        "--header",
        "Authorization: Bearer ${APIFY_TOKEN}"
      ]
    }
  }
}
```

`mcp-remote` does not expand shell environment variables inside the JSON string — paste your real token literally in place of `${APIFY_TOKEN}`, and keep this file out of version control.

### Cursor

Edit `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (global). Cursor uses native HTTP transport:

```json
{
  "mcpServers": {
    "delta-registry-eu-ted-procurement-delta-monitor": {
      "url": "https://mcp.apify.com/?tools=stefano_seggio/eu-ted-procurement-delta-monitor",
      "headers": {
        "Authorization": "Bearer ${APIFY_TOKEN}"
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`. Windsurf uses `serverUrl`, not `url`:

```json
{
  "mcpServers": {
    "delta-registry-eu-ted-procurement-delta-monitor": {
      "serverUrl": "https://mcp.apify.com/?tools=stefano_seggio/eu-ted-procurement-delta-monitor",
      "headers": {
        "Authorization": "Bearer ${env:APIFY_TOKEN}"
      }
    }
  }
}
```

Windsurf's `${env:...}` syntax genuinely resolves from your environment at runtime, unlike `mcp-remote` above.

Want every Delta Registry actor (all 28) reachable from one closed-scope MCP config instead of connecting to each actor individually? See [`delta-registry-website/MCP_INTEGRATION.md`](https://github.com/stefanoseggio/delta-registry-website/blob/main/MCP_INTEGRATION.md).

## Operation modes

| Mode | What it does | Cost |
|---|---|---|
| `INCREMENTAL` (default) | Real production run, TED's `PAGE_NUMBER` pagination mode (max 15,000 notices/query, 250/page — see [Known limitations](#known-limitations) for this mode's one documented consistency caveat). Intended for scheduled runs against a narrow, recent `publication-date` window. Default here (rather than `VALIDATE_QUERY`) specifically so an unattended/default run — including Apify's own daily automated health-check — always fetches real data. | Pay-per-event (see below) |
| `VALIDATE_QUERY` | Sends your `expertQuery` to TED's own free syntax-check endpoint. No notices fetched, nothing pushed, nothing charged. Switch to this manually while drafting a new query. | Free |
| `BACKFILL` | Full historical pull using TED's uncapped `ITERATION`/scroll mode. Use once against a broad query to establish history, then switch to `INCREMENTAL` for the recurring schedule. | Pay-per-event (see below) |

Build and validate `expertQuery` on TED's own [Expert Search page](https://ted.europa.eu/en/search/expert-search) — that is TED's own recommended workflow, and this actor's `VALIDATE_QUERY` mode is a direct, free proxy for the same check via TED's own API.

### Health-check latency note

A real production run was observed taking **417 seconds** end-to-end — past Apify's default
300-second (5-minute) automated health-check window. Root cause, confirmed by live testing
directly against `api.ted.europa.eu`: **Apify Cloud's network-path latency to TED's API**, not a
defect in this actor's code or query logic. TED's own server consistently responded in under 1
second on every live test made against it; individual `fetch()` attempts from Apify's cloud
infrastructure, by contrast, were observed taking 60–150+ seconds each, and
[`src/tedClient.ts`](src/tedClient.ts) retries a failed/slow attempt up to 5 times with
exponential backoff — so a handful of unlucky slow attempts on one run can compound well past 300
seconds.

**Mitigation applied:** the `expertQuery` default was narrowed from a fixed `publication-date >=
20260101` window (42,134 matching notices) to a self-refreshing rolling 14-day window,
`publication-date >= today(-14) AND classification-cpv = 72*` (2,332 matching notices,
live-verified 2026-09-17 — TED's `today([+-]N)` function is evaluated server-side, so this default
never goes stale and needs no manual date bump). This is an ~18x reduction in matching notices,
and therefore in the number of sequential TED API pages a default run needs to walk — fewer pages
means fewer independent chances for one of those slow/retried `fetch()` calls to occur.

**Honest caveat:** this reduces, but does not guarantee, completion within Apify's 5-minute
health-check window. Even a single HTTP attempt to TED has been observed taking 60–150+ seconds,
so a query narrow enough to be satisfied in one page is still exposed to that same latency
variance — narrowing the query lowers the *probability* of a slow run, it does not bound the
*worst case*. If your schedule needs a tighter margin, a narrower window (e.g. `today(-7)`, 1,239
matches) further reduces page count at the cost of a shorter monitoring lookback; see the
`expertQuery` field description in [`.actor/input_schema.json`](.actor/input_schema.json) for
live-verified alternatives.

## Pricing (pay-per-event)

| Event | Price | When it fires |
|---|---|---|
| `NEW_NOTICE` | $0.02 | A notice ID never seen before appears, after this query's baseline is established. |
| `NOTICE_UPDATED` | $0.01 | A previously-seen notice's content fingerprint changed (award value, winner, deadline, status, or any tracked field). |
| `NOTICE_UNCHANGED` / `BASELINE_SNAPSHOT` | **Never billed** | First-run baseline observations and confirmed-unchanged notices are always free. |

There is no metered free trial (Apify's Console has no mechanism to comp the first N occurrences
of a paid event type) — but because unchanged notices are permanently free, the realistic ongoing
cost of a narrow, well-scoped monitoring query is small: you pay only when something in the real
world actually changed.

*Pricing above is live — this actor is published on Apify Store, and these are the exact,
currently-active Pay-Per-Event prices configured in the Apify Console's monetization settings, not
a proposal. `apify-actor-start` is retained (the first 5 seconds of platform compute is waived on
every run) and `apify-default-dataset-item` is removed (no automatic per-write dataset charge), so
the "unchanged notices cost nothing" guarantee above is enforced at both the application layer and
the Console billing layer.*

## Competitive landscape (real, verified 2026-09-16)

| Actor | Delta/monitoring? | Pricing | Note |
|---|---|---|---|
| `foxlabs`, `memo23`, `dltik`, `scrapers_lat`, `zcamper`, `pear_today` (various TED scrapers) | No — re-fetch/re-deliver every run | $1–20 / 1,000 records | No genuine change-detection found in any of these |
| `parseforge/ted-europa-tenders-scraper` | No | Per-record | Generic TED scraper |
| `pappy-dev/eu-ted-procurement` | No | Per-record | Markets itself as using "the official API" for retrieval, not for change-detection |
| `webdata_labs/eu-tenders-api` | No | Per-record | Ships an OpenAPI wrapper around TED data, no delta layer |
| **This actor** | **Yes — SHA-256 field-level delta, zero-cost no-change guarantee** | **$0.02/NEW_NOTICE, $0.01/NOTICE_UPDATED, unchanged always free** | Only actor in the category with genuine change-detection as of this writing |

At least 9 real competitors exist in this category — this is a moderately competitive niche, not
an empty one. The differentiator is the delta engine itself, not being first to market.

## Input reference

See [`.actor/input_schema.json`](.actor/input_schema.json) for the full, authoritative schema.
Key fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `operationMode` | enum | `INCREMENTAL` | `INCREMENTAL` \| `VALIDATE_QUERY` \| `BACKFILL` |
| `expertQuery` | string | `publication-date >= today(-14) AND classification-cpv = 72*` (live-verified: 2,332 real matching notices as of 2026-09-17, a self-refreshing rolling window via TED's own `today([+-]N)` server-side date function) | TED's own expert-search syntax; the only filter mechanism TED's API exposes. See the [Health-check latency note](#health-check-latency-note) below for why the default was narrowed from the prior fixed `>= 20260101` window (42,134 matches). |
| `fields` | array | curated 19-field set | TED eForms field IDs to retrieve |
| `scope` | enum | `ALL` | `LATEST` \| `ACTIVE` \| `ALL` |
| `onlyLatestVersions` | boolean | `false` | When true, collapses corrigenda/amendments to only the latest version of each notice. When false (TED's own default), every published version is returned as its own entry. |
| `limit` | integer | 50 | Notices per API page, max 250 |
| `maxItems` | integer | 50 | This actor's own per-run push cap |
| `deltaStateName` | string | `default` | Names the persistent delta-state store |
| `resetState` | boolean | `false` | Re-baseline from scratch |
| `onlyNew` | boolean | `true` | When false, also delivers (uncharged) baseline/unchanged rows |
| `webhookUrl` | string | — | Real-time POST alert on award-value/winner changes |

## Output record

```json
{
  "@type": "schema:GovernmentPermit",
  "event_id": "b7f3...e91a",
  "event_type": "NOTICE_UPDATED",
  "record_id": "2026-OJS123-456789",
  "notice_identifier": "2026-OJS123-456789",
  "publication_number": "123456-2026",
  "publication_date": "2026-06-15",
  "notice_title": "Supply of medical equipment for regional hospitals",
  "buyer_name": "Ministère de la Santé",
  "buyer_country": "FRA",
  "cpv_codes": ["33100000"],
  "submission_deadline": "2026-07-20",
  "procedure_type": "open",
  "estimated_value": 2500000,
  "estimated_value_currency": "EUR",
  "awarded_value": 2380000,
  "awarded_value_currency": "EUR",
  "winner_identifier": "FR-SIRET-12345678900012",
  "winner_country": "FRA",
  "winner_size": "sme",
  "changed_fields": [],
  "status_fingerprint": "a1c9...",
  "content_fingerprint": "9e02...",
  "is_new": false,
  "source_url": "https://ted.europa.eu/en/notice/...",
  "scraped_at": "2026-09-16T12:00:00.000Z"
}
```

`event_id` is a SHA-1 idempotency key over `(notice_identifier, event_type, status_fingerprint,
content_fingerprint)` — a retried delivery of the same underlying event always reproduces the same
ID, safe for downstream deduplication.

## Architecture

Full spec in [AGENTS.md](AGENTS.md). Summary:

```
                              ┌─────────────────────┐
   Actor input ──────────────▶│   src/main.ts        │
   (expertQuery, mode, ...)   │   (mode dispatch)     │
                              └──────────┬───────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                     ▼
           VALIDATE_QUERY          INCREMENTAL              BACKFILL
          (checkQuerySyntax:      (PAGE_NUMBER,           (ITERATION,
           true; free, no push)   15k cap, scheduled)      uncapped scroll)
                    │                    │                     │
                    └────────────────────┴─────────┬───────────┘
                                                     ▼
                                     ┌───────────────────────────┐
                                     │  src/tedClient.ts          │
                                     │  api.ted.europa.eu (no     │
                                     │  auth) + backoff/jitter +  │
                                     │  outage/query/token error  │
                                     │  classification             │
                                     └──────────────┬─────────────┘
                                                     ▼
                                     ┌───────────────────────────┐
                                     │  src/deltaEngine.ts         │
                                     │  normalize → canonicalize   │
                                     │  → SHA-256 → classify        │
                                     └──────────────┬─────────────┘
                                                     ▼
                                     ┌───────────────────────────┐
                                     │  src/state.ts                │
                                     │  Key-Value Store persistence │
                                     │  (fingerprints + scroll token)│
                                     └──────────────┬─────────────┘
                                                     ▼
                                Apify Dataset (pay-per-event push)
                                        + optional webhook alert
```

## Webhooks

Set `webhookUrl` (any HTTPS endpoint accepting a JSON POST — a Slack Incoming Webhook, an n8n/Make
catch-hook, or your own service) to get a real-time alert the moment a notice's awarded value or
winner identity appears or changes — the two fields a procurement-BD or compliance team actually
escalates on. This is independent of, and does not replace, Apify's own platform-level webhook
system, configurable separately in the Apify Console.

## What this actor deliberately does not do

- **No anti-bot / stealth / TLS-fingerprint impersonation.** TED's Search API is public and
  requires no authentication — there is no bot detection here to bypass. See
  [AGENTS.md §0](AGENTS.md#0-the-one-finding-that-reshapes-this-entire-block) for the
  full reasoning.
- **No BLAKE3.** Evaluated and rejected in favor of SHA-256 for this fleet — see
  [AGENTS.md §1.1](AGENTS.md#11-hash-algorithm-sha-256-not-blake3--an-explicit-reasoned-decision).
- **No structured CPV/country/value filter UI.** TED's API exposes exactly one filter mechanism —
  the expert-query string. Building a "friendlier" structured-filter compiler on top of it would
  require guessing at exact operator grammar this actor's authors did not independently verify
  end-to-end; shipping that as a reliability claim would be dishonest. A future revision can add
  this once TED's full expert-query grammar is formally confirmed.

## Known limitations

- **`INCREMENTAL` mode's pagination is not cross-page consistency-guaranteed.** TED's own API docs
  state plainly that `PAGE_NUMBER` mode (what every `INCREMENTAL` run uses) has "no mechanism to
  ensure consistency between two retrieved pages" — if TED publishes a new Official Journal S
  release while a multi-page `INCREMENTAL` run is mid-walk, that run can miss or double-return a
  notice. `BACKFILL` is unaffected (it uses TED's consistency-guaranteed `ITERATION`/scroll mode).
  This is a deliberate, evaluated trade-off, not an oversight — see
  [AGENTS.md's "Known limitation" note in §3](AGENTS.md#known-limitation-runincrementals-page_number-mode-is-not-cross-page-consistency-guaranteed)
  for the full reasoning and why it self-heals: `INCREMENTAL` re-walks its entire query result set
  from page 1 on every scheduled run, so a notice missed by this race is simply picked up on the
  very next run (one schedule interval later), and a notice returned twice in the same run is
  recognized as already-seen and never double-pushed or double-charged. If you need a stronger
  guarantee than "eventually correct within one schedule interval," periodically re-run `BACKFILL`
  (fully consistency-guaranteed) against the same query as a reconciliation pass.

---

This actor is part of **Delta Registry** — pay-per-event regulatory & compliance data
infrastructure built and operated by Stefano Seggio. For the rest of the fleet, see
[github.com/stefanoseggio](https://github.com/stefanoseggio).
