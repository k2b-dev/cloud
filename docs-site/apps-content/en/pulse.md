---
title: Pulse
navTitle: Pulse
section: Operations
order: 420
description: Explore metrics, events, states, resources, queries, and dashboards in one telemetry workspace.
tags: [pulse, telemetry, metrics, dashboards]
updated: 2026-09-14
---

# Pulse

Pulse turns incoming metrics, events, and current states into browsable
resources, reusable queries, and dashboards. It can describe infrastructure,
application behavior, or business activity without requiring one fixed domain
model.

## Use Pulse

- Check Sources first when expected data is missing or stale.
- Browse Resources when the question concerns one host, container, service,
  customer, order, or other observed object.
- Open Metrics, Events, or States when the signal name is already known.
- Test and save a query before using it in a dashboard.
- Publish a focused dashboard when a read-only link should show results without
  exposing the rest of the base.

Pulse must be deployed and available to your account.

## Understand the Pulse model

| Resource | Responsibility |
| --- | --- |
| Base | Access, retention, sources, queries, and dashboards for one telemetry context |
| Source | Metrics endpoint or HTTP ingest connection |
| Resource | Stable observed object that groups its metrics, events, and states |
| Signal | Named metric, event, or state published by one or more sources |
| Query and dashboard | Reusable analysis and its operator-facing presentation |

Dimensions distinguish stable variants such as region, route, mount, or
service. Put unique request IDs, sessions, full URLs, and protected details in
event fields rather than metric dimensions.

## How Pulse fits Cloud

Pulse owns ingestion, retention, inventory, query execution, saved queries,
and dashboards inside each base. Cloud supplies identity, resource access,
application routing, lifecycle hooks, and operational primitives. A source
credential belongs to one source and does not grant access to unrelated bases.

## Find detailed product help

Open **Help** inside Pulse for the data model, source health, query language,
dashboard DSL, retention, public displays, and troubleshooting. Developers can
read [Observability](/en/docs/operations/observability),
[Resource authorization](/en/docs/identity/authorization), and
[Resource API keys](/en/docs/identity/resource-api-keys) for adjacent Cloud
contracts.

## Inspect Pulse from the terminal

The native module can inspect a deployment before a script chooses a base:

```bash
cld pulse list --json
cld pulse capabilities --json
```

Run `cld pulse help` for bases, sources, signals, queries, dashboards, and
access. Run `cld pulse <command> --help` before ingesting data or changing a
base.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

Pulse initializes its tables atomically in a fresh `pulse` schema. Later starts
reuse that installation without changing its data. Existing Alpha schemas are
rejected: there is no automatic upgrade or data repair. Before replacing a
disposable Alpha installation, explicitly remove only its Pulse schema; the
application never deletes it on startup.

## Server collection before deployment

Metrics support gauges and nonnegative counters. Type and unit are fixed per metric name within a base; conflicting input rejects the entire batch. Counter rates use observed consecutive samples and correct resets before combining series. Histogram and summary aggregation is not supported.

Prometheus sources accept declared gauge/counter families and expose skipped samples in source diagnostics. Scrapes use whole-minute intervals (minimum 60 seconds), one collection timestamp, and a 15-second timeout covering both headers and body. Sources with no instance, host, or node label use the endpoint host and port as their target resource.

The initial operator scenario is 20–50 servers, approximately ten websites, 60-second sampling and 30-day raw retention. Website backends send events using secret source tokens. This is a test scenario, not a measured production capacity guarantee.
