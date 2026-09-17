# AGENTS.md - EU TED Procurement Delta Monitor

Technical notes for whoever (human or AI) touches this actor next. This document is the
standardized engineering blueprint for this actor and the reference design for future fleet
actors. Status: authored 2026-09-16. Every claim about TED's own API surface below was read
directly off TED's live OpenAPI specification (`https://api.ted.europa.eu/api-v3.yaml`, fetched
and parsed during this sprint) — not assumed from the mandate's premise.

## 0. The one finding that reshapes this entire block

The original mandate specified a "Resilient Anti-Bot & Network Bypass Layer" (session pooling,
**TLS fingerprint impersonation**, adaptive rate limiting) as a required architectural pillar,
modeled on the assumption that TED, like most commercial targets in this fleet's competitive set,
must be scraped past bot detection.

**That assumption is false for this specific source, and building it anyway would be the wrong
call, not just an unnecessary one.** TED exposes a real, official, public REST API:

```
POST https://api.ted.europa.eu/v3/notices/search
```

Confirmed directly from the live spec and developer docs (`docs.ted.europa.eu/api/latest/index.html`):

> "TED API allows **anonymous access** to all services manipulating published notices (i.e.,
> searching for or retrieving notices already published on TED)... **The Search API does not
> require a key.**"

