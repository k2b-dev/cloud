---
title: Access and data conventions
navTitle: Access and data
section: Conventions
order: 1283
description: Look up authorization, persistence, and effect rules with their canonical owners and checks.
tags: [conventions, identity, access, data, audit]
updated: 2026-10-15
---

# Access and data conventions

Use these rows with the [Conventions for Cloud applications](/en/docs/conventions) index
and [audit procedure](/en/docs/conventions/audit). Follow each canonical link
for the complete contract.

## Identity and access (ACC)

| ID | Rule | Why | How to check | Canonical |
| --- | --- | --- | --- | --- |
| ACC-01 | Use route policies for handler entry and service checks for resource authorization. | Authentication alone does not grant access to a resource. | Manual: compare each API and SSR policy with the resource checks in its service. | [Route policies](/en/docs/identity/route-policies#repeat-resource-checks) |
| ACC-02 | Make API, SSR, background, and CLI paths reach the same permission-aware resource service. | Alternate callers cannot bypass authorization. | Manual: trace every resource reader and writer into the shared authorized operation and test a denied subject. | [Resource authorization](/en/docs/identity/authorization#resource-authorization) |
| ACC-03 | Use `actor` for identity, audit, and credential limits and `accessSubject` for grants. | Request provenance stays separate from permission resolution. | `bun scripts/check.ts boundaries`; Manual: inspect service inputs and grant resolvers for actor and access-subject use. | [Service identity](/en/docs/identity/authorization#check-inside-the-service) |
| ACC-04 | Protect SSR entry and render only data returned by the permission-aware service. | A page login cannot expose a forbidden resource. | Manual: load a protected page directly as a subject without access and inspect its service call. | [SSR authorization](/en/docs/identity/authorization#repeat-the-check-for-ssr) |
| ACC-05 | Apply resource permission predicates inside list SQL. | Unauthorized rows never enter the result or its count. | Manual: inspect list and count queries for the shared access predicate and exact resource-bound restrictions. | [Authorized lists](/en/docs/identity/authorization#filter-lists-in-sql) |
| ACC-06 | Keep at least one manager when changing grants with the resource locked and authorization checked in the same transaction. | Concurrent grant changes cannot leave a resource unmanaged. | Manual: inspect grant mutations for `ensureManagerRemains()` and test concurrent removal of the last managers. | [Last manager](/en/docs/identity/authorization#keep-at-least-one-manager) |
| ACC-07 | Enforce destination authorization independently of navigation visibility. | Hidden or restricted links cannot protect a directly requested URL. | Manual: request each `nav` and `adminHref` destination directly as a subject outside its `requiresRoles` or `requiresAuth` audience and confirm that the route policy or service denies it. | [Global navigation](/en/docs/build/define-app#add-global-navigation) |
| ACC-08 | Lower grants to credential scopes for every service account without a delegated user, require an exact binding for resource-bound accounts, and let user-delegated actors use their user grants. | Scopes cannot create access or widen a resource binding. | Manual: test a resource-bound binding mismatch, a resource-bound, standalone, or agent account with narrower scopes than its grants, and a user-delegated request, which keeps its user grants. | [Credential limits](/en/docs/identity/authorization#limit-resource-bound-credentials) |
| ACC-09 | Require a user-backed resource administrator to create, list, or revoke resource API keys and verify the selected account or credential's binding. | An account or credential ID alone cannot authorize key management. | Manual: inspect all key routes and try a credential belonging to another demo resource. | [Resource key management](/en/docs/identity/resource-api-keys#create-a-resource-api-key) |
| ACC-10 | Send interactive cross-app capability credentials through the Core-backed adapter. | Core dispatches a target- and operation-bound invocation. | Manual: trace cross-app capability calls to the server adapter and verify that the original credential goes only to Core. | [Capability invocation](/en/docs/platform/capabilities#invoke-capabilities) |
| ACC-11 | Store one revocable mandate per durable cross-app workload instead of a user's session or personal key. | Background work has bounded authority beyond the session lifetime. | Manual: inspect persisted workload authority and mandate confirmation before the first invocation. | [Workload mandates](/en/docs/identity/background-mandates#create-one-mandate-with-the-workload) |
| ACC-12 | Persist the current mandate revision, pause it with the workload, and revoke it when the workload is deleted or permanently disabled. | Paused, stale, or deleted work cannot issue new invocations. | Manual: pause and delete a demo workload, then verify broker rejection and revision reload on policy changes. | [Mandate lifecycle](/en/docs/identity/background-mandates#handle-lifecycle-and-retries) |

## Data and effects (DATA)

| ID | Rule | Why | How to check | Canonical |
| --- | --- | --- | --- | --- |
| DATA-01 | Keep durable domain data in application-owned Postgres, distributed coordination in Sync on NATS, and bounded caches or rate limits in Valkey. | Durable records survive cache eviction and process replacement. | Manual: map each stored value to the store and owner named in the data guide. | [Data stores](/en/docs/data#choose-the-store) |
| DATA-02 | Commit domain state before effects and write crash-recoverable effects to an outbox in the same transaction. | A committed change cannot lose its required effect. | Manual: trace transaction and delivery order and stop a demo process after commit to verify recovery. | [Effects after commit](/en/docs/data/migrations-and-transactions#run-side-effects-after-commit) |
| DATA-03 | Pass the transaction into every helper participating in an atomic write. | Related writes commit or roll back together. | Manual: trace each multi-write operation and verify that no participating helper uses the ambient SQL client. | [Atomic writes](/en/docs/data/migrations-and-transactions#keep-related-writes-atomic) |
| DATA-04 | Run short, repeatable schema migrations during lifecycle setup without migrating platform-owned tables. | Every instance prepares compatible state safely. | Manual: inspect `src/migrate.ts` and setup wiring and run migration twice against a test database. | [Schema migrations](/en/docs/data/migrations-and-transactions#create-the-schema) |
| DATA-05 | Move data-sized migrations out of startup into bounded, resumable batches. | Production data volume cannot hold startup indefinitely. | Manual: inspect backfills for expand, backfill, cutover, cleanup, and committed progress that survives a retry. | [Large migrations](/en/docs/data/migrations-and-transactions#move-large-changes-out-of-startup) |
| DATA-06 | Use one immutable canonical public ID across every public surface when adopting short IDs. | Callers never choose between a short ID and a storage key. | Manual: compare IDs in URLs, API results, capabilities, search, CLI output, and live events. | [Public identity](/en/docs/data/public-resource-identifiers#use-one-identity-everywhere) |
| DATA-07 | Put fixed credentials in `secret` settings and keep their runtime values out of browsers and logs. | Other setting kinds expose their values to administration UI. | Manual: inspect credential setting kinds and their read paths for browser or log exposure. | [Fixed secrets](/en/docs/data/secrets-and-persistent-state#store-fixed-secrets-in-settings) |
| DATA-08 | Store growing user or resource credentials in encrypted application tables and return only metadata to the browser. | Runtime credential collections do not become exposed settings. | Manual: inspect credential persistence, decryption paths, and browser response projections. | [Growing credentials](/en/docs/data/secrets-and-persistent-state#store-growing-credentials-in-an-application-table) |
| DATA-09 | Validate untrusted job payloads and bound queue payloads, retention, concurrency, and retry attempts. | Backlogs and retries stay within the declared work and storage budget. | Manual: inspect runtime payload validation and delivery limits against the expected backlog and test terminal failure handling. | [Jobs and queues](/en/docs/automation/jobs-and-queues#use-a-queue) |
| DATA-10 | Use one topic per kind of log with entity IDs as `tenantId`, rather than one topic per entity. | JetStream storage reservations do not multiply with entity count. | Manual: inspect topic declarations and verify tenant IDs on publications and reads. | [Shared log topics](/en/docs/automation/topics-and-live-events#keep-one-topic-per-kind-of-log) |
| DATA-11 | Reload an authorized snapshot after a topic retention gap instead of saving partial replay as complete state. | Removed events cannot silently corrupt reconstructed data. | Manual: inspect gap handling and replay demo events from a cursor outside the retained window. | [Replay and resume](/en/docs/automation/topics-and-live-events#replay-and-resume) |
| DATA-12 | Reconcile ambiguous workflow effects instead of repeating an effect that may already have happened. | A crash or lost response cannot duplicate an irreversible effect. | Manual: inspect effect classes and reconciliation hooks and simulate a provider success with a lost response. | [Ambiguous effects](/en/docs/automation/effects-retry-and-reconciliation#reconcile-ambiguous-effects) |
