---
title: Sign-in locations
navTitle: Sign-in locations
section: Operations
order: 1146
description: Understand the bundled sign-in location snapshot, updates, proxy requirements, and privacy limits.
tags: [operations, identity, privacy]
updated: 2026-10-17
---

# Sign-in locations

Core includes a server module and a bundled database snapshot that describe a
sign-in request by browser, operating system, approximate place, and network
operator. No page, API, CLI, or sign-in flow uses them yet. Later releases show
these details when someone approves a sign-in request and after a sign-in from
a new browser.

## Bundled snapshot and updates

Only the Core image contains the DB-IP IP to City Lite and IP to ASN Lite
snapshot for **2026-10**, built on **2026-10-01**. The files live under
`/app/geoip`: `dbip-city-lite.mmdb` (127 MB) and `dbip-asn-lite.mmdb` (9.6 MB)
uncompressed, with about 65 MB of compressed downloads during the image build.

Upgrade Cloud to update the bundled snapshot: each release carries the snapshot
pinned at build time. Uploading your own `.mmdb` files through administration
will follow in a later release. There is no GeoIP environment variable and no
automatic download at runtime.

Without these files, as in development, tests, or custom images, the module
returns no place or network name. Browser and operating system descriptions
still work. When first used, it logs each missing or invalid database once;
Core does not load the module in a sign-in flow yet. A lookup failure also
returns no details from the affected database and logs once.

The databases are © DB-IP.com, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
[IP Geolocation by DB-IP](https://db-ip.com). They are decompressed from gzip
and otherwise unmodified. A later administration page will show this attribution;
any page that displays or uses database results must link to DB-IP.com.

## Privacy and accuracy

The address stays on the server; lookup is local. The module stores and logs no
IP address. Its result includes only browser and system codes, country, city,
and network operator, plus database availability.

Locations are approximate. A city can identify a provider's network node.
VPNs and mobile networks can point to a different city or country from the
person using them. Network operator names do not classify a connection as a
VPN or data center.

Configure [trusted reverse proxies](/en/docs/operations/deployment-requirements#pass-client-addresses-through-the-reverse-proxy)
so the gateway forwards the person's address. Otherwise results can describe
the proxy. Private and other non-public addresses produce no place or network
name.
