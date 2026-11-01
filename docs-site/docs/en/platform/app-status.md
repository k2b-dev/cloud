---
title: App status providers
navTitle: App status providers
section: Platform services
order: 567
description: Publish administrator-only traffic summaries, failed requests, and offline listing removal through a shared capability role.
tags: [capabilities, app-status, monitoring]
updated: 2026-10-30
---

# App status providers

Offer traffic and failed requests to Cloud's app administration by declaring
`appStatus` in `defineCapabilities()`. Any application can provide this role.
Core discovers providers through the capability catalog and shows each one's
figures with its catalog name. Registry and Core data determine app identity,
running state, permissions, and whether an app can be removed.

## Declare the role

Import the six input and data schemas from `@k2b/cloud/contracts`. Declare two
Queries and one Action, then point the role at their local IDs. This complete,
stateless provider reports no measurements and forgets offline apps idempotently:

```ts
import { defineCapabilities, listApps } from "@k2b/cloud";
import {
  AppStatusSummaryInputSchema, AppStatusSummaryDataSchema,
  AppStatusDetailInputSchema, AppStatusDetailDataSchema,
  AppStatusForgetInputSchema, AppStatusForgetDataSchema,
  type CapabilityExecutionContext,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";

const adminError = (context: CapabilityExecutionContext) => {
  const authority = context.authority;
  const user = authority?.actor.kind === "user" ? authority.actor.user : authority?.actor.delegatedUser;
  return authority && user?.roles.includes("admin") && authority.accessSubject.type === "user" && authority.accessSubject.userId === user.id
    ? null : fail(err.forbidden("Administrator access required"));
};
export const monitoringCapabilities = defineCapabilities({
  protocolVersion: 2,
  appStatus: { summary: "status.summary", detail: "status.detail", forget: "status.forget" },
  queries: {
    "status.summary": {
      title: "Read app traffic", description: "Return traffic for selected apps.", openWorld: false,
      input: AppStatusSummaryInputSchema, data: AppStatusSummaryDataSchema,
      run: async (input, context) => adminError(context) ?? ok({ data: {
        apps: AppStatusSummaryInputSchema.parse(input).appIds.map(appId => ({ appId, traffic: null, links: [{ kind: "metrics", label: "Monitoring", href: "/admin/monitoring" }], lastSeenAt: null })), otherApps: [],
      } }),
    },
    "status.detail": {
      title: "Read app failures", description: "Return route totals and one page of failed requests.", openWorld: false,
      input: AppStatusDetailInputSchema, data: AppStatusDetailDataSchema,
      run: async (_input, context) => adminError(context) ?? ok({ data: { routes: [], failedRequests: [], nextCursor: null, totalFailedRequests: null } }),
    },
  },
  actions: {
    "status.forget": {
      code: false,
      title: "Forget app status", description: "Forget status records for an offline app.",
      input: AppStatusForgetInputSchema, data: AppStatusForgetDataSchema,
      destructive: false, openWorld: false, idempotency: "required",
      run: async ({ appId }, context) => {
        const denied = adminError(context); if (denied) return denied;
        const authority = context.authority;
        const kind = authority?.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority?.credentialKind;
        if (kind === "oauth" && !authority?.scopes.some(scope => scope === "write" || scope === "admin")) return fail(err.forbidden("Write scope required"));
        if ((await listApps()).some(app => app.id === appId)) return fail(err.badInput("Only offline apps can be forgotten"));
        return ok({ data: { forgotten: true } });
      },
    },
  },
});
```