There is no bot-detection layer in front of this endpoint to bypass. Building TLS-fingerprint
impersonation and stealth session-pooling against an official, no-auth, publicly-documented
government API would not be "resilience engineering" — it would be dressing an ordinary API
client up as something adversarial for a target that isn't adversarial, which is both wasted
engineering effort and a bad look if a prospective enterprise buyer ever reads the source (the
repo is public, per this fleet's own standing convention). **Delta Engine v2's actual resilience
layer for this actor is a well-behaved API client**: real exponential backoff with jitter, a
descriptive self-identifying User-Agent (the same convention already shipped on
`sec-enforcement-litigation-delta-feed` this session), and correct handling of TED's real,
documented rate/volume limits — described in full in §3.

This is the same discipline applied to every mandate this session: verify the platform's real
mechanics before writing code against imagined ones.

## 1. Deterministic content hashing & state delta engine

### 1.1 Hash algorithm: SHA-256, not BLAKE3 — an explicit, reasoned decision

The mandate specified "BLAKE3/SHA-256" as the fingerprinting primitive. A real fleet-wide audit
this session already established the actual, current state: **6 of the newest actors use
SHA-256, most of the original 18 use SHA-1, and a few use no hash at all** (actor-18 has no delta
layer; actor-21 does plain string comparison; the Australia GrantConnect actor uses a watermark).
BLAKE3 is used nowhere in the fleet today.

Delta Engine v2 standardizes the fleet going forward on **SHA-256 via Node's built-in `crypto`
module** — not BLAKE3 — for a concrete reason, not inertia: BLAKE3's Node bindings
(`blake3`/`blake3-wasm`) ship either prebuilt native binaries per platform/arch or a WASM
fallback, both of which are a real Docker build-fragility surface on Apify's `apify/actor-node`
base images that this fleet does not currently carry anywhere. The performance case for BLAKE3
(multi-GB/s hashing, SIMD-parallel tree hashing) solves a problem this actor doesn't have: TED's
own API rate/volume limits (§3) bound this actor to a few hundred notices per HTTP round-trip, so
the runtime is network-bound, not hash-bound, by roughly three orders of magnitude. Adding a
native/WASM dependency for a speed gain that never shows up in the actual runtime profile is a
straightforward net negative. SHA-256 is already Node's zero-dependency built-in, already the
newest fleet convention, and is not the bottleneck for any actor in this fleet including this one.

**Verdict: SHA-256, matching and reinforcing the fleet's existing newest-actor convention. BLAKE3
evaluated and explicitly rejected for this actor, for the reason above — not silently dropped.**

### 1.2 Canonicalization

Before hashing, TED's raw per-field values are first normalized into a flat `NormalizedNotice`
(`src/deltaEngine.ts`'s `normalizeNotice()`), then that structure is canonicalized via **recursive
key-sort** before hashing (not a flat top-level sort — a flat sort would silently break the moment
a future field addition reintroduces nesting). Two real, live-tested field-shape findings drove
this design, not assumptions:

- **i18n fields are not uniformly array-shaped.** The live OpenAPI spec documents one field
  (`option-description-lot`) as `{ lang: string[] }` (array-wrapped per language), but a real API
  call confirmed `notice-title` is actually `{ lang: string }` (a flat string per language, no
  array). A prior version of this actor assumed the array shape uniformly and silently returned
  only the first *character* of a real notice title as a result (see `firstString()`'s own doc
  comment in `deltaEngine.ts` for the full incident). Both shapes are now handled explicitly, and
  `normalizeNotice()`'s output is always a flat scalar/array — by the time canonicalization runs,
  no i18n structure remains to canonicalize.
- **CPV codes can repeat.** A real multi-lot notice can list the same CPV code once per lot,
  so `normalizeNotice()` deduplicates and sorts `classification-cpv` (`Array.from(new
  Set(...)).sort()`) *before* canonicalization — canonicalization itself never sorts array
  *elements*, only object *keys* (see below); CPV dedup/sort is a `normalizeNotice()`-level
  decision, not a `canonicalize()`-level one.

The canonicalization step itself, applied to the resulting `NormalizedNotice`:

1. Recursively sort all object keys, at every nesting depth.
2. Leave array *element order* untouched — canonicalization only ever reorders object keys, never
   array contents. The one array field in scope, `cpvCodes`, is already pre-sorted by
   `normalizeNotice()` as described above.
3. Serialize with `JSON.stringify` on the canonicalized structure (stable key order guaranteed by
   step 1, so this is deterministic across runs and across Node versions).
4. `sha256(canonical_json_string)` → the notice's **content fingerprint**.

One further real finding this same live-testing pass surfaced: TED's `-lot`-suffixed fields
(`estimated-value-lot`, `estimated-value-cur-lot`, `deadline-receipt-tender-date-lot`) are
genuinely multi-valued on a multi-lot notice, but the display-facing `NormalizedNotice` scalars
only carry the first lot's value for readability. To avoid the delta engine going blind to a
change in any *other* lot's value, `normalizeNotice()` also retains the full raw per-lot arrays
(`NormalizedNotice.rawLotValues`) purely so the content fingerprint stays sensitive to every lot,
not just the first.

A second, narrower fingerprint — the **status fingerprint** — is computed over only the fields a
compliance/procurement-BD buyer actually escalates on (procedure status, award value, winner
identity, deadline). This mirrors the two-tier fingerprint pattern already shipped in
`singapore-acra-registry-monitor` (`status_fingerprint` vs `content_fingerprint`), reused here
rather than reinvented, because it lets the pricing model bill a full-price event only for the
changes a buyer would pay to know about (§2), while a cosmetic metadata change (e.g., a corrected
typo in free-text notes) is tracked but priced as the cheap tier.

## 2. Zero-cost no-change execution guarantee

Every run:

1. Fetches the current notice set for the input's expert query (§3).
2. Computes both fingerprints per notice.
3. Compares against the last-seen fingerprints for that `notice-identifier` in the actor's
   persistent Key-Value Store state (named per the `deltaStateName` input, mirroring the existing
   fleet-wide convention).
4. **Only pushes a dataset item, and only fires a billed pay-per-event charge, when a fingerprint
   genuinely differs from the stored value, or the notice ID has never been seen before.** An
   unchanged notice updates its `lastSeen` timestamp in state (so staleness is observable) but
   produces zero dataset rows and zero charged events. This is not a new mechanism — it's the
   same guarantee already live on every actor in this fleet (e.g., ACRA's `onlyNew` default-true
   behavior) — Delta Engine v2 formalizes it as the fleet's standing architectural invariant
   rather than a per-actor convention that has to be independently reinvented each time.

## 3. Real network layer — TED's actual API contract

Everything below is read verbatim from the live spec, not inferred.

| Fact | Value |
|---|---|
| Base URL | `https://api.ted.europa.eu` |
| Search endpoint | `POST /v3/notices/search` |
| Authentication | **None** for search/retrieval (anonymous, public) |
| Request body | `{ query, fields[], page, limit, scope, paginationMode, onlyLatestVersions, iterationNextToken, checkQuerySyntax }` |
| Response body | `{ notices: NoticeResponse[], totalNoticeCount: number }` |
| Pagination mode (`PAGE_NUMBER`, default) | Max 15,000 retrievable notices per query; max 250 notices/page; max 10,000 fields/page (page-size × field-count) |
| Iteration mode (`ITERATION`) | No cap on total retrievable notices; same 250/page and 10k-fields/page limits; uses an Elasticsearch **point-in-time** token (`iterationNextToken`) for consistent, non-duplicating pagination across an unbounded result set |
| Token expiry | The point-in-time token expires at the next Official Journal S (OJ S) release **plus 24 hours** — i.e., at least one full day of headroom to finish a scroll |
| `scope` | `LATEST` (current OJ S release only), `ACTIVE` (still-open notices), `ALL` (default) |
| Query syntax | A TED "expert search query" string — the same syntax used on `ted.europa.eu`'s own Expert Search UI. TED explicitly recommends building/validating it there, then reusing the string via the API's `query` field; `checkQuerySyntax: true` runs a free syntax-only dry run with no results returned |
| Response field shape | Per-notice fields are returned as a flat map keyed by the same field ID requested; values are typically `string[]`, occasionally a plain `string` (some currency-code fields), or an i18n object `{ [langCode]: string[] }` for multilingual text fields (title, buyer name) |

### Why this actor does not use Crawlee

The mandate named `src/routes.ts` as a deliverable, in the pattern of Crawlee's page-routing
abstraction (built for following links across HTML pages). **This actor has no HTML to parse and
no links to follow** — it calls one JSON REST endpoint. Pulling in `@crawlee/core` /
`CheerioCrawler` here would add a real dependency and conceptual mismatch for zero benefit.
`routes.ts` is kept, but repurposed honestly: it routes between this actor's actual distinct
**operational modes** — `BACKFILL` (first run, ITERATION mode, no volume cap), `INCREMENTAL`
(subsequent runs, PAGE_NUMBER mode, narrow recent-publication-date window), and
`VALIDATE_QUERY` (a free `checkQuerySyntax` dry run so a bad expert-query string fails fast and
free, before a paid production run ever starts). This is a real, load-bearing routing need for
this actor, not a renamed stub.

### Resilience layer (the actual replacement for §0's rejected anti-bot block)

- Exponential backoff with jitter on `5xx`/network-level failures (base 1s, ×2 per attempt, capped
  at 30s, 5 attempts) — standard, well-behaved retry, not evasion.
- A descriptive, self-identifying `User-Agent`: `DeltaRegistryTEDMonitor/1.0
  (+https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor)`, matching the convention
  already shipped for the SEC actor this session.
- Failure classification, reusing the exact fleet-wide pattern established on
  `uk-hse-enforcement-monitor` (network outage vs. code defect, kept structurally separate so an
  outage never corrupts delta state):
  - `UPSTREAM_OUTAGE` — connection-level failure (DNS/TCP/TLS failure, timeout) against
    `api.ted.europa.eu` itself. Never touches delta state; retried with backoff, then surfaced as
    an actor-run warning if still failing after all attempts.
  - `RATE_LIMITED` — a real `429` response from TED. Not retried with the same backoff as a
    generic outage; surfaced distinctly so a caller can tell "TED is throttling this client" apart
    from "TED is down."
  - `QUERY_ERROR` — a real `400` response from TED's own query parser (invalid field, syntax
    error, unsupported operation — TED returns one of several typed error bodies for this,
    confirmed in the spec: `QuerySyntaxErrorError`, `QueryInvalidFieldFormatDetails`,
    `QueryUnknownFieldError`, `QueryUnsupportedFieldOperationError`). Caught **before** a paid
    production run via the `VALIDATE_QUERY` mode's `checkQuerySyntax: true` pre-flight, exactly
    mirroring this fleet's existing "cheap failure classes never touch billed state" principle.
    Never retried, since a query defect doesn't become valid by waiting.
  - Scroll-token expiry (past the OJ S + 24h window) is **not** a distinct failure class TED
    itself returns - it surfaces as an ordinary `QUERY_ERROR` whose message happens to mention the
    token. `isTokenExpiredError()` heuristically detects this specific case by pattern-matching
    the message text (`"token"` plus `"expired"`/`"invalid"`), and `runBackfill()` responds by
    discarding the stored token and restarting a fresh `ITERATION` scroll from page one, logged
    explicitly rather than silently swallowed. `TedFailureClass` still names a `TOKEN_EXPIRED`
    member for future use, but nothing in the codebase constructs one today - treat it as reserved,
    not implemented, until TED's API is confirmed to return a distinguishable error for this case.

## 4. Structured output pipeline

Dataset rows follow the same real convention as the rest of the fleet: a flat, typed JSON object
per event, described by a real `dataset_schema.json` (not fabricated — see
`.actor/dataset_schema.json` in this actor), with an `overview` table view for the Apify Console
UI. CSV/Excel/XML export is not custom code — it is Apify's own native per-dataset export
feature, available on every dataset with zero actor-side implementation, so no bespoke
dual-format writer was built (writing one would duplicate a platform feature the buyer already
gets for free from the Console UI or `GET /v2/datasets/{id}/items?format=csv`).

## 5. Fleet-wide relevance

This spec is written as this fleet's reference architecture, not a one-off. §1.1's SHA-256
decision, §2's zero-cost guarantee, and §3's outage/query-error/token-expiry classification are
all directly portable to the next niche actors already identified in this session's own
`global_actor_expansion_and_market_intelligence_report.md` (UK Modern Slavery Registry monitoring,
emerging-market sovereign debt monitoring, UAE mainland corporate registry monitoring) — each of
those, like TED, should get the same "verify the real data-access mechanism before assuming
scraping/stealth is required" pass before a line of code is written.
