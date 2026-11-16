---
title: Put Cloud into maintenance mode
navTitle: Maintenance mode
section: Operations
order: 1151
description: Switch maintenance mode on and off with cld or the admin settings, get past it as an administrator, and know what browsers, API clients, sockets and probes see while it is on or while one app restarts.
tags: [maintenance, gateway, cli, operations]
updated: 2026-11-16
---

# Put Cloud into maintenance mode

During maintenance mode the gateway answers every request itself, with a
calm page in the browser and a stable `503` for programs. It needs neither
Core nor Postgres to do this. The page checks by itself whether maintenance
has ended and then reloads the same address.

The gateway also answers by itself when **one app** restarts or cannot be
reached. You do not switch anything for that.

## Switch it on and off

You need the administrator role. Use your normal `cld login` profile.

```bash
cld admin maintenance on --message "Wir spielen Version 2.4 ein." --until 14:30
cld admin maintenance status
cld admin maintenance until 15:00
cld admin maintenance bypass
cld admin maintenance off
```

- `--message` is optional plain text of up to 500 characters. The page shows
  it.
- `--until` is optional. It is the planned end, shown on the page. Give
  `HH:MM` for today in your terminal's local time, or an ISO date-time. A time
  that has already passed is rejected.
- Maintenance never ends by itself, also not at the planned end. You switch
  it off.
- If you run `on` again while maintenance is on, the running maintenance
  stays. Only the message or end you give changes; `--message ""` removes the
  message.
- `status` shows when it started, the planned end, the message and
  `Apps bereit: 9 von 11 (mail, files starten)`. The total counts the apps
  that Core has seen and that you did not remove from the Apps listing. The
  ready count is the apps that are registered right now.

While maintenance is on, the gateway passes only
`/api/admin/maintenance` (and below) to Core and `POST /oauth/token` to the
OAuth app, so `cld` can still renew its token and switch maintenance off. Core
checks the administrator role on every call. Every change is in the audit log
(`maintenance.start`, `maintenance.update`, `maintenance.end`), and so is every
bypass link (`maintenance.bypass`).

## In the admin settings

Administrators also find the switch under **Administration → Maintenance
mode** (`/admin/settings/maintenance`). The page shows the same state as
`cld admin maintenance status`. `cld` stays the safer way, because it also
works while Core restarts.

- While maintenance is off, you can write a note for everyone and the
  expected end time, then choose **Start maintenance**. Maintenance starts
  at once. The page then gets a bypass link for your browser and opens it, so
  you stay in the Cloud while everyone else sees the maintenance page.
- While maintenance is on, the page shows since when and who started it, the
  planned end, the note and how many apps are ready. The apps line updates
  every 10 seconds. **Move end** sets a new end time. **End maintenance** asks
  once and switches maintenance off.
- The end time is a time today in your time zone. A time that has already
  passed is rejected.
- If starting works but the bypass link fails, the page says so and offers to
  try again. You can also run `cld admin maintenance bypass` or
  `cld admin maintenance off`.

Only administrators see the page; Core checks the role again before it reads
the state.

## Get in as an administrator

```bash
cld admin maintenance bypass
```

```text
Link für dich, gilt bis zum Ende dieser Wartung:
https://cloud.example.org/?cloud-maintenance-bypass=…
```

Open the link in your browser. You then see the Cloud as usual while everyone
else sees the maintenance page, so you can check your work before you switch
maintenance off.

- The link only lets your browser past the maintenance page. It is not a
  sign-in: you sign in as usual, and every permission check stays the same.
- It works on the Cloud address only. App domains show the maintenance page
  to everyone.
- It ends with this maintenance, and after 12 hours at the latest. For a
  longer maintenance, run the command again. A new maintenance needs a new
  link.
- Treat it like a password until it ends. Anyone who opens it gets past the
  maintenance page in their own browser. The audit log records who asked for
  a link and until when, never the link itself.
- Outside maintenance the command prints one sentence and exits with code
  `1`.

