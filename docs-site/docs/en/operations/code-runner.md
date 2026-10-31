---
title: Code runner
navTitle: Code runner
section: Operations
order: 1155
description: Configure, scale, and stop the stateless workerd runner for Code.
tags: [code, runner, scaling, shutdown]
updated: 2026-10-31
---

# Code runner

The `runner` service executes Code bundles in workerd. Add replicas with
`--scale runner=N`; every replica uses the same app key. Core owns durable run
state, scheduling, generation fencing, and leases. Runners keep only active
attempts and a bounded bundle cache in memory.

The runner shell currently has a mock bridge for tests. The Core Code bridge
and queue arrive with the execution slice; until then a runner reports
`runner_configuration_unavailable` and retries without accepting work. App-key
signing and Core's refusal to deliver installation connections are active.

## Configure the service

Register an Ed25519 key for app ID `runner` using
[App keys](/en/docs/operations/app-keys). Mount its private key as
`CLOUD_APP_KEY_FILE`, or provide `CLOUD_APP_KEY` directly. Setting both refuses
startup. The key must belong to `runner`. Set `CLOUD_CORE_INTERNAL_ORIGIN` to
Core's direct private HTTP(S) origin, without a path or credentials.

These are the only runner application environment inputs. Never inherit the
shared app environment. The runner does not load the normal application
runtime, request installation connections, or register public routes. Core
rejects a bootstrap request signed by any `runner` key with
`connections_not_permitted`, even if the key's connection grant is enabled.
The same key can still sign runner requests.

For development, first start Core, sign in with the workspace CLI, then enroll
and write the key through that CLI (use the development profile explicitly):

```sh
bun run dev:cld -- --profile dev admin apps keys create runner --out-dir ./.local/app-keys --uid 1000
```

The image runs as UID 1000. Mounted key files must be readable by that user;
keep them private (`0600`) and ensure their parent directories can be traversed.
For production, use your explicit administrator profile with
`cld --profile operator admin apps keys create runner --out-dir ./secrets --uid 1000`.

The development template reads `./.local/app-keys/runner.key`; production reads
`./secrets/runner.key`. Neither file belongs in Git. Both templates mount it at
`/run/secrets/runner-app-key`. Only Core and runner share the internal
`runner-core` network. Runner has no published port, writable root filesystem,
infrastructure environment, or persistent volume. Temporary workerd host
configuration lives in a bounded `/tmp` tmpfs; bundles never go to disk.

The image pins workerd to `1.20261028.1` and runs as an unprivileged user. Its
Compose cgroup memory budget is 1 GiB with 256 process slots. These are host
resource allocations, not Code execution settings. Budget replicas accordingly.
Core supplies each replica's run and bridge concurrency, process memory, cache, transport,
and bundle budgets from administration settings; the runner adds no limit env.
Configuration is read once per process; restart replicas after changing these
budgets. Keep Core and runner host clocks synchronized, since leases and run
deadlines use Unix milliseconds.

## Add replicas

From the deployment directory, with Core already running and the app key mounted:

```sh
docker compose -f compose.prod.yml up -d --scale runner=3 runner
```

For development, use `compose.dev.yml` with `--profile runner` and `--build`.
This separate opt-in profile keeps `dev:full` usable before the runner key has
been provisioned; start the runner directly with Compose.
The runner has no `container_name`, instance-specific key, disk cache, or
host-port mapping. Its random process ID is telemetry; ownership always comes
from the lease and generation Core returns.

A replica advertises only its free slots in a signed long-poll. Core must grant
no more leases than that count. The runner rejects an oversized or duplicate
batch. Bundles are fetched by SHA-256 and verified before entering the local
LRU cache. Replicas do not coordinate with each other or connect to NATS,
Postgres, or Valkey.

## Stop and recover

