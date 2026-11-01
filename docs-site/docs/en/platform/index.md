---
title: Platform services
navTitle: Overview
section: Platform services
order: 500
description: Choose the platform boundary that removes shared infrastructure from an application.
tags: [platform, api, applications]
updated: 2026-11-01
---

# Platform services

Platform services keep cross-cutting infrastructure out of independently
deployed applications. Your application contributes the domain-specific
contract; Cloud runs the shared infrastructure and presents one consistent
surface to users, agents, and operators.

Use a platform service when the behavior must integrate with the wider Cloud
installation. Keep behavior in the application when it is meaningful only to
that domain. These services are runtime boundaries, not code generators: they
do not copy files into an application or take ownership of its data model.

## Choose a service

| Need | Application contributes | Cloud provides |
| --- | --- | --- |
| [Addresses and places](/en/docs/platform/places-and-maps) | Query input and caller identity | Fixed EU provider, shared credit budgets, caching, provenance, and attribution |
| Runtime configuration | Typed setting declarations and defaults | Validation, encrypted persistence, caching, and request snapshots |
| [Outgoing mail](/en/docs/platform/outgoing-mail) | A `mail:send` or `mail:read` declaration | Sender profiles, a searchable send log, and operator-controlled application access |
| Operational events | A source, message, and structured metadata | Console output, redaction, persistence, retention, and operations views |
| One operation across boundaries | Span names, events, and safe attributes | Trace storage, timing, status, and operations views |
| Security evidence | An action, outcome, actor, and target | Durable, sanitized audit storage |
| User communication | Typed payloads and channel-neutral presentation | Preferences, channel routing, durable delivery, retries, and deduplication |
| Cross-app and agent operations | Curated Types, Queries, and Actions | Live schemas, generic dispatch, CLI, and MCP tools |
| [Calendars for other apps](/en/docs/platform/calendar-sources) | Readable calendars, occurrences, deadlines, and optional versioned Actions | A shared source contract and bounded server reader |
| Files for other apps | A list Query, a read stream, and optionally a save Action | The shared file-provider contract, its checks, and discovery in the capability catalog |
| [App status](/en/docs/platform/app-status) | Administrator-only traffic Queries and an offline forget Action | Role discovery, bounded reads, and provider provenance |
| Global discovery | One permission-aware Query projected into Universal Search | Provider discovery, query fan-out, and shared search UI |
| [Panels](/en/docs/platform/panels) | One authorized page rendered with `PanelLayout` | A shared slot, provider tabs, sizing, and keyboard controls |
| Dashboard summaries | Authenticated JSON endpoints | Widget discovery, layout, and rendering |
| Product guidance | Markdown help documents | Search, rendering, and the shared Help surface |
| [Assistant Skills](/en/docs/platform/assistant-skills) | `SKILL.md` files with optional references | Validation, installation, content-hash updates, app-based access, and administrator overrides |
| Documents | HTML or Liquid templates and data | Shared Gotenberg configuration and PDF limits |
| Document extraction | Authorized document bytes | Bounded untrusted Markdown without storage or authorization |
| Command-line operations | A typed CLI module | Authentication, profiles, output modes, and dispatch |

Start from the need in this table, then open the linked page in the navigation
for its complete declaration, lifecycle, failure, and verification contract. Use
[Building blocks](/en/docs/building-blocks) when you know the task but not the
service, or [API surface](/en/docs/reference/api-surface) to look up an import.

Request middleware and identity are separate application boundaries:
[Request middleware](/en/docs/server/middleware) loads request context, while
[Identity and access](/en/docs/identity) explains caller and resource checks.

## Look up a country on the server

Use `ipCountry` from `@k2b/cloud/server` when an application needs an approximate
country for an IP address. It returns `Promise<IpCountryResult>`:

```ts
type IpCountryResult = {
  country: string | null;
  available: boolean;
  attribution: typeof DBIP_ATTRIBUTION | null;
};
```

`country` is an uppercase ISO 3166-1 alpha-2 code. A missing record, private
address, invalid IP, or input longer than 45 characters returns `null`.
`available` says whether Core has a country-capable database loaded, even when
that address has no country. A missing database, unavailable Core, rejected
app proof, rate limit (HTTP 429), or two-second request deadline returns
`{ country: null, available: false, attribution: null }`.

Call it after application startup with an enrolled
[app key](/en/docs/operations/app-keys#use-the-key-at-start) and
`CLOUD_CORE_INTERNAL_ORIGIN`. Built-in and third-party applications use the same
signed POST to Core. Only signed app principals can call the route; browser
sessions, API keys, legacy workload tokens, and anonymous requests cannot.
No additional platform permission is required. Applications need neither a
local GeoIP snapshot nor direct access to `geoip.databases` for this helper.
Update Core before deploying applications that use it.

For example, the fictional Atlas application can derive `dimensions.country`
on its server before sending a `page_view` to Pulse:

```ts
import { ipCountry } from "@k2b/cloud/server";

const pageViewDimensions = async (ip: string) => {
  const { country } = await ipCountry(ip);
  return country ? { country } : {};
};
```

Use the returned object as the event's `dimensions`, then discard the IP.
The helper sends the IP only in the POST body to Core within the installation.
It does not store, log, audit, or cache the address. It is not a capability and
creates no capability execution history. Only the country, availability, and
attribution return to the application; no city, coordinates, or network
operator are returned.

When `attribution` is non-null, link its `text` to its `url` wherever you use
or display the results, including reports built from saved country dimensions.
`DBIP_ATTRIBUTION` is also exported from `@k2b/cloud/server`. A non-DB-IP upload
returns null attribution; the operator still follows that provider's licence.
See [Sign-in locations](/en/docs/operations/sign-in-locations) for database
updates, availability, and accuracy limits. Country estimates are unsuitable
as proof of a person's location or as an authorization decision.
