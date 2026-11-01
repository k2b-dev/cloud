---
title: Code bridge
navTitle: Code bridge
section: Platform services
order: 967
description: Authenticate runner requests and check each actual Code call against the current lease, policy, approval and mandate.
tags: [code, runner, capabilities, mandates]
updated: 2026-11-01
---

# Code bridge

Code in a runner reaches Cloud through `cloud.call(operation, input)`. Core
checks every actual call before forwarding it to a capability provider. A
checked manifest supplies review evidence; it grants no execution authority.
The provider still resolves the subject's current resource access.

## Authenticate a call

The private `POST /_internal/code/runner/call` endpoint accepts
`RunnerCallRequest` from `@k2b/cloud/code/runner`: `runId`, `generation`,
`token`, `operation` and JSON `input`. It requires both:

- A fresh Ed25519 `cloud-app+jwt` proof signed with an active key enrolled
  for app ID `runner`. The shared [app transport](/en/docs/operations/app-keys)
  binds the exact HTTP method, path and body, checks revocation, limits ingress
  through Valkey and consumes each proof once across Core replicas. The shared
  runner key has no fleet-wide call bucket; authenticated calls use Code budgets.
  The transport retains its per-peer ingress budget from
  `security.rate_limit_per_second` (default 60), shared by a runner replica
  across its slots. Transport overload returns 429; domain rate refusals return
  `code_rate_limited` in the successful HTTP envelope. Each accepted proof also
  prunes one expired proof for its key; scheduled maintenance drains inactive
  keys, so a growing runner fleet does not require a larger cleanup batch.
- A Core-signed run token for this attempt. An interactive session, another
  app's signature or a token without the runner signature cannot enter.

The supervisor attaches the attempt identity. The sandbox receives neither
the run token nor the runner's app key. Retrying a transmission requires a
fresh app proof. Reusing the run token is expected until the attempt ends.

## Run token contract

Import `CodeRunTokenClaims`, `CodeRunTokenInput`,
`CodeRunTokenClaimsSchema`, `signCodeRunToken`, `verifyCodeRunToken`,
`CODE_RUN_TOKEN_TYPE` and `CODE_RUN_TOKEN_MAX_SECONDS` from
`@k2b/cloud/code/run-token`.

The version 1 token is an RS256 JWT using Core's existing invocation key ring
and public invocation JWKS. Its protected header contains only `alg`, `typ`
(`cloud-code-run+jwt`) and `kid`. Its claims are:

| Field | Binding |
| --- | --- |
| `ver`, `token_use` | `1`, `code_run` |
| `iss`, `aud` | Installation issuer, `cloud-code-bridge` |
| `iat`, `nbf`, `exp` | Unix seconds; `nbf` equals `iat` |
| `codeId`, `versionId` | Exact Code and immutable version |
| `entrypoint`, `runId`, `generation` | Named entrypoint and one fenced attempt |
| `mandateId`, `mandateRevision` | Exact version mandate and its revision |
| `bundleHash` | Lowercase SHA-256 of the immutable UTF-8 bundle |

`signCodeRunToken(input, { deadlineAt })` takes the original attempt deadline
in Unix milliseconds. The lifetime is at most 300 seconds, matching the
maximum Code wall-clock setting; the signer must remain valid through expiry.
Heartbeats never extend this token. The verifier rejects expired tokens
without clock tolerance. Any Core replica verifies the token from the public
JWKS, with no token registry or sticky routing. Verification alone does not
check the live lease or grant access.

## Dispatch and record

For capability operations, `operation` is the qualified capability ID and
`input` is `CodeSdkInvocation`: `{ call, metadata }`. `call` contains
`capability`, `target`, `refs` and domain `input`; `metadata` contains only an
optional `idempotencyKey`. The operation must equal `call.capability`.
Idempotency keys follow the capability's existing required/none contract.

Core performs these checks for each call:

1. Check the token against the running row, current generation, unexpired
   lease, Code, version and entrypoint. The Code must be active. An old version
   may drain while a new active version accepts new work.
