---
title: Show website usage on a page
navTitle: Website usage page
section: Operations
order: 1148
description: Send page views from a website backend to Pulse and show totals, a time series, countries, and top pages on a Code page.
tags: [operations, pulse, analytics, privacy]
updated: 2026-11-21
---

# Show website usage on a page

This guide sends page views from a website's backend to Pulse and shows page
views, sessions, contact requests, a time series, countries, and top pages on
one Code page. Pulse has no browser tracking snippet.

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
in every number except the country breakdown. When `attribution` in the result is set, link
it where you show the results, including on a Code page. Other backends send `dimensions.country` from their
own source or leave it out.

## Create the base and source

```sh
cld pulse create Website --json
cld pulse use Website
cld pulse sources create --name website --kind http_ingest
cld pulse source-tokens create website --name backend --output-file ./website.token
```

Sources and tokens need base admin access. Check the first events with SQL:

```sh
cld pulse sql --file packages/pulse/examples/website.sql --param bucket=1d --format table
```

## Build the page

Ask Gustav for a Code page that reads the Website base, for example: "Build a
page with page views, sessions, and contact requests for the last seven days,
page views per day, page views per country, and the top ten pages from my
Website base." Gustav writes SQL like `packages/pulse/examples/website.sql`
and reads it with `pulse.base(id).sql.run`.

Cloud shows the page only to people who may read the Website base. Others get
**No access**. Pulse data never appears on a public page; to share the
numbers, give people read access to the base. Each visit runs the page's
queries against the base's SQL quota, so a page with a few aggregated queries
stays fast.

The [Pulse app guide](/en/apps/pulse#show-pulse-data-on-a-page) describes the
access rules and limits.

## Limits

Locations are approximate, and a VPN or mobile network can show another
country. Pulse does not identify unique people; a session count is valid only
within one query's grouping.
