---
title: Sign-in locations
navTitle: Sign-in locations
section: Operations
order: 1146
description: Understand the bundled sign-in location snapshot, updates, proxy requirements, and privacy limits.
tags: [operations, identity, privacy]
updated: 2026-10-19
---

# Sign-in locations

Core includes a server module and a bundled database snapshot that describe a
sign-in request by browser, operating system, approximate place, and network
operator. Successful browser sign-ins now use this module to remember browsers
and countries. Paired apps can request browser sign-in context through the
[signed app approval API](./app-approval.md#read-browser-sign-in-context).
Cloud Login displays it when the Cloud announces support; see
[Read the request details](/en/docs/accounts/app-sign-in#read-the-request-details).

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

Core stores browser and country history in three Postgres tables:

- `auth.device_trust_state` has one installation-wide row (`id`). `started_at`
  records the first migration start and never changes. `geoip_since` records
  when Core first stored a country and is set only once.
- `auth.known_browsers` has a row ID, account ID, browser hash, browser and
  operating system codes, and the latest sign-in's country and city. It records
  the first and latest sign-in times. `notified_at` records the notice handoff
  time, or the first-seen time for browsers skipped during introduction or
  remembered before this notice existed. `notice` holds the fixed sign-in
  snapshot until handoff, then becomes `NULL`. It is limited to 1,024 bytes
  of PostgreSQL JSONB text. `notice_attempted_at` records a failed handoff's
  last attempt. Cities are limited to 96 UTF-8 bytes.
- `auth.sign_in_countries` has an account ID, country code, and latest sign-in
  time for each account and country pair.

Only the hash `sha256(user ID ‖ cookie value)` is stored, as 32 raw bytes.
The input is the lowercase UUID text followed directly by the cookie text.
The cookie value itself is not stored in Postgres. A database dump alone
cannot link two accounts in one browser. Anyone who sees the cookie value at
runtime can compute the hash for any account. This includes an operator who
can see cookies in proxy logs or a browser.

Core also stores the request's context snapshot in `auth.app_logins.context`.
It contains the level, browser/OS codes, country, city, operator, and history.
It is limited to 512 bytes of PostgreSQL JSONB text, including spaces and
escaped characters. Core first removes city and network names if needed,
then drops the whole context if it still does not fit. A context failure
never fails the sign-in. Decoy and terminal rows have `context = NULL`.
The snapshot lives with the request until expiry and bounded cleanup.
It never contains `sameNetwork` or an address.

No raw IP address is stored in these tables. No legal review was done for
this storage or cookie behavior.

## Same-network hint

After a browser request commits, Core stores a request address pseudonym in
Valkey: SHA-256 of a fresh 16-byte salt followed by the full IPv4 address or
IPv6 /64. The salt is stored beside the digest and differs for each request.
The value has no account data or raw address, and the key is per request.
Decoys do the same work. Private or unknown addresses produce no entry.

The key expires with the five-minute request and is deleted after approval or
denial. A signed context read compares the phone's prefix with this pseudonym
and returns `sameNetwork: true` only on a match. Core reads the listed browser
requests in one Valkey call after the SQL transaction. If Valkey is down,
the hint is missing and sign-in continues. Nothing about S5 changes the level.
This is pseudonymization, not anonymization: someone with the salt and digest
can test candidate addresses.

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
days from the first Core start after the upgrade. During it, context has
`level: "info"` and `history: null`; Cloud makes no known/new claim because
Core has not seen the browsers yet. Accounts and requests cannot restart or
extend it.

## New-browser notice

After a successful web sign-in from a new browser, Core hands over
**New sign-in from a new browser** after the session transaction commits and
before the response returns to the browser. This includes password, passkey,
email-code, Cloud Login, password-reset, expired-password, and emergency-admin
sign-ins. Mobile app session issuance is excluded. An email-code sign-in that
creates a guest account sends no notice, because the account did not exist
before.

The browser notice shows browser, system, and time, and opens **My account →
Sign-in** (`/me/security`). The email also shows the sign-in method and, when
available, the approximate place. Cloud Login includes the approving device's
name. The time uses the installation's `app.timezone` setting, default `UTC`,
and names that zone. The notice uses the sign-in request's locale; if no
locale was stored, it uses the installation's `app.locale`.

The notice is on by default, with email first and a browser notification when
there is no email address. The person can turn it off under **My account →
Notifications**, entry **New sign-in from a new browser**. Preferences are read
at handoff, when delivery plans are persisted. They are not captured with the
sign-in snapshot. The handoff precedes the response so the person signing in
cannot turn the notice off first. A notice that maintenance catches up after
a failed handoff uses the preferences at that later time.

A failed handoff does not fail the sign-in. The fixed snapshot stays in
`notice`, with `notified_at = NULL`. Later sign-ins can update the row's latest
place, but do not change a pending snapshot. Core's existing per-minute
maintenance job retries one batch of at most 100 notices: never-retried
notices first, then the least recently tried, oldest first within each. A
failure leaves that notice pending, records the attempt time in
`notice_attempted_at`, and moves it behind the others, so failing notices
cannot hold back the rest.
Malformed snapshots are discarded without logging their content.

The idempotency key is `new-browser-sign-in:<browserId>:<signedInAt>`.
Retries of the same first-seen period produce one event. A browser returning
after the 90-day retention window counts as new again, even when its row ID
survives; its new first-seen time gives it a different key.

During the installation-wide 14-day introduction phase, browsers are marked
announced without sending a notice. Maintenance never sends those notices
later. On the first migration that adds `notice`, previously remembered
browsers also count as announced. Rerunning that migration leaves pending
notices untouched.

## Where traces of a sign-in end up

| Storage | What it contains | Retention and deletion |
| --- | --- | --- |
| `auth.device_trust_state` | Installation start and first stored country time | Installation-wide; neither timestamp is reset by sign-ins or account deletion. |
| `auth.known_browsers` | Account, browser hash, browser, OS, latest country and city, first and latest sign-in, notification time, and a pending snapshot of at most 1,024 bytes | 90 days after the latest sign-in; at most 100 per account; snapshot cleared at handoff; account deletion removes rows by CASCADE. |
| `auth.sign_in_countries` | Account, country and latest sign-in | 90 days after the latest sign-in; at most 50 per account; account deletion removes rows by CASCADE. |
| `auth.app_logins.context` | Request context, at most 512 bytes of JSONB text; no S5 or address; empty for terminal and decoy requests | Five-minute request lifetime, then existing bounded expiry cleanup; account deletion removes account rows by CASCADE. |
| App-login address key in Valkey | Per-request salt and SHA-256 digest of full IPv4 or IPv6 /64; no account data | Expires with the request; deleted after approve or deny; missing when Valkey is unavailable. |
| `audit.events` for app-login approve/deny | Browser decisions include the stored `level` only, alongside the request ID; no city, country, network, browser/OS, or S5 | Existing audit retention; terminal decision metadata stays unchanged. |
| Notification history (`notifications.events`) | Notice title and target, without place | Existing notification history retention; account deletion removes events by CASCADE. |
| Notification delivery (`notifications.deliveries`) | Encrypted delivery content, including place in the email payload | A database trigger clears the payload when delivery is delivered, suppressed, or failed. |
| Outgoing mail | Email content, including approximate place | `outgoing_mail.content_retention_days`, default 90 days; independent of account deletion. |
| Existing rate limiter in Valkey | IP addresses used briefly for rate limits | Unchanged; short-lived rate-limit keys. |
| `auth.session_families.created_user_agent` | The sign-in's user-agent header | Unchanged; follows session-family retention. |
| Proxy logs and backups | Depends on the operator's configuration | Outside Cloud's retention and deletion jobs. |
