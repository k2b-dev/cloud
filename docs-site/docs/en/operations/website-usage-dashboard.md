---
title: Build a website usage dashboard
navTitle: Website usage dashboard
section: Operations
order: 1148
description: Send page views from a website backend to Pulse and show totals, a time series, a country map, and top pages on one dashboard.
tags: [operations, pulse, analytics, privacy]
updated: 2026-11-01
---

# Build a website usage dashboard

This guide gives you one Pulse dashboard with page views, sessions, contact
requests, a time series, a world map, and top pages. The website's backend
sends the events; Pulse has no browser tracking snippet.

## Send page views with a country

Keep the source token in the backend's secret store. Send `page_view` after
the backend serves a page, with a canonical path and an opaque session ID.
If the website runs as a Cloud application, derive the country with
[`ipCountry`](/en/docs/platform#look-up-a-country-on-the-server) and discard the IP
address:

```ts
import { ipCountry } from "@k2b/cloud/server";

const { country } = await ipCountry(clientAddress);
const dimensions = { path: "/services", ...(country ? { country } : {}) };
```

Never send the IP address to Pulse. A page view without a country still counts
in every panel except the map. When `attribution` in the result is set, link
it where you show the results. Other backends send `dimensions.country` from
their own source or leave it out.

## Create the source and dashboard

Start from the example definition in
`packages/pulse/examples/website-dashboard.json`:

```sh
cld pulse create Website --json
cld pulse use Website
cld pulse sources create --name website --kind http_ingest
cld pulse source-tokens create website --name backend --output-file ./website.token
cld pulse dashboards save --file website-dashboard.json --idempotency-key website-v1 --json
cld pulse dashboards list
cld pulse dashboards panels <dashboard-id>
cld pulse dashboards panel <dashboard-id> countries --range 7d --json
```

`dashboards save` needs write access to the base. A person's login and an agent
acting for that person use the same commands and the same access checks.
A panel that returns no rows yet shows an empty state until the first events
arrive.

## Change a panel

Read the dashboard into a file with its current revision, change
`definition.panels`, and save the whole definition. Pulse refuses a save from an
older revision.

```sh
cld pulse dashboards get <dashboard-id> --json \
  | jq '{name, definition, expectedRevision: .revision}' > website-dashboard.json
cld pulse dashboards save --dashboard <dashboard-id> --file website-dashboard.json --idempotency-key website-v2 --json
```

The [Pulse app guide](/en/apps/pulse) describes each panel type and its limits.

## Share the numbers

Publishing creates a link that anyone can open, without an account. Review each
output column first: the link shows those columns for the preset time ranges.
Publishing confirms the exact columns of every panel, so read them from the
dashboard and check the file:

```sh
cld pulse dashboards get <dashboard-id> --json \
  | jq '[.definition.panels[] | {(.id): .columns}] | add' > columns.json
cld pulse dashboards publish <dashboard-id> --expected-revision <revision> --file columns.json --yes --json
cld pulse dashboards unpublish <dashboard-id> --expected-revision <revision> --yes
```

## Limits

Locations are approximate, and a VPN or mobile network can show another
country. Pulse does not identify unique people; a session count is valid only
within one query's grouping.