SIGTERM and SIGINT cancel the outstanding long-poll and stop further
acquisition. Accepted attempts keep running and sending heartbeats until they
finish or reach their original wall-clock deadline. A late poll response is
ignored. No shutdown wait renews that deadline.

Both Compose templates allow six minutes before SIGKILL. Keep
`stop_grace_period` above the largest configured Code wall-clock budget plus
completion transport time. A process killed before drain loses its leases;
Core must reconcile them. A failed completion report logs
`runner_completion_unavailable` and also leaves recovery to Core.

An expired lease stops its sandbox. Heartbeat outages report
`runner_heartbeat_unavailable` and retry until the current lease expires.
`runner_fetch_unavailable` retries acquisition without resetting active run
budgets. Logs contain stable codes, never run tokens, bundle exceptions, or
bridge payloads. A run is one attempt; Core decides whether an interrupted
attempt may be scheduled again.

Each organization and trust tier gets a separate workerd process. Every
attempt loads a fresh dynamic worker through the Loader API, with
`globalOutbound: null` and only a `cloud.call(operation, input)` RPC binding.
Core credentials and run tokens remain in the supervisor. Bridge calls above
the per-run concurrency budget fail immediately, without queuing. The supervisor
checks process RSS and pings workerd every 100 ms; a process that stops
responding for one second is killed along with its active attempts. Other
process groups continue. The container cgroup also bounds aggregate memory.

## Integrate the bridge

Core and runner consumers import protocol types and strict schemas from
`@k2b/cloud/code/runner`. `RUNNER_PATHS` names the private POST routes for
configuration, run acquisition, bundle download, heartbeat, completion, and
bridge calls. `RunnerBridge` is the mockable transport seam. C13 implements
the Core side; the runner shell uses `CoreBridge` with real Ed25519 signatures.

Each HTTP transmission, including retry, signs its exact method, path, and
UTF-8 body through `signAppProof` from `@k2b/cloud/app-proof`. Core must verify
the enrolled `runner` identity, current key state, installation, body digest,
and fresh nonce before granting work. For run-scoped routes, it must also
verify `RunnerLeaseProof` against the current run generation and deadline.

`RunnerFetchRequest` carries `instanceId` and `freeSlots`.
`RunnerFetchResponse` contains `RunnerLease` values: immutable code/version,
organization and trust tier, entrypoint, generation, mandate revision,
bundle hash, opaque token, JSON input, and absolute deadlines in Unix
milliseconds. `RunnerHeartbeatRequest` carries the lease proof;
`RunnerHeartbeatResponse` extends only `leaseExpiresAt`, never `deadlineAt`.
`RunnerBundleRequest` includes the hash; its response is exact UTF-8 ESM.
`RunnerCompleteRequest` carries a payload-free `RunnerOutcome`.
`RunnerBundleRequestSchema`, `RunnerCompleteRequestSchema`, and
`RunnerCallRequestSchema` validate the same exported request types in Core.
`RunnerCallResponse` uses `{ ok: true, data }` or
`{ ok: false, error: { code } }`. Only a bounded stable code crosses a domain
refusal; the sandbox receives it as `Error.message`, with no exception details.
Non-2xx call responses are transport failures. HTTP 409 on a lease route, or
the domain code `runner_lease_lost`, immediately fences local execution.
`RunnerCallRequest` attaches the supervisor-held proof to the sandbox's
operation and JSON input. Responses are bounded JSON; streams are unsupported. Native Bun idle timeouts
are disabled: explicit transport signals, lease expiry, and the original run
deadline own cancellation.

For the engine and test kit, a bundle exports named async entry functions.
The loader calls the selected export as `entrypoint(input, cloud)`, discards
its return value, and gives `cloud` only the `call` method. The SDK bundler
must produce this module boundary. `RunnerEngine` (`load`, `run`, `kill`,
`close`) and `SandboxCall` are exported from `packages/runner/src/engine.ts`
for the attack tests and simulation kit; no application imports that package.
