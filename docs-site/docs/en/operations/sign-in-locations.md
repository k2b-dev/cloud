---
title: Sign-in locations
navTitle: Sign-in locations
section: Operations
order: 1146
description: Manage bundled and uploaded sign-in location databases, updates, proxy requirements, and privacy limits.
tags: [operations, identity, privacy]
updated: 2026-10-17
---

# Sign-in locations

Core includes a server module and a bundled database snapshot that describe a
sign-in request by browser, operating system, approximate place, and network
operator. Administrators can inspect and replace the databases through the
admin API and CLI. No sign-in flow uses the lookup results yet. Later releases show
these details when someone approves a sign-in request and after a sign-in from
a new browser.

## Bundled snapshot and updates

Only the Core image contains the DB-IP IP to City Lite and IP to ASN Lite
snapshot for **2026-10**, built on **2026-10-01**. The files live under
`/app/geoip`: `dbip-city-lite.mmdb` (127 MB) and `dbip-asn-lite.mmdb` (9.6 MB)
uncompressed. The image build takes the gzip files (about 65 MB compressed)
from Cloud's image mirror and checks their checksums.

Upgrade Cloud to update the bundled snapshot: each release carries the snapshot
pinned at build time. You can also replace either database with your own upload
until you reset it. There is no GeoIP environment variable and no automatic
download at runtime.

Without a bundled file or an upload for a type, as in development, tests, or
custom images, the module returns no place or network name for that type. Browser and operating system descriptions
still work. When first used, it logs each missing or invalid database once;
Core does not load the module in a sign-in flow yet. A lookup failure also
returns no details from the affected database and logs once.
Core maps the files through Bun, which needs write access to open them,
although Core never writes to them. With a read-only root filesystem, such as
`readOnlyRootFilesystem` or `docker run --read-only`, bundled lookups therefore
return no place or network details and log each database's failure once.
Uploaded databases do not need filesystem write access.

The databases are © DB-IP.com, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):
[IP Geolocation by DB-IP](https://db-ip.com). They are decompressed from gzip
and otherwise unmodified. The admin page shows this attribution while any
active database is from DB-IP. Any page that displays or uses DB-IP database
results must link to DB-IP.com.

## Use your own database

Open **Admin → Settings → Sign-in → Sign-in locations** to inspect the source
and build date of each database, upload a replacement, or reset it to the
bundled snapshot. The page shows a hint when active data is older than 183 days,
about six months. The build date comes from the file, not the upload date.

Upload a City or ASN database in MaxMind DB format with an IPv6 search tree.
DB-IP Lite and MaxMind GeoLite2 databases work. Follow the database provider's
licence; GeoLite2's EULA requires regular updates. Files can be raw `.mmdb` or
`.mmdb.gz`; Cloud detects gzip from the file contents.

The limits are **192 MiB unpacked** and **128 MiB per request body**. A reverse
proxy may set a lower request limit: upload the `.gz` file in that case. The
CLI compresses raw files while sending them:

```bash
cld admin geoip status --json
cld admin geoip upload ./dbip-city-lite.mmdb.gz
cld admin geoip reset city --yes
```

Use `reset asn --yes` to reset only ASN, or `reset --yes` to reset both types.
Both the page and CLI use the same administrator API. One upload runs at a time
per Core process; if another is running, wait briefly and retry. Invalid or
oversized files leave the previous database active.

Uploads are stored in Postgres, so database backups include them. Each type
has one current upload, which replaces the bundled file until reset. Every
Core instance checks for changes on lookups about once a minute and switches
to the replacement. A restarted Core also starts a refresh without delaying
startup. Uploads and resets have audit entries with the type, build date,
checksum, size, and administrator; file contents are not included in the audit.

An uploaded database is held in each Core process's memory, using about its
unpacked file size. The bundled snapshot is memory-mapped. A type uses one
reader at a time. Plan memory for the upload and for other instances reloading
it; uploads do not change the server's request-body limit.

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