Pass this declaration to `app.start({ capabilities: monitoringCapabilities,
fetch })`. See [App capabilities](/en/docs/platform/capabilities#declare-the-surface)
for the complete application startup pattern. Replace the empty results with
your own measurements; keep domain reads and authorization inside your app.
The example is checked in `docs-site/examples/cloud-docs/platform-app-status.ts`.

The role points to local IDs, not fixed operation names. Gateway's first
provider uses `app-status.summary`, `app-status.detail`, and `app-status.forget`. The forget
Action keeps its `appId` input and declares `code: false`: it addresses a foreign
application, not a resource Type owned by the status provider. This reviewed
exception to [Action targets](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on)
retains the shared provider contract for built-in and third-party providers.
Providers declare `code: false` on their forget Action.
Startup rejects incompatible declarations; registry readers omit incompatible
roles, and consumers check compatibility before calling. Both Queries must be
closed-world and person-readable. The forget Action requires idempotency.

## Return summaries

`AppStatusSummaryInputSchema` accepts `{ appIds, window }`. There must be
1–200 application IDs. `window` is `1h`, `6h`, `24h`, `7d`, or `30d`.
`AppStatusSummaryDataSchema` returns:

```ts
{
  apps: [{
    appId: "inventory",
    traffic: { requests: 120, errors: 2, avgMs: 18.5 },
    links: [{ kind: "metrics", label: "Monitoring", href: "/admin/monitoring" }],
    lastSeenAt: "2026-10-30T12:00:00Z",
  }],
  otherApps: ["retired-inventory"],
}
```

`traffic: null` means **no measurements**, never zero requests. Counts are
nonnegative integers; `avgMs` may be null. Providers choose their error
classification and keep it consistent across summaries, routes, and details.
Gateway counts status codes from 500 and requests with an `error_kind`.

Return at most four links per app, with root-relative `/admin/` destinations.
Set the optional `kind` to `logs`, `metrics`, `routes`, or `capabilities` so
consumers can place links without inspecting provider paths or translated
labels. A link without `kind` appears under **More**, using its label.
Labels are final display strings in `context.locale`; Core forwards the
request locale. Resolve labels through the provider's message catalog.

`lastSeenAt` is an optional ISO timestamp or null, describing
when this provider last saw the app. It can differ from Core's registry time.

Gateway returns all four kinds: logs, telemetry filtered by app and observation
window, gateway routes searched by app ID, and capability executions filtered
by app ID.

`otherApps` contains up to 50 distinct IDs known to the provider that were not
requested. Include their rows in `apps` to supply timestamps and figures; the
array accepts up to 250 rows, covering 200 requested and 50 additional apps.
Rows must name a requested app or one of `otherApps`, without duplicates.
A provider may omit apps it does not know.

## Return details

`AppStatusDetailInputSchema` accepts `{ appId, window, cursor? }`.
`AppStatusDetailDataSchema` returns:

- `routes`: up to 200 `{ prefix, requests, errors }` records for the app's
  registered routes;
- `failedRequests`: up to 50 `{ at, method, path, status }` records;
- `nextCursor`: an opaque continuation string, or null when finished;
- `totalFailedRequests`: an optional count or null when unavailable.

`at` is ISO time, `status` is an HTTP status, and `path` may be a route
template. Cursors belong to one provider, app, and observation window. Gateway
uses timestamp and ID ordering, preserving microseconds when requests share a
timestamp. Raw request retention can be shorter than rollup retention, so a
long-window summary can outlive its individual failed requests.

## Preserve authority and the response budget

Every provider checks the incoming `context.authority` for administrator access
for each Query and Action. Core passes the administrator's verified
`RequestAuthority` through the existing capability invocation path, with no
technical identity fallback. OAuth mutations require `write` or `admin`.
A catalog entry is discovery, not permission.

Core gives one render a shared 1.5-second deadline, 512 KiB of catalog and
response data, four concurrent calls, and eight providers. Discovery and
all operations spend the same budget. Received invocation bytes count before
JSON or result validation, including invalid replies. The shared server client
supports request-local accounting through `CapabilityCaller.consumeResponseBytes`;
the in-process catalog is charged by its serialized result size.

Core's reader retains usable results and returns `failures` with `unavailable`,
`denied`, `timeout`, or `invalid`. Entries beyond 200 requested app IDs appear in
`truncated`. Discovery failures use `{ appId: "core", name: "App status discovery" }`
as their source. Providers beyond eight remain visible as unavailable.
Consumers show failures in place with a retry action.

Core maintainers create one `createAppStatusReader()` from
`packages/core/src/app-status.ts` per SSR render, then use its
`readAppStatusSummaries(params)` and `readAppStatusDetail(params)` methods.
Use the same authority object and locale for both. Standalone functions create
a fresh reader for one operation. For pagination with several providers, pass
`providerAppId` along with that provider's cursor.

## Forget an offline app

`AppStatusForgetInputSchema` accepts `{ appId }`;
`AppStatusForgetDataSchema` returns `{ forgotten: boolean }`.
The Action forgets the provider's retained app listing and stops any offline
audit. It refuses a running app. An already forgotten app succeeds, so a
failed multi-provider operation can be retried. `forgotten: false` is a failed
removal from Core's perspective.

Core's administrator-only `DELETE /api/admin/apps/:appId/listing` keeps keys,
tokens, grants, and subscriptions. It rejects a live app or a rejected registry
entry at `apps/<appId>` with HTTP 409 and `app_running`. Rejected entries for
other apps do not block removal. It hides the listing only after every reporting provider
succeeds. An unavailable provider or failed forget returns HTTP 503 with
`forget_failed` and keeps the app visible. Core retains reporting provenance
so an offline provider cannot silently disappear from this step. A live
registry lease makes a hidden app visible again.

Gateway keeps its existing `DELETE /api/gateway/apps/:id` endpoint for older
clients. For rollout and the additive Core migration, see
[Build and deploy](/en/docs/operations/build-and-deploy#roll-out-app-status-providers).
