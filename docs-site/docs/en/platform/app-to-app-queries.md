---
title: App-to-app reader checks
navTitle: App reader checks
section: Platform services
order: 566
description: Admit application-authority resource reader checks through Core without a person's mandate.
tags: [capabilities, identity, authorization, resources]
updated: 2026-10-29
---

# App-to-app reader checks

Use `types.X.access.readable` to let admitted applications check whether
concrete accounts can read a resource. The platform generates the app-only
Query; see [Resource types and discussions](/en/docs/platform/resource-types-and-discussions).
This answer authorizes no content access. Other background work keeps the
existing mandate path.

## Declare admission

The calling application declares
`platformPermissions: ["resources:readers"]` in `defineApp()`, just as it
would declare `mail:send`. Deploying that declaration admits reader checks;
there is no separate operator unlock for each application. **Administration →
Apps** shows **Check resource readers** with its other platform services.

Core resolves the caller from its workload credential and checks its current
registry declaration. The target Query must carry `appOnly: true`, generated
by the platform. Ordinary person, service-account, mandate, MCP, and Assistant
invocations receive 403 for this Query. REST, MCP, and AI person catalogs hide
it while retaining the Type's readable-availability projection. Core validates
that projection against the full manifest first: the exact `<type>.readable`
app-only Query must be available. An omitted or incompatible Query does not
advertise reader checks.

Admission is deliberately broad: an admitted app can ask about **any known
resource ref and candidate principals**, up to 1,501 × 500 account/resource
pairs per minute. Core does not bind candidates to discussion participants or
to the caller's own data. A discussion consumer must enforce its participant,
follower, and notification rules before querying. These are consumer rules,
not an extra platform admission boundary.

## Call through Core

`readResourcePrincipals({ ref, container?, principals, signal?, locale?,
requestId? })` from `@k2b/cloud/capabilities/server` resolves the generated
Query from the live provider manifest and uses the current process's app
identity. Configure `CLOUD_APP_CREDENTIAL` with an app-bound workload credential
scoped to `identity:invoke` and `CLOUD_CORE_INTERNAL_ORIGIN` with Core's direct
listener origin. Automatic workload provisioning is a separate contract.

Handle all three outcomes:

- `{ state: "checked", readable }`: only the returned principals passed.
  An empty array means not readable; omit their push.
- `{ state: "not_configured", reason }`: no readable function, credential,
  internal origin, process identity, or Core admission. Show the reason and
  omit push until configured. Core uses `APP_QUERY_NOT_ADMITTED` when the
  live caller entry lacks `resources:readers`; other authorization failures
  remain errors so an unavailable verification service can be retried.
- A thrown error: the check is temporarily unavailable or invalid. Let the
  consumer's bounded retry mechanism retry it. Do not treat failure as a
  negative readability result or enqueue a push based on a stale answer.

The typed capability client also supports `workload: { appId }` with Bearer
workload authorization for the generated Query. It calls
`POST /api/_internal/identity/v1/invoke` with `kind: "query"`, `targetApp`,
`capabilityId`, and `input`, omitting both mandate fields. A partial mandate
is invalid; supplying both fields retains mandate semantics. A mandate-free
call to another Query, an Action, or a stream is forbidden. The workload
credential stays on the Core hop, and redirects cannot forward it.

Core forwards a separate signed `app_query` token to the framework-owned
`/api/_internal/capabilities/v1/app-queries/:capabilityId` endpoint. The token
lasts 30 seconds and binds caller, target, operation, schema hash, exact input,
credential, and request ID. The provider checks the signature and live
credential status, expiry, `identity:invoke` scope, and app resource binding.
App tokens cannot enter the person authority resolver. App handlers receive
no grant-bearing subject and cannot exchange their invocation for a nested
Query. Execution history records the app as caller, without a person or
access subject.

Core limits these Queries to **1,501 requests per calling app per 60-second
weighted sliding window**, shared across providers and Types. HTTP 429 means
`RATE_LIMITED`. An unavailable limiter fails closed with HTTP 503. This is a
shared capacity limit, not a delivery throughput guarantee. Keep retries,
concurrency, cancellation, and notification timing bounded in the consumer.