When the browser opens the link, the gateway checks it, stores it in a
host-only cookie (`__Host-cloud_maintenance_bypass`, `HttpOnly`, `Secure`,
`SameSite=Lax`, until the link expires; in development
`cloud_maintenance_bypass` without `Secure`, like Core's own cookies) and
redirects to the same address
without the link. Pages, API calls and WebSockets from that browser then pass.
The gateway checks the cookie on every request from memory, with a key that
belongs to this maintenance alone, and removes the cookie and the link
parameter from every request before it reaches an app, also outside
maintenance. Open sockets are closed when maintenance starts; a bypassed socket
that opened later stays open until it closes by itself.

## What people and programs see

| Client | Whole Cloud in maintenance | One app restarting or unreachable |
| --- | --- | --- |
| Browser page (`GET`/`HEAD` with `Accept: text/html`) | `503` HTML page, `Retry-After: 30` | `503` HTML page for the app, `Retry-After: 5` |
| API and other requests | `503` problem JSON, code `maintenance` | `503` problem JSON, code `app_unavailable` |
| Open WebSocket | Closed with `1012` when maintenance starts | Closed by the app as before |
| New WebSocket | `503` problem JSON | `503` problem JSON for a path of an app that just left |
| `/health`, readiness | `200`; `/health` adds `"maintenance": { "active": true }` | `200` |

Problem JSON (`Content-Type: application/problem+json`) has a stable code.
Branch on `code`, never on `title`:

```json
{ "type": "about:blank", "title": "Cloud is in maintenance", "status": 503, "code": "maintenance", "until": "2026-11-16T13:30:00.000Z" }
```

```json
{ "type": "about:blank", "title": "App is unavailable", "status": 503, "code": "app_unavailable", "appId": "mail" }
```

`until` is present only when a planned end is set. Every answer has
`Cache-Control: no-store`. The HTML page has a strict content security policy
with a new nonce per response.

`cld` prints one sentence instead of an error, for example
`Wartungsmodus aktiv, geplant bis 14:30 Uhr.`, and exits with code `75`
(`EX_TEMPFAIL`). Scripts can wait and retry on that code.

App domains show the same maintenance page as the Cloud host. The page never
shows the name of the person who switched maintenance on.

## When one app restarts

The app page says "<App> wird gerade aktualisiert" only when the app
deregistered cleanly on shutdown. If its registration expired or its address
does not answer, the page says "<App> ist gerade nicht erreichbar". After an
app leaves the registry, the gateway remembers its name, icon, colour and
paths for 15 minutes (at most 32 apps). In that time a request to one of its
paths gets the app page instead of another app's "not found" page.

## Status endpoint

`GET /_cloud/gateway/status` is public and answered from gateway memory. It
works on the Cloud host and on app domains:

```json
{ "maintenance": { "active": true, "until": "2026-11-16T13:30:00.000Z" } }
```

`{"maintenance": null}` means off. On the Cloud address, a browser that
carries a valid bypass link also gets `"bypass": true` in the `maintenance`
object, so an open page can say that only this person sees the Cloud. With
`?app=<id>` the answer also has
`"app": { "available": true }` while that app is registered and its last
proxied request did not fail in the past 15 seconds; an unknown id is `false`.
The page polls this endpoint. It reports no other details.

## How the state is kept

The state is one record on the Sync ephemeral `cloud-maintenance` (owner
`cloud`, key `state`), next to the app registry. Core writes it. Every gateway
watches it and keeps the last known state in memory when NATS is briefly
unreachable. The record has a 7-day lease, which the gateway renews while
maintenance is on when less than half of it remains. If every gateway is
stopped for longer than 7 days, maintenance is off when they start again.

The gateway reads the page's Cloud name, logo, time zone and default language
from the `app.name`, `app.logo`, `app.timezone` and `app.locale` settings
every 30 seconds. It fetches each app's icon once per app build.

If the gateway itself restarts, it cannot answer. A page that is already open
shows that it has no connection and tries again.
