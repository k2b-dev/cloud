---
title: Code and server conventions
navTitle: Code and server
section: Conventions
order: 1282
description: Look up code structure and HTTP rules with their canonical owners and checks.
tags: [conventions, code, server, audit]
updated: 2026-10-15
---

# Code and server conventions

Use these rows with the [Conventions for Cloud applications](/en/docs/conventions) index
and [audit procedure](/en/docs/conventions/audit). Follow each canonical link
for the complete contract.

## Code (CODE)

| ID | Rule | Why | How to check | Canonical |
| --- | --- | --- | --- | --- |
| CODE-01 | Import Cloud through documented application entry points rather than internal source paths. | Application code works outside the monorepo. | `bun scripts/check.ts boundaries`; Manual: compare every Cloud import with the supported entry points and their guides. | [API surface](/en/docs/reference/api-surface#avoid-internal-imports) |
| CODE-02 | Use environment variables for infrastructure and Cloud settings for product configuration. | Operators can change product configuration through Cloud. | Manual: review each configuration value and compare its owner with the runtime configuration guide. | [Runtime configuration](/en/docs/operations/runtime-configuration) |
| CODE-03 | Built-in apps: declare each environment variable once in the registry with a schema, default, and scope. | Generated configuration has one source. | `bun scripts/check.ts config-docs`; Manual: compare app variables with the declarations named in the generated configuration reference. | [Configuration reference](/en/docs/operations/configuration#configuration-reference) |
| CODE-04 | Import Bun built-ins statically. | Dynamic Bun imports fail in the minified server bundle. | `bun scripts/check.ts bun-imports`; Manual: search imports of `bun` and replace dynamic runtime imports with static imports. | [Build output](/en/docs/operations/build-and-deploy#add-build-output) |
| CODE-05 | Keep server runtime files under `src/assets/` and resolve them with `appAssetPath()`. | File lookup survives bundling. | Manual: inspect server file reads for `appAssetPath()` and check that their inputs ship under `src/assets/`. | [Build output](/en/docs/operations/build-and-deploy#add-build-output) |
| CODE-06 | Export the final composed Hono router type for the browser client. | The client sees every mounted route without a separate response type. | Manual: trace the exported router type through all subrouters to the typed browser client. | [Final router type](/en/docs/server/http#export-the-final-router-type) |
| CODE-07 | Compare `event.source` with the expected window in every window `message` listener before acting on the message. | Any window can post a message to the page. | `bun scripts/check.ts message-listeners`; Manual: search for `addEventListener("message"` and `onmessage` and confirm each handler compares `event.source` with the expected window first. | [Browser-safe imports](/en/docs/frontend/islands-and-hydration#browser-safe-imports) |

## Server and HTTP (SRV)

| ID | Rule | Why | How to check | Canonical |
| --- | --- | --- | --- | --- |
| SRV-01 | Keep domain services independent of Hono and return `Result` for expected failures. | API, SSR, and background callers share business rules. | Manual: inspect service inputs for Hono contexts and check missing-resource and denied-operation results. | [Services and Result](/en/docs/server/services-and-results#keep-services-independent-from-hono) |
| SRV-02 | Convert service results to JSON with the shared response helpers. | HTTP status and error shape follow the service result. | `bun scripts/check.ts service-api-contracts`; Manual: trace JSON handlers through `respond()` or `respondMessage()` and inspect their statuses. | [Result to HTTP](/en/docs/server/services-and-results#convert-a-result-to-http) |
| SRV-03 | Return safe public errors and log private diagnostics separately. | Failures do not expose SQL, credentials, paths, or upstream bodies. | Manual: inspect exception mappers and trigger an infrastructure failure with demo data. | [Unexpected failures](/en/docs/server/services-and-results#handle-unexpected-failures) |
| SRV-04 | Pass `c.req.raw.signal` to costly request work. | Client disconnection stops upstream work. | Manual: trace the request signal into provider calls and cancel a running request. | [Request cancellation](/en/docs/reference/route-conventions) |
| SRV-05 | Raise the idle timeout with `setRequestTimeout()` for slow handlers and restore it in `finally` when answering. | Slow responses finish without changing later keep-alive requests. | Manual: inspect handlers that need more than 10 idle seconds for a bounded timeout and restoration on success and failure. | [Slow requests](/en/docs/server/http#answer-slow-requests) |
| SRV-06 | Align served prefixes, Hono mounts, and the live gateway registration. | Declaring a prefix alone does not make a route reachable. | Manual: compare declarations and mounts, verify registration, and request each public prefix through the gateway. | [Route mounts](/en/docs/build/routing#mount-the-same-paths-in-hono) |
| SRV-07 | Validate request values before passing them to a service. | Invalid wire input never reaches business operations. | Manual: inspect JSON, query, path, header, cookie, and form inputs and send invalid values to each used surface. | [Request validation](/en/docs/server/http#validate-every-request-value) |
| SRV-08 | Apply search, filters, sorting, access, and pagination on the server before returning a list. | Results and totals describe the same authorized collection. | Manual: trace list inputs into the SQL predicates, sort mapping, count, limit, and offset. | [Server list decisions](/en/docs/server/pagination-and-filtering#apply-every-list-decision-on-the-server) |
| SRV-09 | Add a unique tie-breaker to list ordering. | Equal sort values cannot move rows between pages. | Manual: inspect list ordering and paginate demo rows with equal primary sort values. | [Stable ordering](/en/docs/server/pagination-and-filtering#use-stable-ordering) |
| SRV-10 | Keep one pagination response shape per endpoint. | Consumers receive a consistent list envelope. | Manual: compare every branch of a list endpoint with its chosen SQL or in-memory envelope. | [Pagination shapes](/en/docs/server/pagination-and-filtering#keep-one-shape-per-endpoint) |
| SRV-11 | Request person-, administrator-, or remote-content-chosen URLs through `requestPublicHttps()`, or through the platform network guard for other transports. | Chosen destinations cannot reach private networks. | `bun scripts/check.ts network-guard`; Manual: trace chosen URLs to `requestPublicHttps()` with a deadline and byte limit, search for `fetch()` or DNS lookups on them, and verify refusal of an internal address. | [Public HTTPS requests](/en/docs/data/secrets-and-persistent-state#call-a-public-https-address) |
| SRV-12 | Publish OpenAPI metadata that matches the mounted routes, enforced policies, statuses, and response bodies. | The advertised API describes reachable behavior. | Manual: compare the OpenAPI document with route mounts and exercise documented success and rejection responses. | [OpenAPI publication](/en/docs/server/http#publish-openapi) |
