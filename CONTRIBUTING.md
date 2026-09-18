# Contributing

This repository ships the real, buildable TypeScript source for the **EU TED Procurement — Delta Monitor** Apify Actor. It is independently maintained by Stefano Seggio as part of the [Delta Registry](https://github.com/stefanoseggio) fleet — there is no separate contributor team, but external bug reports, source-coverage proposals, and documentation fixes are welcome.

## Local setup

```bash
git clone https://github.com/stefanoseggio/eu-ted-procurement-delta-monitor.git
cd eu-ted-procurement-delta-monitor
npm install
apify login          # once per machine, needed only for `apify run`
```

No third-party credentials are required — TED's Search API (`api.ted.europa.eu`) is free, public, and requires no authentication.

## Development workflow

```bash
npm run start:dev     # tsx src/main.ts, reads ./storage/key_value_stores/default/INPUT.json
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write .
npm run build          # tsc
npm test               # vitest run
```

Local runs hit the real, live TED API — there is no bundled fixture/mock server. Use a narrow `expertQuery` and a small `maxItems` while developing to keep runs fast and avoid unnecessary load on TED's API.

## Branch naming

- `fix/<short-description>` — bug fixes
- `feat/<short-description>` — new input fields, new output fields, new source coverage
- `docs/<short-description>` — README/documentation-only changes
- `chore/<short-description>` — dependency bumps, tooling, CI changes

## Commit convention

This repository follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary>

<optional body>
```

Types used here: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. The `type` prefix drives automated changelog generation via `release-please` (see [`.github/workflows/release.yml`](.github/workflows/release.yml)) — a `feat:` commit triggers a minor version bump, `fix:` triggers a patch bump, and `feat!:`/a `BREAKING CHANGE:` footer triggers a major bump. Non-conventional commit messages are still accepted but won't be reflected in the auto-generated changelog entry for that change.

## Pull requests

1. Fork or branch, make your change, and ensure `npm run lint`, `npm run build`, and `npm test` all pass locally.
2. Open a PR against `main` using the repository's [PR template](.github/PULL_REQUEST_TEMPLATE.md).
3. CI (`.github/workflows/test.yaml`) runs automatically and must pass before merge.
4. Behavioral changes to the Actor's input/output schema should also update `.actor/input_schema.json` / `.actor/dataset_schema.json` and the corresponding README sections in the same PR — schema and documentation drift is treated as a real bug, not a follow-up.

## Scope boundaries

Feature proposals are evaluated against this Actor's own documented doctrine (README → "What this actor deliberately does not do"): no anti-bot/stealth/TLS-fingerprint impersonation work (TED's Search API is public and unauthenticated, so there is nothing to bypass), no swapping the delta-fingerprint algorithm away from SHA-256, and no structured CPV/country/value filter UI layered on top of TED's expert-query syntax until that grammar is formally confirmed end-to-end. A proposal that requires any of these will be declined regardless of how useful the outcome would be.

## Questions or non-code issues

For questions that aren't a code change (pricing, licensing, enterprise inquiries), use the Apify Store's Issues tab on the [live Actor page](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor) rather than a GitHub issue.