2. Compare the bundle and checked-version bindings. Check the current
   wall-clock setting and both the saved and current calls-per-run limits.
3. Commit the next bounded call observation in `code.calls` before forwarding
   an effect. Refused admitted calls also receive a failed observation;
   unauthenticated requests, invalid bindings and exhausted storage budgets
   cannot allocate observations.
4. Apply the shared Valkey rate limit per Code, using the installation's
   `core.code.calls_per_second` budget (default 60, maximum 1,000).
   Recorded refusals consume the calls-per-run budget, bounding retry loops.
5. Refuse streams, Actions with `code: false`, app-only Queries,
   `unattended: false`, asking Actions and every `code.access.*` operation.
6. Classify the actual operation from live capability metadata and resolve
   [current policy](/en/docs/platform/code-policy) with current groups. A Never
   rule refuses immediately. Admin approval must cover this actual policy row
   and remain bound to the exact source, bundle and manifest through
   [version evidence](/en/docs/platform/code-versions).
7. Bind the mandate to this version and the personal owner or credentialless
   Code account. The existing C2 dispatcher checks the exact operation/target
   pair, refs and fixed inputs against the current mandate. Steps 6–7 run
   inside the signing transaction, with a fresh fence check. Target applications
   check current resource rights. Immutable version hashes and submission
   bindings are checked without loading or hashing executable source or bundles
   on each call.
8. Save the result or refusal to the observation. A crash after reservation
   leaves a visible unfinished call; the execution coordinator reconciles it
   when terminating the attempt. Observations are never replay steps.

Generic mandate brokers cannot execute a `code.version` workload: those
calls must enter through this verified runner bridge. Code invocations do not
create child-invocation exchange leases, so provider nesting cannot bypass
the per-call bridge checks.

Responses use `RunnerCallResponse`: `{ ok: true, data }` or
`{ ok: false, error: { code } }`. Malformed sandbox calls return `code_invalid_call` in this envelope. Only
domain data and stable error codes enter
the sandbox. Provider error messages, exception text and transport credentials
do not. Stale generations and lost leases return HTTP 409 so the supervisor
stops that attempt. Transport/authentication failures use non-2xx responses;
ordinary capability refusals use the error envelope.

## Core integration

`@k2b/cloud/api` exports `createCodeRunnerCallRoutes`,
`CodeRunnerDispatchDependencies`, `CodeBridgeHost`, `CodeBridgeCall`,
`CodeBridgeAuthority`, `CodeBridgeRefusal` and `codeHttpOriginAllowed`.
These are Core host contracts, not application entry points. `withCall`
reserves and finishes the observation; every transport performing an effect
must use the returned `withMandateIssueAuthority` wrapper inside its issuance
transaction. C11 supplies `kind: "internet"`, which selects the `internet`
policy row and actual-row approval coverage; its C2 operation is `runtime.http`.
HTTP calls retain Action observations so recovery does not automatically repeat external effects.

Core's `createCodeBridgeHost()` and `createCodeBridgeRoutes()` implement the
storage and policy boundary in `packages/core/src/code/bridge.ts`.
`requireCodeRunFence(claims, db)` supplies the shared generation/lease check
for the execution coordinator's bundle, heartbeat and completion handlers.
Callers take locks in policy, Code, run order. Administrative budgets come
from `CODE_SETTINGS` and `codeSettings`.

`codeHttpOriginAllowed(url, ownOrigins)` rejects installation-owned origins,
credentials in URLs and non-HTTPS URLs. Hostname comparison ignores final DNS dots. Core includes configured app domains
and redirect hosts even while an application is offline. `http.fetch` already refuses own
origins; its Core HTTP dispatcher injects only version-bound
[Code secrets](/en/docs/platform/code-secrets) and uses `requestPublicHttps`. Other unknown operations return
`code_operation_not_found`. Capability requests must use the structured
capability envelope and cannot select an upstream URL.
