---
id: gateway-ops-incident
title: Diagnose an incident
icon: ti ti-stethoscope
description: A repeatable path from app health to routes, request telemetry, logs, storage, notifications, and webhooks.
order: 105
---

Start at **Observability → Overview**. It answers "is anything wrong right now" across apps, request errors, rate limits, stuck jobs and log errors, and each tile links to the page that explains it with the filter already applied.

Use one signal to narrow the incident before opening every observability page. Gateway Ops keeps its filters in the URL so a useful view can be shared with another administrator.

## Diagnosis path {icon="lifebuoy"}

:::steps
1. **Apps:** Identify whether the affected app is online, stale, degraded, or offline. Note the latest heartbeat and route prefix.
2. **Routes:** Confirm that the expected prefix belongs to the expected app and inspect its hit and error counters.
3. **Telemetry:** Filter by app, route, method, status, duration, or error kind to find the failing requests.
4. **Logs:** Use the app or service source and a narrow level or search term for application context around the same time.
5. **Jobs:** Check background work when the symptom is stale or missing data rather than a failing request. Look for stuck runs and overdue schedules — a schedule that quietly stopped firing produces no errors at all.
6. **Postgres or Redis:** Check storage diagnostics only when the request and log evidence points to storage pressure, stale data, or keyspace growth. On Redis, evictions and hit rate matter more than key counts.
7. **Notifications and webhooks:** Confirm whether the platform sent or failed to send an operator-facing notification.
:::

## Interpret the evidence {icon="point"}

- A registered app with a stale heartbeat can be running but unable to report current health.
- Route counters show gateway traffic for the selected window, not whether a user completed the workflow successfully.
- A job counted as stuck is not running: its span was left open when a process died. Only "running" means work is in flight.
- Telemetry explains the HTTP request path and timing; logs explain what the application reported internally.
- Postgres row counts are planner estimates, and Redis prefixes come from a bounded sample.

:::warning Removing an offline registration
Remove a registration only when the app instance is not expected to recover. Removal cleans the gateway registry; it does not repair or restart the application.
:::

## Share a useful incident view {icon="shield-lock"}

Keep the app, route, status, time, and search filters in the URL. Share that filtered page together with the observed time range and the user-visible symptom, never with credentials or sensitive payloads.
