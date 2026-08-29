---
id: gateway-ops-operations
title: Operations
icon: ti ti-tool
description: How the operational pages fit together during normal diagnosis and maintenance.
order: 110
---

The pages are server-rendered admin views with URL-backed filters, search, pagination, and compact status summaries.

## Gateway pages {icon="point"}

:::reference
- **Apps:** Shows registered apps, online status, base URL, heartbeat, uptime, request count, latency, error count, and supported platform features.
- **Routes:** Shows route prefix ownership and route counters from the current gateway router snapshot.
- **Health webhooks:** Deliver gateway health to HTTP endpoints. Webhooks can be scoped to all apps, included apps, or excluded apps, and can send GET pings or POST JSON payloads.
- **Settings:** The gateway health check schedule is stored as a setting and controls when scheduled webhook evaluations run.
:::

## Observability pages {icon="layout-dashboard"}

:::reference
- **Logs:** Filter structured log entries by source, level, search text, and page. Retention is shown from the log retention setting.
- **Telemetry:** Inspect gateway request events by app, route, method, status, duration, slow requests, and errors.
- **Metrics:** Expose a Prometheus-compatible metrics endpoint and manage bearer tokens for Pulse or external scrapers.
- **Notifications:** Search notification delivery records and filter by sent, pending, or error status.
:::

## Data diagnostics {icon="lifebuoy"}

:::reference
- **Postgres:** Shows schema size, table size, planner row estimates, dead rows, analyze timestamps, installed extensions, and table warnings.
- **Redis:** Shows keyspace size, expiry coverage, average TTL, prefix distribution, bounded SCAN samples, and warnings.
:::
