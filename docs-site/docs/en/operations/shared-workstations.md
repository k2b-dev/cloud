---
title: Shared workstations
navTitle: Shared workstations
section: Operations
order: 1149
description: Mark a browser as a shared workstation so that it signs people out after they stop working and remembers nothing about sign-ins.
tags: [operations, identity, security, privacy]
updated: 2026-11-10
---

# Shared workstations

A shared workstation is a browser that several people use, such as a PC at a
counter. Anyone signed in on that browser can mark it in the profile menu with
**Shared workstation**. The mark belongs to the browser, not to a person, and
stays after sign-out.

On a marked browser:

- a browser session ends after the idle minutes without real input;
- the session cookie has no expiry, so the session also ends when the browser
  closes;
- the sign-in page remembers no sign-in method, credential choice, or account,
  and marking the browser forgets what it remembered before.

Mobile app sessions, OAuth clients, API keys, and agents are not affected.

## Set the idle minutes

Administrators set **Shared workstation idle minutes**
(`user.session.shared_workstation_idle_minutes`) under **Admin → Sign-in &
security → Sign-in**. The default is 10 minutes; the allowed range is 2 to 240. The value
applies to every marked browser, including sessions already running there. It
cannot be set per browser.

## What counts as work

Only typing, clicking, scrolling, and touching in a Cloud page count. The shell
reports such input to `POST /api/me/browser/activity`, at most every 20 seconds
and at once when the end is near. No other request extends the session: page
and API requests, live updates, streams, polling, prefetch, and background work
leave it unchanged. Input in one tab keeps every tab of the browser signed in,
because the server keeps one idle clock per session.

## What happens at the end

One minute before the end, every open tab warns: **You will be signed out
soon**, with **Keep working** and **Sign out**. Ten seconds before the end, the
tabs hide their content and open the sign-in page. Leaving the page gives
applications their usual `pagehide` and `visibilitychange` saves while the
session is still valid, so drafts that an application saves on the server are
kept. The sign-in page then ends the session and clears the account's data in
this browser, as a manual sign-out does, and explains why the person was
signed out.

The server enforces the limit on its own. Every authenticated request checks
the session's last real input, including SSR pages, application APIs behind
the gateway, and user-scoped streams. A session past its limit is revoked with
the reason `idle`, also when the browser was closed or the computer slept, and
later input does not revive it.

## Mark and unmark from the API

`PUT /api/me/browser/shared-workstation` with `{ "shared": true }` marks the
browser and starts the idle limit for the browser session that sent it;
`{ "shared": false }` unmarks it and lifts the limit for that session. The route
accepts only browser sessions, with the canonical `Origin` of the Cloud.
`GET /api/me/browser` reads the state and the seconds left without extending
the session.

## Limits

The mark is an HTTP-only cookie of the browser. Clearing the browser's cookies
removes it; the next sign-in then starts without an idle limit. A session that
started on a marked browser keeps its limit on the server, also when its cookie
is copied to another browser. The browser's own password manager may still
offer saved credentials; the sign-in page asks it not to save new ones.
