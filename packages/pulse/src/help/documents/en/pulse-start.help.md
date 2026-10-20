---
id: pulse-start
title: Start with Pulse
icon: ti ti-activity-heartbeat
kind: start
description: Create a base, connect a source, and check collection health.
order: 100
---
Pulse collects metrics, events, and states in bases. Open a base to set up sources and check incoming data.

## Connect a source

Pulse needs a connected data store. If **Pulse is not set up yet** appears, contact your Cloud administrator.

:::steps
1. Choose **New base** and enter a name for your product, environment, or business area.
2. Open the base and choose **Sources → New source**.
3. Choose a metrics endpoint or an HTTP ingest source and save it.
4. Open the source to check its newest data time, errors, and scrape history.
:::

A metrics source fetches a Prometheus endpoint at its configured interval.
An HTTP ingest source accepts batches sent with a source API key.
Create labeled keys under **API keys** in the source details. Keep them in your collector's secret store.

## Choose which metrics to collect

For metrics sources, **Only these metrics (empty = all)** accepts family names or prefixes ending in `*`.
Separate entries with commas or newlines. An empty field includes every family.
Excluded families do not count toward sample or series limits.

The source shows refused histograms, skipped summary samples, and recent throttling.
Use these details to fix the endpoint or reduce the selected metrics.

## Ask questions when SQL is available

**Dashboards and questions are coming back** explains that SQL questions and new dashboards arrive with the next update.
Choose **Go to sources** to check collection now.
