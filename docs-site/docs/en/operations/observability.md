---
title: Observability
navTitle: Observability
section: Operations
order: 1160
description: Use logs, traces, metrics, and health data to operate Cloud applications.
tags: [observability, health, logs]
updated: 2026-09-08
---

# Observability

Start with gateway health. Then narrow the problem to an application, route,
background source, or dependency.

## Check the deployment

```bash
cld admin status
cld admin apps list
```

Gateway health shows registered applications, route count, and healthy,
degraded, or offline instances.

Use `cld admin diagnose` for a bounded snapshot of health, logs,
telemetry, jobs, Postgres, Valkey, and metrics.

See [CLI modules](/en/docs/platform/cli-modules) for authentication and output
formats.

## Read logs

Use structured fields to filter by:

- application source;
- level;
- request ID;
- trace ID;
- route;
- actor or resource identifier when safe.

Do not log secrets, session tokens, authorization headers, prompts, or model
output.

See [Logging](/en/docs/platform/logging) for application APIs.

## Trace a request or operation

Request middleware publishes route templates to gateway telemetry.
`middleware.logger()` records 5xx, 429, 401, and 403 responses. Notifications
and structured AI create trace spans. Add explicit spans around other
application work when you need end-to-end tracing.

Use one trace to answer:

- where time was spent;
- which dependency failed;
- whether a retry ran;
- whether the operation finished or was abandoned.

See [Tracing](/en/docs/platform/tracing) for span APIs.

## Inspect routes and background work

Route telemetry uses the route template, not the concrete URL. This keeps one
series for `/api/inventory/items/:id`.

Sort by error rate to find unhealthy routes. Sort by requests to find the
highest traffic.

For background work, inspect the latest run and then its history. A stuck run is
an abandoned span, not proof that a worker is still active. The Sync page lists
queue, job, and topic-consumer dead letters. Topic recovery targets the original
consumer; historical entries without the original replay metadata remain
inspectable but cannot be replayed. Use the separate NATS page for broker nodes,
storage, stream replication, and consumer backlog. Follow
[NATS operations](/en/docs/operations/nats-operations) for diagnostics access,
recovery, health webhooks, and independent outage monitoring.

Use the dedicated pages for:

- [jobs and queues](/en/docs/automation/jobs-and-queues);
- [workflow observability](/en/docs/automation/workflow-observability-and-testing);
- [notifications](/en/docs/platform/notifications).

## Operate AI workloads

Use **Admin > AI > AI Usage** for bounded 24-hour, 7-day, 30-day, or 90-day
product and cost analysis. This is an AI administration surface rather than a
general observability page. It reports interactive turns, token and configured
credit usage, pricing coverage, model use, generation speed, per-user usage,
application capability calls and failures, mid-chat model switches,
application-launched chats, message ratings, and background AI failures.

Headline metrics and user/model comparisons combine chat and background inference.
Tool calls have separate counts and do not add inference charges. Missing token
or price measurements remain unavailable; reported zero values remain zero.
Credits follow configured model prices and are not a provider invoice.

Use the four views to inspect totals, compare users and models, read feedback,
and open complete stored errors. User, model, provider-model and application
filters apply across views. Filter chips apply selections immediately; data
notes are expandable.
Lists have bounded pagination; range, filters and snapshot time remain in the URL.
Charts use UTC buckets with localized dates and zero for inactive intervals.
The same reports, filters and run details are available through the admin CLI.
See [AI usage and feedback](../ai/usage-and-feedback.md) for metric definitions,
attribution limits, API access and CLI examples.

Retrying or editing a message preserves previously recorded chat token and
credit usage. Workflow inference is counted once through structured accounting;
workflow task status and retries remain available in the workflow views.
Compaction appears as `chat-compaction` in **Background AI**.

After upgrading, existing chat usage is recovered from messages still present.
Usage from responses already removed by an earlier retry cannot be recovered.
Compaction accounting starts with this update; older summaries, including copied
summaries, cannot reliably identify their original inference. Conversation
and user deletion still follow the existing data lifecycle. Historical reports
are therefore an operational cost signal rather than an immutable billing ledger.

The report uses durable AI facts and does not expose prompts or private message
content. Background records contain task, application, model, usage, duration,
repair information, and bounded error metadata. Feedback reasons and comments
are visible to administrators.

Monitor:

- queued, running, failed, and attention-needed turns;
- provider latency and errors;
- token usage;
- tool duration, approval, timeout, and failure;
- worker lease recovery;
- conversation file size;
- structured-task repair and failure counts.

Cloud tracing records model and tool metadata. It does not record prompt or
output content by default.

Set provider, tool, output, file, and worker limits before production. Test
provider failure, stream reconnect, abort, approval denial, and worker restart.

See [Chat interface](/en/docs/ai/chat-interface) for browser state and
shared chat components.

## Alert on user impact

Useful alerts include:

- gateway cannot reach a required application;
- a required application disappears from the registry;
- the orchestrator reports too few healthy replicas;
- route error rate or latency exceeds its threshold;
- background work is failed or stuck;
- Postgres or Valkey is unavailable;
- delivery queues grow without progress.

Alert on sustained conditions. A single failed request is not deployment
health.
