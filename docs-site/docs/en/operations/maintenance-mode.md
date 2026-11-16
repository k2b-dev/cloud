---
title: Put Cloud into maintenance mode
navTitle: Maintenance mode
section: Operations
order: 1151
description: Switch maintenance mode on and off with cld, and know what browsers, API clients, sockets and probes see while it is on or while one app restarts.
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
  `Apps bereit: 9 von 11 (mail, files starten)`; in stage „Ruhe“ also how
  many apps are quiet (see below). The total counts the apps
  that Core has seen and that you did not remove from the Apps listing. The
  ready count is the apps that are registered right now.

While maintenance is on, the gateway passes only
`/api/admin/maintenance` (and below) to Core and `POST /oauth/token` to the
OAuth app, so `cld` can still renew its token and switch maintenance off. Core
checks the administrator role on every call. Every change is in the audit log
(`maintenance.start`, `maintenance.update`, `maintenance.end`).

## Quiet background work (stage Ruhe)

Maintenance mode alone only closes the Cloud to people. Background work keeps
running: mail is fetched and sent, notifications go out, schedules and
workflows run. For a database migration or a backup that needs a still Cloud,
add stage „Ruhe“:

```bash
cld admin maintenance on --quiesce
cld admin maintenance status
cld admin maintenance on --no-quiesce   # background work runs again, maintenance stays
cld admin maintenance off               # ends maintenance and resumes everything
```

`--quiesce` works when you switch maintenance on and while it is already on.
`on` without either flag keeps the current stage.

In every app instance (Core included, the gateway excluded), then:

- every Sync worker (jobs, queues, topic consumers, schedulers, pumps) stops
  taking new work and finishes the work in flight. After 30 seconds, work
  that is still running is cancelled and returns to NATS for later. Work that
  ignores the cancel still counts as running until it ends;
- outbox publishers, recovery scans, retention sweeps, outgoing mail, mail
  fetching including IMAP push, notifications, automations and workflows
  start nothing new. They stop after the workers have finished, one after
  another, so no running job meets a runtime that has already stopped. One
  that takes longer than the drain time plus a second is logged and keeps
  counting as running while the next one stops;
- the processes keep running and their registry entries stay. Requests are
  still answered, but a request that waits for background work waits until
  the stage ends: an AI chat turn, a file preview, or saving a shared text.

New work that arrives while quiet waits in NATS or Postgres. A job whose
stream reaches its retention limit rejects further submissions, so keep the
stage as short as the work needs.

When you run `--no-quiesce` or `off`, each instance starts its runtimes
again in their original order and then its workers. A worker whose old work
still runs starts again only after that work ended, so the same work never
runs twice in one instance. Work that ignores its cancel and still runs about
a minute after the restart began waiting makes the instance restart itself,
which ends it. A schedule that missed ticks runs once, not once
per missed tick. Periodic sweeps also run once.

An instance that cannot start part of its background work again tries up to
five times and logs each retry; fast failures end within about a minute,
attempts that hang take a few minutes. If it still fails, the
instance restarts itself. The AI chat and dictation workers keep trying
without a restart.

`status` adds one line while the stage is on:

```text
Ruhe: 8 von 9 Apps ruhig, Mail: 2 Aufgaben laufen noch und 1 Instanz ohne Rückmeldung
Quiet: 8 of 9 apps quiet, Mail: 2 tasks still running and 1 instance has not reported
```

An app counts as quiet when every running instance reports no work in
flight. Tasks count running jobs, other background tasks, and runtimes that
are still stopping. An instance without a report may have just started, or it
cannot reach NATS. At most three apps are named; the rest are counted.
`--json` returns `quiesce` and
`quiet: { quiet, total, busy: [{ id, name, inFlight, unreported }] }`.

Each instance reports to the Sync ephemeral `cloud-quiesce` (owner `cloud`,
one key per instance, at most 1024, each kept for 45 seconds and renewed
every 15 seconds while quiet). A report names the maintenance and how often
the stage was switched on in it, so after `--no-quiesce` and `--quiesce` an
old report never counts as quiet. The quiet line reads the app registry and
one snapshot of these reports, not the database. The `Apps bereit` line
reads Core's app catalogue from Postgres. Turning the stage on or off is in
the audit log as `maintenance.start` or `maintenance.update` with `quiesce`
in its metadata.

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

`{"maintenance": null}` means off. With `?app=<id>` the answer also has
`"app": { "available": true }` while that app is registered and its last
proxied request did not fail in the past 15 seconds; an unknown id is `false`.
The page polls this endpoint. It reports no other details.

## How the state is kept

The state is one record on the Sync ephemeral `cloud-maintenance` (owner
`cloud`, key `state`), next to the app registry. Core writes it. Every app
instance watches it for stage „Ruhe“ and keeps its last known stage when NATS
is briefly unreachable. Every gateway
watches it and keeps the last known state in memory when NATS is briefly
unreachable. The record has a 7-day lease, which the gateway renews while
maintenance is on when less than half of it remains. If every gateway is
stopped for longer than 7 days, maintenance is off when they start again.

The gateway reads the page's Cloud name, logo, time zone and default language
from the `app.name`, `app.logo`, `app.timezone` and `app.locale` settings
every 30 seconds. It fetches each app's icon once per app build.

If the gateway itself restarts, it cannot answer. A page that is already open
shows that it has no connection and tries again.
