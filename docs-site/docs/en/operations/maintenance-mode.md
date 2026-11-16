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
  `Apps bereit: 9 von 11 (mail, files starten)`; in stage „Ruhe“ also how
  many apps are quiet (see below). The total counts the apps
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

- While maintenance is off, you can write a note for everyone and pick the
  expected end, then choose **Start maintenance**. Maintenance starts
  at once. The page then gets a bypass link for your browser and opens it, so
  you stay in the Cloud while everyone else sees the maintenance page.
- While maintenance is on, the page shows since when and who started it, the
  planned end, the note and how many apps are ready. The apps line updates
  every 10 seconds. **Move end** sets a new end time. **End maintenance** asks
  once and switches maintenance off.
- The end is a date and a time in your time zone, which the picker names, so
  it can lie after midnight. The page suggests one hour from now, rounded up
  to the next quarter hour; clear the field for no planned end. A time that
  has already passed is rejected.
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
Link für dich, gilt bis zum Ende dieser Wartung, längstens bis 02:02 Uhr:
https://cloud.example.org/?cloud-maintenance-bypass=…
```

Open the link in your browser. You then see the Cloud as usual while everyone
else sees the maintenance page, so you can check your work before you switch
maintenance off.

- The link only lets your browser past the maintenance page. It is not a
  sign-in: you sign in as usual, and every permission check stays the same.
- It works on the Cloud address only. App domains show the maintenance page
  to everyone.
- It ends with this maintenance, and after 12 hours at the latest; the
  command prints that latest time. For a longer maintenance, run the command
  again. A new maintenance needs a new link.
- Treat it like a password until it ends. Anyone who opens it gets past the
  maintenance page in their own browser. The audit log records who asked for
  a link and until when, never the link itself.
- You cannot revoke one link on its own. To end every link at once, switch
  maintenance off; a maintenance you start after that has a new key, so no
  older link works for it.
- The link carries its secret in the query string. A reverse proxy or load
  balancer in front of the gateway may write it to its access log: do not log
  the `cloud-maintenance-bypass` parameter there, or keep such logs as
  private as the link itself. The gateway logs one line when it sets the
  cookie (who, from which address, until when), never the link.
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
maintenance. A request with the link parameter and a method other than `GET`
or `HEAD` gets `400` on every host and never reaches an app. Open sockets are
closed when maintenance starts, also when a new maintenance replaces the
running one; a bypassed socket that opened later stays open until it closes
by itself or the next maintenance starts.

Every page you open this way shows the notice "Wartungsmodus aktiv. Nur du
siehst die Cloud." (see [Open pages](#open-pages)). For administrators it
also has **Wartung beenden**, which switches maintenance off for everyone.
Someone else who opens the link sees the same notice without it. The gateway tells the app with
the request header `X-Cloud-Maintenance-Bypass: 1`; it removes that header
from every incoming request, so no browser can set it itself.

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
{ "type": "about:blank", "title": "App is unavailable", "status": 503, "code": "app_unavailable", "appId": "mail", "appName": "E-Mail", "reason": "updating" }
```

`until` is present only when a planned end is set. `reason` is `updating`
when the app deregistered cleanly and `unavailable` otherwise (see
[When one app restarts](#when-one-app-restarts)). `appName` is the app's name
in the request's language (from `Accept-Language`, else the Cloud's
language); it is missing when the gateway does not know the app.

Every problem answer also has the header `X-Cloud-Unavailable`, with
`maintenance` or `app_unavailable; app=mail; reason=updating`. It says the
same as the body and is there for answers without a body, such as `HEAD`.
The HTML page does not have it. Every answer has
`Cache-Control: no-store`. The HTML page has a strict content security policy
with a new nonce per response.

`cld` prints one sentence instead of an error, for example
`Wartungsmodus aktiv, geplant bis 14:30 Uhr.`, and exits with code `75`
(`EX_TEMPFAIL`). Scripts can wait and retry on that code.

App domains show the same maintenance page as the Cloud host. The page never
shows the name of the person who switched maintenance on.

## Open pages

A page that is already open when maintenance starts, or when an app restarts,
stays where it is. Nothing on it is discarded, and text in a field stays in
the field. With its first request that gets a `503` with code `maintenance`
or `app_unavailable`, the page shows one persistent notice in the usual
place for notices: at the bottom on a computer, at the top on a phone. It
floats, so nothing on the page moves.

| Situation | Notice | When it is over |
| --- | --- | --- |
| Whole Cloud in maintenance | "Wartungsmodus aktiv" | "Wartung beendet" |
| App deregistered cleanly | "Mail wird gerade aktualisiert" | "Aktualisierung abgeschlossen" |
| App gone otherwise | "Mail ist gerade nicht erreichbar" | "Mail ist verfügbar" |
| Bypass link (administrator) | "Wartungsmodus aktiv. Nur du siehst die Cloud." | "Wartung beendet" |

- **Reads** (`GET` and `HEAD`) wait quietly and are sent again once it is
  over. The page shows no error for them. Reads of the same address wait as
  one: a query that polls sends nothing more while it waits, and at the end
  one request answers all of them. At most 64 different addresses wait per
  page; a further read gets its `503` with the reason at once, like an
  action, and the notice stays.
- **Actions** (every other method, such as sending, booking or deleting) are
  never held and never repeated. They return the gateway's `503` with a
  `message` that names the reason, for example "Wartungsmodus aktiv. Das geht
  wieder, sobald die Wartung beendet ist." The person presses again once it
  is over.
- From the first `503` on, the page polls the
  [status endpoint](#status-endpoint) on the same schedule as the
  maintenance page, and at once when the tab becomes visible or the device is
  online again. A hidden tab does not poll. Once it is over, the notice says
  so; the page does **not** reload, so the person keeps their place and
  their input.
- The notice shows one situation at a time. Reads that wait for a second app
  are sent again after each status check, so they go through as soon as that
  app is back, even while the first one is still away.
- When the page does not know the app's name, the notice uses the name from
  the problem answer, else "Diese App"; never the app's id.
- A link clicked during maintenance loads the maintenance page, which reloads
  the address after the end.
- With a bypass link, nothing is blocked. Administrators see **Wartung
  beenden** in the notice; it calls `POST /api/admin/maintenance/off`.

Every page built with the Cloud `Layout` gets this, built-in and third-party
apps alike. See
[Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations#maintenance-and-app-restarts)
for what this means for application code.

## The waiting game

Below the status line a small robot waits on a pale road, with "Leertaste:
losfahren" ("Space: start") or, on touch screens, "Tippen: losfahren" below
it. A round never starts on its own: Space, a tap on the road, or a click on
the maintenance symbol starts one. Arrow keys or swipes dodge, jump and slide.
Escape or "Spiel beenden", shown only during a round, returns to the waiting
robot; the focus stays on the game, so Space starts the next round. The game
makes no sound and loads nothing: it is part of the page, under the same
content security policy. The record stays in this browser only. With "reduce
motion" the game runs slower and dims the screen instead of shaking it.

If maintenance ends during a round, the page shows "Wartung beendet" with
"Weiter" and reloads only after the round or that click. When nobody plays, it
reloads as before. An app page shows the game only once the restart takes
longer than usual.

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
