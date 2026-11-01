---
title: Test Code
navTitle: Test Code
section: Platform services
order: 682
description: Test and simulate Code with declarative fixtures in the production sandbox without changing real data.
tags: [code, testing, fixtures, runner]
updated: 2026-11-01
---

# Test Code

Keep test cases next to `code.ts` in `test/`. Tests and simulations run the
checked bundle in the same workerd sandbox as production. Every capability
call goes to a fake bridge. A missing mock fails the test; it never falls
through to a real capability or real data.

The Phase 1 test kit supplies the server contract for `cld code test`,
`cld code simulate`, and Gustav tools. Their command and tool adapters consume
the same versioned JSON result. The test kit does not install those adapters.

## Write a case

A case is a JSON file such as `test/weekly.json`. It names an entrypoint from
the [checked version](/en/docs/platform/code-checker), supplies a clock and
seed, and lists mock replies by operation and exact target.

For a schedule named `weekly` that creates an item in `workshop-finance`:

```json
{
  "version": 1,
  "name": "weekly item is created once",
  "now": 1893571200000,
  "seed": 42,
  "mocks": [
    {
      "operation": "work-shop.item.create",
      "target": { "type": "work-shop.workshop", "id": "workshop-finance" },
      "replies": [{ "ok": true, "data": { "id": "fixture-item" } }]
    }
  ],
  "runs": [
    {
      "entrypoint": "weekly",
      "expect": {
        "ok": true,
        "calls": [{ "replayed": false, "result": { "ok": true, "data": { "id": "fixture-item" } } }]
      }
    },
    {
      "entrypoint": "weekly",
      "expect": {
        "ok": true,
        "calls": [{ "replayed": true, "result": { "ok": true, "data": { "id": "fixture-item" } } }]
      }
    }
  ]
}
```

The schedule uses the same idempotency key and input in both runs. The first
run consumes the reply; the second returns the retained result. A changed
input, target or reference with that key reports `idempotency_conflict`.
Actions declaring `idempotency: "none"` execute again and consume another
reply. Keys are scoped by operation within one case's fictional Code account.
Successful receipts last for that case; separate cases start fresh.

Mocks can include `input` and `refs` for exact matching. A more specific mock
wins over a general mock; equally specific matches fail with
`code_test_ambiguous_mock`. Replies are consumed in order. Exhaustion reports
`code_test_mock_exhausted`. Input and successful reply data must satisfy the
operation's manifest schemas. Use `{ "ok": false, "error": "not_ready" }` to
simulate a domain refusal. Failed replies do not create successful receipts.
AI operations and any future secret operations use the same explicit mocks;
there is no live AI or secret lookup. Put only fictional values in fixtures.

## Control time and check results

`now` is Unix milliseconds. `Date.now()` and `new Date()` use that instant,
including during module initialization. A run may override `now` to test a
later date. Schedules run when the test invokes their entrypoint; the kit does
not wait for cron or advance timers. `Math.random()` uses the supplied unsigned
32-bit seed, reset for each invocation. Cryptographic randomness is not seeded.

Use `input` on a run to pass JSON to a `code_run` entrypoint. Schedule callbacks
have no input parameter. `expect.value` checks the returned JSON value; a
schedule returning nothing produces null. `expect.calls` checks the exact
number and order of calls and the supplied fields of each call.

Every case result includes its source `file` (`null` for simulation), so failures
can be located even when cases have the same name. Every result includes the ordered normalized calls, idempotency keys, replay
flags, and replies or refusal codes. A failed assertion lists its field in
`failures`. To expect a domain failure, set both `expect.ok: false` and
`expect.error`. Missing or invalid fixtures and exceeded budgets always fail,
even when the Code catches the exception. Trace output adds run start and
completion events; the call list is present with or without trace.

Simulation uses one invocation with fixture data and the same fake bridge.
It creates no durable Code version, production run, or effect. Source check
failures, including dynamic resource targets, stop before sandbox execution.
No network or process environment is available to the Code. Passing tests
grants no access; production still checks the version mandate and current
resource rights on every call.

## Consume the server contract

Platform hosts import `CodeTestCaseSchema`, `CodeTestResultSchema`,
`CODE_TEST_RESULT_JSON_SCHEMA`, `CodeTestLimitsSchema`, `CodeTestExecutionCaseSchema`,
`codeSdkHash`, and their types from
`@k2b/cloud/code`. Result `version: 1` is the CLI/chat compatibility boundary.
`mode` is `test` or `simulate`; `ok`, `error`, `diagnostics`, and `cases` are
always present. Times, process IDs, stacks, and real credentials are absent. Runner checks
the exact bundle hash and the canonical `codeSdkHash` against the checked
manifest before using either artifact.

Core exports `testCode`, `simulateCode`, `CodeTestingHost`, `CodeTestRequest`,
and `CodeSimulateRequest` from its Code service. The trusted host supplies
SDK metadata, budgets, a checker executor backed by the isolated `checkCode`
role, and a `CodeTestExecutor` backed by Runner. Core needs neither compiler
nor workerd binaries in its own image.
`testCode` reads sorted `test/**/*.json` files as data and checks source with
`checkCode` before calling the executor. `simulateCode` accepts one case with
exactly one run. These services do not activate versions or create production runs.

Runner exports `createCodeTestExecutor` from `packages/runner/src/test-kit.ts`.
The runner image also includes `code-test.js`, a trusted stdin/stdout role for
hosts that launch a process. Its input is `{ execution, config, limits }`;
`execution` has the checked bundle, manifest, generated SDK and cases, each with `{ file, fixture }`. It uses
no app key or Core URL. The runner supervisor launches it as PID 1 in a fresh user, PID, mount and
network namespace through the mandatory `job-isolate` launcher. The role refuses other process placement. The executor
API likewise requires one supervisor per PID namespace; repeated invocations
in that supervisor share the engine's UID allocator.

Budgets come from the host's Administration > Code settings and checker and
transport limits, never the author fixture. They bound request bytes, result
bytes (at least 256), cases, total invocations, calls per invocation and total
wall time. Runner configuration also bounds individual bridge messages,
concurrency and process memory. The process role caps stdin at the checker's
request-byte and time budgets. Cancellation closes and reaps the workerd
engine; a time, call or output limit leaves a machine-readable failure.

### Connect CLI and Gustav adapters

Use `await createRunnerCodeTestingHost(context)` from Core's Code service as
the production `CodeTestingHost`. Build `request.code` with
`createCodeCheckRequest(codeId, files, entry, context)`, then call
`testCode(request, host, signal)` or `simulateCode(request, host, signal)`.
Both services first check the source remotely. The host sends the checked
bundle, SDK and fixtures as a `test` or `simulate` job to the same runner pool.
No test source runs inside Core. Result schemas and fake-call semantics are
identical for the CLI and Gustav.

Jobs and production runs share the advertised free-slot count. Core alternates
between eligible runs and jobs across replicas, so a burst of checks cannot
starve scheduled runs. Jobs have no production bridge token. A lost lease
requeues fake-only work within its existing deadline and retry budget.

Forward cancellation to both the service and its host context. Cancellation
or timeout fences the lease; the runner stops the isolated role. Queue
admission returns `code_job_busy` when full. The test/simulate services preserve
that stable code in their failure result so adapters can offer a retry.

Administration defaults to 64 cases and 200 total fixture invocations per test
job. Calls and total wall time use the existing Code execution budgets.
