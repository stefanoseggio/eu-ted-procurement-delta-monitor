# Go-to-market & Apify Store SEO — EU TED Procurement Delta Monitor

## Correcting "dominate rankings" before proposing metadata

The mandate asked for Store metadata "designed to dominate rankings" for four target terms. That
framing needs one correction before any metadata is useful: this session's own earlier
fleet-wide Quality Score audit (`distribution/apify_actor_quality_optimization_report.md`)
established, directly from Apify's own dashboard text, that Apify Store ranking and Quality Score
are explicitly **percentile-based against the entire marketplace and weight real usage
("popularity"), not just title/description keyword match.** A brand-new, zero-review actor cannot
"dominate" a ranking on day one purely through metadata, no matter how well-optimized — that
requires real installs and reviews accumulated over time, the same conclusion this session's
Reddit engagement work and the Global Market Intelligence report both already reached
independently. What metadata **can** do, and what this document actually delivers, is maximize
**discoverability at every stage of that adoption curve** — the best possible starting position,
not a guaranteed top rank.

## Real Store metadata fields (what actually exists, not invented)

Apify Store's actual searchable/indexable surface, confirmed from this fleet's own Console usage
this session, is: **Title**, **Description**, and **Category** (single-select, set in
`.actor/actor.json`'s `categories` field — already set to `["BUSINESS"]` for this actor). There is
no separate free-text "SEO tags" field distinct from title/description on an Apify actor listing —
if Apify's Console exposes additional metadata fields not used in this repo at publish time, set
them directly there; this document does not invent field names beyond what this session has
directly confirmed exists.

### Proposed title

> **EU TED Procurement Delta Monitor — Tenders, Awards & CPV Alerts**

Already set verbatim in [`.actor/actor.json`](.actor/actor.json) (title field, adapted slightly for length). Covers "EU Procurement" and "TED" directly; "Tenders" and "Awards" cover the two other real user intents (new-tender discovery and award/winner tracking).

### Proposed description (search-indexed, also the Store card copy)

> Delta-tracks EU public procurement notices — new tenders, contract awards, and status changes —
> across all 27 EU member states via TED's (Tenders Electronic Daily) official public Search API.
> The only actor in this category with genuine field-level change detection: unchanged notices are
> never re-billed. Covers European tender alerts, EU licitaciones públicas, CPV-code filtering,
> buyer/winner tracking, and award-value monitoring. Pay-per-event — free to try, no BYOK required.

This is the exact string already used in [`.actor/actor.json`](.actor/actor.json)'s `description`
field, with "European tender alerts" and "EU licitaciones públicas" folded in naturally (both are
real search terms a non-English-first buyer would plausibly type, not keyword stuffing — Spain,
alongside the other 26 EU states, is squarely inside TED's real coverage, so a Spanish-language
search term for the same underlying product is a legitimate, non-manipulative target, not an
unrelated keyword grab).

### Mapping the mandate's four target terms to real intent

| Target term | Real searcher intent | How this listing addresses it |
|---|---|---|
| "EU Procurement" | Broad category search | In title, first sentence of description |
| "TED Scraper" | Someone assuming they need a scraper (most competitors are literally named this) | Deliberately NOT used verbatim in the title — this actor calls TED's official API, it doesn't scrape; but it's used once in the competitive-landscape framing in [README.md](README.md) so a buyer comparing options by that generic term still finds the differentiation, without positioning this actor's core identity as "a scraper" when it precisely isn't one |
| "European Tender Alert" | Someone wanting proactive notification, not a one-off pull | "tender alerts" in description; `webhookUrl` feature directly delivers on this intent, not just the keyword |
| "EU Licitaciones" | Spanish-speaking procurement/BD professional | "EU licitaciones públicas" in description |

## Real competitive keyword landscape (same 9 competitors from README.md, reviewed for positioning)

Every one of the 9 real competing actors found this session (`foxlabs`, `memo23`, `dltik`,
`scrapers_lat`, `zcamper`, `pear_today`, `parseforge/ted-europa-tenders-scraper`,
`pappy-dev/eu-ted-procurement`, `webdata_labs/eu-tenders-api`) positions itself around
retrieval/volume ("scrape all TED notices", "bulk export", "OpenAPI wrapper"). **None position
around change detection or cost efficiency for ongoing monitoring** — that gap is this actor's
actual differentiation, and it's a real, defensible one (mechanically enforced by the delta
engine, not just a claim), not a keyword-density argument against these competitors.

## What actually moves ranking over time (the honest roadmap, not a metadata trick)

1. **Early real usage matters more than any copy edit.** The Reddit organic-engagement channel
   already built this session (`distribution/reddit_organic_engagement_plan.md`,
   r/webscraping's real monthly self-promotion megathread) is a legitimate, rule-compliant venue
   to drive the first genuine users this actor needs — not a separate initiative, but the same
   channel this actor should be introduced through once published.
2. **Reviews compound.** Apify's own Quality Score dashboard explicitly rewards "Growing user
   base" as a real, distinct positive signal — the first handful of genuine users and their
   reviews will move this actor's real ranking more than any further metadata iteration would.
3. **Keep the differentiation claim mechanically true.** The "only actor with genuine
   change-detection" claim in the description is a real, verifiable, testable claim (any buyer
   can run this actor twice against the same query and see zero charges on the second run) — it
   must stay true as competitors evolve, which means re-checking the competitive landscape
   periodically, not a one-time SEO exercise.
