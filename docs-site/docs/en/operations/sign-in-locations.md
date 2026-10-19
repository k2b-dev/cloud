---
title: Sign-in locations
navTitle: Sign-in locations
section: Operations
order: 1146
description: Understand the bundled sign-in location snapshot, updates, proxy requirements, and privacy limits.
tags: [operations, identity, privacy]
updated: 2026-10-18
---

# Sign-in locations

Core includes a server module and a bundled database snapshot that describe a
sign-in request by browser, operating system, approximate place, and network
operator. Successful browser sign-ins now use this module to remember browsers
and countries. No page, API, CLI, or notification exposes the stored data yet.

## Bundled snapshot and updates

Only the Core image contains the DB-IP IP to City Lite and IP to ASN Lite
snapshot for **2026-10**, built on **2026-10-01**. The files live under
`/app/geoip`: `dbip-city-lite.mmdb` (127 MB) and `dbip-asn-lite.mmdb` (9.6 MB)
uncompressed. The image build takes the gzip files (about 65 MB compressed)
from Cloud's image mirror and checks their checksums.

Upgrade Cloud to update the bundled snapshot: each release carries the snapshot
pinned at build time. Uploading your own `.mmdb` files through administration
will follow in a later release. There is no GeoIP environment variable and no
automatic download at runtime.

Without these files, as in development, tests, or custom images, the module
returns no place or network name. Browser and operating system descriptions
still work. When first used, it logs each missing or invalid database once;
sign-ins load the module when they describe the request. A lookup failure also
returns no details from the affected database and logs once.
Core maps the files through Bun, which needs write access to open them,
although Core never writes to them. With a read-only root filesystem, such as
`readOnlyRootFilesystem` or `docker run --read-only`, Core therefore returns no
place or network details and logs each database's failure once.

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

## Browser cookie

A successful browser sign-in sets `__Host-cloud_browser`. It is HTTP-only,
Secure, `SameSite=Strict`, and has `Path=/` with no Domain attribute. In
HTTP development, the name is `cloud_browser` and Secure is omitted.

The value is 32 random bytes encoded as 43 base64url characters without
padding. The cookie lasts 90 days. Each successful sign-in refreshes its
lifetime and keeps the same value. A missing or invalid value gets a new one.
Core does not rotate it. Signing out keeps it. Failed sign-ins do not set or
refresh it. The mobile app does not get this cookie.

## Stored data

Core stores three tables in Postgres:

- `auth.device_trust_state` has one installation-wide row (`id`). `started_at`
  records the first migration start and never changes. `geoip_since` records
  when Core first stored a country and is set only once.
- `auth.known_browsers` has a row ID, account ID, browser hash, browser and
  operating system codes, and the latest sign-in's country and city. It records
  the first and latest sign-in times. `notified_at` is reserved for a later
  release and stays empty. Cities are limited to 96 UTF-8 bytes.
- `auth.sign_in_countries` has an account ID, country code, and latest sign-in
  time for each account and country pair.

Only the hash `sha256(user ID ‖ cookie value)` is stored, as 32 raw bytes.
The input is the lowercase UUID text followed directly by the cookie text.
The cookie value itself is not stored in Postgres. A database dump alone
cannot link two accounts in one browser. Anyone who sees the cookie value at
runtime can compute the hash for any account. This includes an operator who
can see cookies in proxy logs or a browser.

No raw IP address is stored in these tables. No legal review was done for
this storage or cookie behavior.

## Retention and limits

Browser and country records expire 90 days after `last_seen_at`. Every read
applies this cutoff, even before a cleanup run deletes the row. A later
sign-in from an expired browser starts a new first-seen period.

Core's per-minute maintenance job deletes expired records in batches of up to
1,000 rows, with at most 10 batches per table per run. The aim is deletion
within a day after expiry. A stopped job only delays deletion; it never
extends how long a record counts as remembered.

Each account keeps at most 100 browsers and 50 countries. New sign-ins evict
the oldest records first. An installation-wide introduction phase lasts 14
days from the first Core start after the upgrade. During it, later releases
will not call any browser new and will send no new-sign-in notice, because
Core has not seen the browsers yet. Accounts and requests cannot restart or
extend it.

## Where traces of a sign-in end up

| Storage | What it contains | Retention and deletion |
| --- | --- | --- |
| `auth.device_trust_state` | Installation start and first stored country time | Installation-wide; neither timestamp is reset by sign-ins or account deletion. |
| `auth.known_browsers` | Account, browser hash, browser, OS, latest country and city, first and latest sign-in, reserved notification time | 90 days after the latest sign-in; at most 100 per account; account deletion removes rows by CASCADE. |
| `auth.sign_in_countries` | Account, country and latest sign-in | 90 days after the latest sign-in; at most 50 per account; account deletion removes rows by CASCADE. |
| Existing rate limiter in Valkey | IP addresses used briefly for rate limits | Unchanged; short-lived rate-limit keys. |
| `auth.session_families.created_user_agent` | The sign-in's user-agent header | Unchanged; follows session-family retention. |
| Proxy logs and backups | Depends on the operator's configuration | Outside Cloud's retention and deletion jobs. |
