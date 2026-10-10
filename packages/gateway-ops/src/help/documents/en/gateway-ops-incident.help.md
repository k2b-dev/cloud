---
id: gateway-ops-incident
title: Diagnose an incident
icon: ti ti-stethoscope
description: Follow a repeatable path from app health to routes, request telemetry, logs, storage, notifications, and webhooks.
order: 105
---

Start at **Observability → Overview**. It shows whether anything is wrong right now across apps, request errors, rate limits, stuck jobs, and log errors. Each tile opens the page that explains it, with the filter already applied.

Use one signal to narrow the incident before you open every observability page. Gateway Ops keeps its filters in the URL, so you can share a useful view with another administrator.

## Follow the diagnosis path {icon="lifebuoy"}

:::steps
1. **Apps:** Check whether the affected app is online, stale, degraded, or offline. Note its latest heartbeat and route prefix.
2. **Routes:** Check that the expected prefix belongs to the expected app. Check its hit and error counters.
3. **Telemetry:** Filter by app, route, method, status, duration, or error kind to find the failing requests.
4. **Logs:** Filter by the app or service source and by a narrow level or search term. Look for app context from the same time.
5. **Jobs:** Check background work when the symptom is stale or missing data, not a failing request. Look for stuck runs and overdue schedules. A schedule that quietly stopped firing produces no errors at all.
6. **Postgres** or **Redis**: Check storage diagnostics only when requests and logs point to storage pressure, stale data, or keyspace growth. On Redis, evictions and hit rate matter more than key counts.
7. **Notifications** and **Webhooks**: Check whether the platform sent an operator-facing notification, or failed to send it.
:::

## Interpret the evidence {icon="point"}

- A registered app with a stale heartbeat can be running but unable to report its current health.
- Route counters show the gateway traffic in the selected window. They do not show whether a user completed the workflow successfully.
- A job counted as **Stuck** is not running: its span stayed open when a process died. Only **Running** means that work is in progress.
- Telemetry explains the path and timing of the HTTP request. Logs explain what the app reported internally.
- Postgres row counts are planner estimates, and Redis prefixes come from a bounded sample.

:::warning Remove only the registration of an instance that will not come back
Remove a registration only when you do not expect the app instance to recover. Removing it cleans the gateway registry. It does not repair or restart the app.
:::

## Share a useful incident view {icon="shield-lock"}

Keep the app, route, status, time, and search filters in the URL. Share the filtered page together with the observed time range and the symptom that users see. Never share credentials or sensitive payloads.
