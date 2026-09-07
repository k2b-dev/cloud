---
title: Gateway Ops
navTitle: Gateway
section: Operations
order: 400
description: Admin console for application routing, health, observability, and platform diagnostics.
tags: [gateway, operations, observability, admin]
updated: 2026-09-07
---

# Gateway Ops

Gateway Ops is the administrator console for the Cloud gateway and shared
operational signals. It connects application registration and route ownership
with request telemetry, logs, background work, storage diagnostics, and alert
delivery.

## Use Gateway Ops

- Check which application instances are online, stale, degraded, or offline.
- Confirm which application owns a route prefix and inspect its traffic and
  error counters.
- Start an incident investigation from the overview, then narrow it with
  telemetry, logs, jobs, or workflows.
- Inspect bounded Postgres and Valkey diagnostics when evidence points to
  storage pressure or stale data.
- Review notification delivery and configure health webhooks for operator
  alerts.

Gateway Ops requires administrator access. Removing an offline registration
cleans the gateway registry; it does not restart or repair the application.

## Understand the Gateway Ops model

| Resource or signal | Responsibility |
| --- | --- |
| Registered app | Current instance metadata, heartbeat, health, and supported platform features |
| Route prefix | Path ownership and gateway request counters |
| Telemetry and log entry | Request behavior and application-reported context |
| Job or workflow run | State and history of background execution |
| Health webhook | Scoped delivery of gateway health changes to an HTTP endpoint |

Postgres row counts are planner estimates. Valkey prefixes come from a bounded
sample rather than a raw key browser. Use these views to direct an
investigation, not as exact replacements for database administration tools.

PostgreSQL connection counts and limits describe the database server, including
connections to other databases on that server. They do not report PgBouncer
clients, pool limits, or time spent waiting for a pool connection. A pool can be
full while PostgreSQL still has free connections. With transaction pooling,
sessions describe shared PostgreSQL backends rather than persistent application
connections. Monitor PgBouncer separately for pool pressure.

Session and index panels report failed queries as unavailable, so a loading
failure is not mistaken for an empty database. The corresponding administrator
API endpoints return an error instead of a successful empty list.

## How Gateway Ops fits Cloud

The gateway owns registry-driven routing. Gateway Ops owns the administrator
views and maintenance actions around that runtime state. Applications still
own their health implementation, logs, domain failures, and recovery. Cloud
supplies the shared logging, telemetry, jobs, workflows, notifications, and
settings contracts displayed here.

## Find detailed product help

Open **Help** inside Gateway Ops for the normal diagnosis path, health states,
webhook behavior, operational fields, and safe recovery steps. Developers can
read [Observability](/en/docs/operations/observability),
[Application lifecycle](/en/docs/build/lifecycle), and
[Runtime configuration](/en/docs/operations/runtime-configuration) for the
contracts behind these signals.

## Inspect Gateway Ops from the terminal

Gateway operations are part of the shared administrator module rather than a
separate `cld gateway` module. Start with health and active route ownership:

```bash
cld admin status --json
cld admin routes list --errors --json
```

Run `cld admin help` for logs, telemetry, jobs, workflows, notifications, and
bounded storage diagnostics. Run `cld admin <area> <command> --help` before a
maintenance action.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
