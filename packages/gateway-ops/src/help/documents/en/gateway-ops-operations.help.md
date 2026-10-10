---
id: gateway-ops-operations
title: Operations
icon: ti ti-tool
description: Find the right operational page for diagnosis and maintenance.
order: 110
---

The pages are server-rendered administration views. Filters, search, and pagination are part of the URL, and compact summaries show the status.

## Use the gateway pages {icon="point"}

:::reference
- **Apps:** Shows the registered apps with online status, base URL, heartbeat, uptime, request count, latency, error count, and supported platform features.
- **Routes:** Shows which app owns each route prefix, and the route counters from the current snapshot of the gateway router.
- **Health webhooks:** Send the gateway health to HTTP endpoints. A webhook checks **All apps**, only the selected apps (**Selected only**), or all apps except the selected ones (**Exclude selected**). It sends GET pings or POST JSON payloads.
- **Settings:** The gateway health check schedule is stored as a setting. It controls when the scheduled webhook checks run.
:::

## Use the observability pages {icon="layout-dashboard"}

:::reference
- **Logs:** Filter structured log entries by source, level, search text, and page. The page shows the retention from the log retention setting.
- **Telemetry:** Check gateway request events by app, route, method, status, duration, slow requests, and errors.
- **Metrics:** Provides a Prometheus-compatible metrics endpoint. Create and revoke bearer tokens for Pulse or external scrapers here.
- **Capabilities:** Read the history of dispatched capability calls by app, capability, origin, status, user, destructive flag, and time range. Each row holds correlation, timing, and the shape of input and result, never the payloads. Rows are deleted after 90 days.
- **Notifications:** Search notification delivery records, and filter by sent, pending, or error status.
:::

## Read the data diagnostics {icon="lifebuoy"}

:::reference
- **Postgres:** Shows schema size, table size, planner row estimates, dead rows, analyze timestamps, installed extensions, and table warnings.
- **Redis:** Shows keyspace size, expiry coverage, average TTL, prefix distribution, bounded SCAN samples, and warnings.
:::
