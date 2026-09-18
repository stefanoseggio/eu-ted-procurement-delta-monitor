# Security Policy

## Supported versions

This Actor follows [semantic versioning](https://semver.org/) via automated release tagging (see [`.github/workflows/release.yml`](.github/workflows/release.yml)). Only the latest published major version receives security fixes — there is no long-term-support branch for older majors, consistent with this being a single-maintainer, independently-operated Actor rather than an enterprise product with a formal support matrix.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** This repository has private vulnerability reporting enabled — go to the **Security** tab → **Report a vulnerability** to open a private advisory visible only to the maintainer until a fix is ready. This is the correct channel for anything that shouldn't be disclosed in a public issue (credential handling, injection risks, dependency CVEs affecting this Actor's real usage, etc.).

**Do not** open a public GitHub issue for a suspected security vulnerability — use private reporting instead so the disclosure stays coordinated.

## What's actually in scope

This Actor's real attack surface, honestly assessed:

- **No credential handling of any kind.** This Actor requires no third-party API key or BYOK secret — TED's Search API (`api.ted.europa.eu`) is free, public, and requires no authentication. There is no customer secret this Actor could leak.
- **No arbitrary-code or arbitrary-URL input surface**, with one narrow exception. Input is a fixed JSON Schema (`.actor/input_schema.json`) enforced by the Apify platform before the Actor runs. The one user-supplied endpoint is the optional `webhookUrl` field, which the Actor POSTs a JSON alert to when an award value or winner changes — this is a destination the operator configures for their own run, not attacker-controlled input.
- **Dependency vulnerabilities** in `package.json`'s real dependency tree (`apify` and its dev dependencies) are a real, ongoing concern — tracked via Dependabot version-update PRs (`.github/dependabot.yml`, confirmed active: weekly `npm` and `github-actions` update PRs are running against this repo). GitHub's secret scanning and Dependabot security-alert scanning are **not currently enabled** on this repository (verified live via the GitHub API on 2026-09-18) — turning them on is a maintainer-level decision under the repo's Settings → Code security page, not something this file can claim on Stefano's behalf.
- **Source integrity** (a compromised or spoofed `api.ted.europa.eu` endpoint) is outside this Actor's control — it fetches from TED's own official, EU-operated URL over HTTPS and does not implement independent content-signing verification beyond standard TLS.

## Response expectations

This is an independently developed and maintained Actor with no contractual security SLA. In practice, security reports are typically triaged within 48 hours, though there is no guaranteed fix timeline. Reports that turn out to be genuine, exploitable vulnerabilities will be credited in the fix's release notes unless the reporter requests otherwise.

## Enterprise / institutional customers

If your organization requires a signed security addendum, a formal disclosure SLA, or a security questionnaire completed as part of procurement, open an issue against this Actor's [Store page](https://apify.com/stefano_seggio/eu-ted-procurement-delta-monitor) or connect via [LinkedIn](https://www.linkedin.com/in/stefanoseggio-deltaregistry) — these are handled case-by-case, not something this file can commit to on Stefano's behalf.
