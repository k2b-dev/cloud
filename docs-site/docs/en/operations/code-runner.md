---
title: Scaling runners
navTitle: Scaling runners
section: Operations
order: 1155
description: Configure, scale, and stop the stateless workerd runner for Code.
tags: [code, runner, scaling, shutdown]
updated: 2026-11-01
---

# Scaling runners

The `runner` service executes Code bundles in workerd. Add replicas with
`--scale runner=N`; every replica uses the same app key. Core owns durable run
state, scheduling, generation fencing, and leases. Runners keep only active
attempts and a bounded bundle cache in memory.

Core supplies the [per-call Code bridge](/en/docs/platform/code-bridge) and
distributes [Code runs](/en/docs/platform/code-runs) through one shared Sync
queue. Every Core instance can serve a poll, heartbeat, bundle request, or
completion; runners need no affinity to a Core instance.

## Authoring commands

Core serves the `code` CLI module for SDK pull, check, test, simulation and
version submission. Install the matching module with `cld plugins install code`.
[Code CLI](/en/docs/platform/code-cli) describes the commands and JSON contracts.
Check/test/simulate share the runner job pool and Administration > Code budgets;
Core and Runner must support the same job protocol. Busy requests fail visibly
instead of building an unbounded HTTP queue. Disconnects cancel outstanding
jobs, and authoring HTTP requests stop at the platform's 240-second budget.

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
bun run dev:cld -- --profile dev admin apps keys create runner --out-dir ./.local/app-keys
```

For production, use your explicit administrator profile with
`cld --profile operator admin apps keys create runner --out-dir ./secrets`.
Keep the file produced by enrollment; no host `chown` or `chmod` is needed.

The development template reads `./.local/app-keys/runner.key`; production reads
`./secrets/runner.key`. Neither file belongs in Git. Both templates mount it at
`/run/runner-key/source`, inside an image-owned directory with UID 0 and mode
`0700`. Use this same target for a custom read-only bind mount. Do not mount the
source into a directory that workerd can traverse: the entrypoint refuses it.

Local Compose secrets retain the source file's host UID and permissions. At
startup, the image entrypoint reads that mount with a temporary `DAC_OVERRIDE`
capability and creates a supervisor-owned `0400` copy in a private `0700`
directory on `/tmp`. The original mount remains hidden behind its root-only
directory, even if the secret provider presents it as `0444`. The entrypoint
passes the copy through `CLOUD_APP_KEY_FILE`, removes the temporary capability
from its permitted and effective sets, and enables `no-new-privileges` before
executing the supervisor. The supervisor's ownership and exact `0400` check is
unchanged. Custom deployments must also provide the private `/tmp` tmpfs from
the templates; temporary copies disappear when it is unmounted. The image does
not change the host file's metadata. With Docker user-namespace remapping, the
host file must be owned by the host UID mapped to container root; keep its
private mode rather than making it readable by other host users.

Only Core and runner share the internal
`runner-core` network. Runner has no published port, writable root filesystem,
infrastructure environment, or persistent volume. Temporary workerd host
configuration lives in a bounded `/tmp` tmpfs; bundles never go to disk.

Before upgrading an existing production deployment, enroll and mount the
runner key. Production starts the runner by default; Compose cannot create
it when the secret file is missing. Core and runner must use the same runner protocol version.

The image pins workerd to `1.20261028.1`. Its
Compose cgroup memory budget is 1 GiB with 256 process slots. These are host
resource allocations, not Code execution settings. Budget replicas accordingly.
Core supplies each replica's run and bridge concurrency, process memory, cache, transport,
and bundle budgets from administration settings; the runner adds no limit env.
Configuration is read once per process; restart replicas after changing these
budgets. Keep Core and runner host clocks synchronized, since leases and run
deadlines use Unix milliseconds.

## Process isolation

Keep the runner's own container PID namespace, read-only root, `no-new-privileges`,
private `/tmp` tmpfs (root-owned, sticky mode `1777`) and capability settings from the Compose templates. Do not
use host/shared PID namespaces. The supervisor holds the app key and run tokens;
workerd receives an empty environment. Its only inherited descriptor above
stderr is fd 3: its listening Unix socket. Only the supervisor signs requests
to Core.

The supervisor runs as UID 0 with only `SETUID`, `SETGID`, `CHOWN` and `KILL`.
These let it assign identities, protect socket paths and stop its children.
Compose grants `DAC_OVERRIDE` solely for the entrypoint's initial secret read;
it is absent from the supervisor and workerd. `no-new-privileges` prevents a
later root exec from recovering it from the capability bounding set. Each organization/trust-tier group
gets a distinct UID and GID, starting at 20000, and a separate session. Identities
are never reused during the supervisor's lifetime. Each replica has its own
container PID namespace, so scaling needs no UID allocation across replicas.

Before executing workerd, `runner-isolate` clears supplementary groups, sets all
real/effective/saved IDs, clears capabilities, enables `no-new-privileges` and
installs a mandatory seccomp filter. A workerd process cannot regain supervisor
privileges, signal or inspect the memory/environment/descriptors of the
supervisor or another group. Separate sessions also prevent Linux's cross-UID
SIGCONT exception. A supervisor exit kills its children.

Communication in both directions uses Unix sockets inside a directory owned
by `root:<group-gid>`, mode `0710`. Only the supervisor may change its entries;
the group's GID permits traversal. The launcher binds the root-owned `0600`
workerd listener before dropping privileges and passes it as fd 3. The bridge
socket belongs to `root:<group-gid>`, mode `0660`. workerd cannot replace any
socket, configuration file or containing directory. Other groups cannot
traverse these directories or connect to their sockets. The child's filter permits only Unix sockets and blocks IP/packet
sockets, process creation, cross-process memory/ptrace interfaces, namespace
changes and io_uring. V8 threads remain available. There are no workerd TCP
listeners, and a native workerd escape cannot connect directly to Core.

Distinct UIDs and filesystem-protected IPC provide these boundaries without
privileged namespace setup or `SYS_ADMIN`. They protect against a native escape
inside workerd; they do not replace the host kernel and container boundary.
The engine refuses startup if its mandatory launcher or UID transition fails.

CI runs the native engine and shutdown tests inside the image through the same
startup path and restrictions as Compose. Entrypoint tests invoke the launcher
themselves with its startup capability envelope. Its image smoke mounts an
operator-owned `0600` fixture at `/run/runner-key/source` and uses the default
entrypoint, then verifies the private copy and supervisor capability set. The isolation probe starts in the
actual workerd process's UID, session and filter, tries to read the key and
`/proc/<pid>/{environ,mem,fd}`, signal/ptrace the supervisor and a sibling,
connect to a sibling socket, replace IPC paths, open IP sockets and regain
privileges, then
executes workerd in the same PID. [Verify the isolation
boundary](#verify-the-isolation-boundary) adds hostile bundles and the real
bridge. Sandbox JavaScript API checks alone do not cover a native escape, so
these OS-context checks and the CPU-loop watchdog test stay required. Unprivileged unit runs skip the native files; the image check
runs them with isolation enabled.

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
Concurrent cache misses download independently with each attempt's own lease
and cancellation signal; only completed, verified bundles are shared.

## Check capacity and waiting time

Core's administration read model reports fresh runner instances, their free
slots, the number of queued and running runs, and the oldest queued run's
waiting time in milliseconds. An instance remains fresh for the configured
long-poll duration plus the 15-second lease window. A stale instance contributes
no capacity. Polls report free slots; Core subtracts the leases it returns. Heartbeats keep
fully occupied instances visible until they can poll again.
These values are observations, not a promise that a slot remains available.

The Core service `readCodeRunnerMetrics(context, { cursor, limit })` requires
Cloud administration and returns `CodeRunnerMetrics` for Administration › Code.
It includes an installation-wide summary and a page of at most 50 instances.
The projection contains no run inputs, results, source, or tokens.

Add replicas when waiting time grows while runners have no free slots.
If slots remain free, check Code and owner concurrency settings and active
version/mandate status first. More runners cannot override those limits.

Administration settings default to one concurrent run per Code and ten per
owner. All Core instances enforce the same limits. Each replica defaults to
four slots. Queue selection rotates between eligible Codes, so a Code with a
large backlog cannot occupy the front of every runner's poll.

The runner requests lease renewal every five seconds, for at most fifteen seconds ahead and
never beyond the original run deadline. Its five-second recovery pass detects
lost leases. Work committed before a publisher or Core restart remains in the
Postgres outbox. The repair pass republishes waiting work after lost or expired
queue wakeups; brief transport outages do not discard queued runs.

## Configure runner budgets

Change these settings in Administration › Code or through `cld admin settings apply`.
Restart runner replicas after changing their configuration. Acquisition requests
may take the long-poll duration plus the transport timeout.

| Setting | Default | Controls |
| --- | --- | --- |
| `core.code.automatic_attempts` | `3` | Maximum lease generations before a possible Action; the original deadline still applies. |
| `core.code.runner_slots` | `4` | Shared concurrent runs and authoring jobs per replica. |
| `core.code.runner_poll_ms` | `20000` | Maximum acquisition request duration, in milliseconds. |
| `core.code.runner_transport_ms` | `30000` | Runner request timeout, in milliseconds. |
| `core.code.runner_retry_ms` | `1000` | Delay before retrying a failed transport request, in milliseconds. |
| `core.code.runner_cache_bytes` | `33554432` | In-memory bundle cache per replica, in bytes. |
| `core.code.runner_bridge_concurrency` | `4` | Simultaneous bridge calls per run. |
| `core.code.runner_process_memory_bytes` | `134217728` | Memory budget per organization and trust-tier process, in bytes. |
| `core.code.runner_job_slots` | `1` | Simultaneous authoring jobs within the replica's shared slots. |
| `core.code.job_pending` | `100` | Installation-wide queued and running authoring jobs before admission returns busy. |
| `core.code.job_wait_ms` | `30000` | Queue allowance added to the role's work budget, in milliseconds. |
| `core.code.test_cases` | `64` | Declarative fixtures per test job. |
| `core.code.test_runs` | `200` | Total fixture invocations per test job. |

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

The pinned OSS workerd build accepts Loader `limits.cpuMs` but does not
enforce it: a bounded 100-million-iteration CPU probe completed despite a
1 ms limit on both the worker and entrypoint. The supervisor watchdog remains
the stall control; a native per-attempt CPU budget is not claimed.

## Verify the isolation boundary

The required `runner-attacks` CI job builds the real runner Dockerfile's test
target. That target adds probes to the production runtime without replacing
the supervisor, workerd, entrypoint, or native launcher. The job runs when the
runner, bridge, fencing, identity transport, dependencies, or its workflow
changes. The PR gate fails if this job fails, times out, or is cancelled.

Every organization and trust tier has a unique Unix UID/GID and session.
Workerd inherits an empty environment and one listening Unix descriptor; it
does not inherit the key, a key descriptor, or the supervisor's sockets.
Root owns the group directory and IPC paths. A group can traverse its own
directory but cannot replace its configuration, listener, or bridge socket.
Different UIDs and sessions protect the supervisor and sibling groups,
including Linux's same-session SIGCONT exception. Seccomp denies IP sockets,
process creation, ptrace, and cross-process memory access. V8 threads remain
available to workerd.

The native probe runs immediately before `exec` of workerd, under the same
UID, session, descriptors, capabilities, and seccomp policy. It then becomes
the real workerd process. This exercises the OS boundary independently of
the JavaScript API restrictions. The key test attacks both the actual
entrypoint-staged `0400` copy and a mounted public test key behind the image's
`0700` directory. Neither contains an installation credential.

The suite requires these results:

| Attack | Required result |
| --- | --- |
| Read key, supervisor or sibling `/proc/environ`, `/proc/mem`, descriptors, or proc-root path | `EACCES` or `EPERM`; no bytes read |
| Signal, SIGCONT, ptrace, or read sibling memory | `EPERM`; sibling finishes its real bundle |
| Connect to either sibling IPC socket; replace a trusted path | `EACCES` or `EPERM`; supervisor paths remain intact |
| Public, metadata, live loopback/Core, or named-host requests through `fetch`, `connect`, `node:net`, or `node:dns` | Refused; zero canary requests |
| Native IPv4/IPv6 TCP, DNS/UDP, alternate network families or IP socketpair | `EAFNOSUPPORT` before any connection or DNS query |
| Access filesystem, environment, subprocess, or loader APIs from Code | `node:fs` absent; `node:fs/promises` reaches only workerd's virtual filesystem, so reads of the key, `/run/runner-key`, `/proc`, and image files and image writes fail; environment empty; every `node:child_process` call, loader, and credential RPC attempt fails |
| Write image files or traverse out of `/tmp` into the image | `EACCES` or `EROFS` |
| Fork bomb, vfork, or clone3 bypass | Fork/vfork get `EPERM`; clone3 gets `ENOSYS` |
| io_uring, namespace, mount, BPF, or pidfd bypass | `EPERM` |
| Memory bomb; CPU loop | `memory_limit`; `stalled`; another organization continues |
| Giant bridge input or result | `runner_bridge_unavailable`; oversized input never reaches the callback |
| Giant return value or console output | Return and diagnostics discarded; none reach the job log, a growing pipe, or a file |
| Concurrent bridge flood | `runner_bridge_busy`; only the configured number admitted |
| Sustained calls through real Core and Valkey | `code_rate_limited`, with bounded failed call observations |
| Calls beyond the saved per-run budget | `code_call_limit`; observation count stops at the budget |
| Old generation, completed run or replay against another run; forged run token | HTTP 409 `runner_lease_lost`; HTTP 403 `code_invalid_token`; no observation or provider call |
| `code.access.*`, streams, or `code: false` | `code_access_forbidden`, `code_stream_forbidden`, or `code_disabled`; no provider call |
| SIGTERM while a bundle waits forever | Acquisition stops; `wall_clock_limit` within two seconds of the original deadline; runner exits successfully after reporting |

Bridge attacks run hostile bundles in the compiled runner image against the
actual signed Core call route, Postgres fence, and Valkey limiter. Acquisition
and completion use a deterministic fixture; queue distribution is covered by
the scheduling integration suite. The attack container deliberately uses host
networking with a reachable Core fixture: workerd must refuse network access
without relying on a disconnected container. Production adds the internal
`runner-core` network described above.

The native/bundle step has a 90-second limit; the bridge step has a 180-second
limit, both with forced termination after a further five seconds. Skipped
attacks fail the job. Individual attempts retain their transport and run deadlines.
The job removes its containers on failure or cancellation. Its test output is
the result for that exact commit and pinned engine version; expected outcomes
in this table are not a claim that an untested commit passed.

These checks establish the tested boundaries, not resistance to unknown
kernel or engine vulnerabilities. Runs in the same organization and trust tier
share a workerd process and its memory/stall fate. The memory watchdog samples
RSS every 100 ms; the container cgroup bounds aggregate memory, and killing a
whole container interrupts every group in it. Code gets no persistent
filesystem; native processes still use the bounded temporary filesystem.
Resource contention and timing side channels are not eliminated by UID
separation. Keep the pinned engine and host kernel current and budget replicas
for the combined workerd and supervisor memory.

## Integrate the bridge

Core and runner consumers import protocol types and strict schemas from
`@k2b/cloud/code/runner`. `RUNNER_PATHS` names the private POST routes for
configuration, run acquisition, bundle download, heartbeat, completion, and
bridge calls. `RunnerBridge` is the mockable transport seam. Core implements
the receiving side; the runner shell uses `CoreBridge` with real Ed25519 signatures.

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

When a running attempt ends, Core commits a dispatch wakeup for waiting work
of the same owner. A backlog held by the per-Code or per-owner concurrency
limit can continue as soon as capacity frees up; lease recovery is not needed
for ordinary progress. Schedule registration scans bounded database pages on
each Core reconciliation pass, using stable Code/entrypoint identities.

Core starts serving without waiting for every schedule to register. Each
reconciliation pass isolates definition failures by Code and logs the Code ID
and error; healthy Codes continue to register. Accepted ticks are retained for
seven days. Schedule receipts have the same retention and older ticks are
rejected. Manual-start receipts remain permanent.

New runner identities have a shared registration limit derived from the
installation ingress setting and the telemetry cleanup budget (at most 20 per
second). Existing identities continue polling and heartbeating independently
of this registration budget. A burst of new replicas retries registration;
inactive telemetry is removed after its poll-plus-lease freshness window.
## Run tests without effects

The same runner image includes a separate `code-test.js` stdin/stdout role.
It uses the production workerd engine with a fake-only bridge and no app key
or Core connection. Core checks the source first and sends the immutable
bundle with declarative fixtures and host budgets. See [Test Code](/en/docs/platform/test-code)
for the request, result schema, and isolation requirements.

## Check and test on the runner pool

The same signed long-poll now carries `check`, `test` and `simulate` jobs.
Core alternates authoring jobs with eligible production runs and counts both
against each replica's advertised slots. Scaling needs no additional service
or per-replica configuration. Queue admission defaults to 100 pending jobs
installation-wide, bounded also by the owner's concurrency setting. The
queue allowance defaults to 30 seconds, followed by the role's work budget.
Change these under Administration > Code. `code_job_busy` asks the caller to
retry later; cancellation and time limits leave a visible failure.

The runner image contains both isolated roles and the compiler. Core needs
none of these binaries. Each role receives only its input over stdin and
returns bounded JSON over stdout. It runs as PID 1 with private user, PID,
mount, network and IPC namespaces, an empty environment, private `/proc` and
bounded `/tmp`. Private `/dev/shm` and `/dev/mqueue` mounts are read-only and
limited to one page each; only `/tmp` receives the 16 MiB workspace budget.
The job's separate lease key stays in the supervisor; no
bridge token reaches the job or is issued for it.

Before starting runners, obtain `packages/runner/apparmor.profile` and
`packages/runner/seccomp.json` from the Cloud release tag matching the runner
image. Install the AppArmor policy once on each Linux Docker host:

```sh
sudo apparmor_parser -r packages/runner/apparmor.profile
```

Both Compose templates require that named policy and the checked-in seccomp
profile. When copying a Compose template into a deployment directory, also copy
`packages/runner/seccomp.json` to that same relative path, or update its
`security_opt` path to the installed file. The templates remove Docker's locked
system-path submounts so a job can mount
its private procfs; the named policy preserves read-only kernel controls and
blocks access to sensitive proc/sysfs paths. It permits only the proc/tmpfs
mount targets, private shared-memory/queue directories and private-mount propagation needed by job setup. No host
`SYS_ADMIN` is granted. After setup, both roles inherit a mandatory seccomp
filter that refuses further namespace creation and mount operations. Workerd
retains its own independent mandatory filter.

Hosts need AppArmor with user-namespace mediation, user namespaces and
namespace-local proc/tmpfs mounts. Docker user-namespace remapping needs an
outer UID/GID range large enough for the supervisor's distinct production
identities and 65,536-ID job ranges; the usual 65,536-ID remap is insufficient.
Jobs reuse their range only after the launcher has reaped the namespace,
including on cancellation or role failure. A helper that dies abnormally
does not release its range. Exhausting identities stops
acquisition and exits the supervisor so its container can restart.

Docker refuses to start the container when the named profile is missing.
The runner probes isolation before polling. Unsupported namespace/mount
setup or a failed mandatory filter logs
`runner_job_isolation_unavailable` and refuses startup. CI uses the same
profile and container envelope. The local profile syntax check cannot replace
this image verification.

Keep Compose's `init: true`, or Docker's `--init` for custom deployments.
The supervisor refuses PID 1 with `runner_init_required`. Custom deployments,
including Kubernetes, must put an init/reaper ahead of the image entrypoint.
The container init reaps orphaned namespace processes after an abrupt launcher
death. A dead namespace process must disappear from `/proc`, including its
zombie entry, so repeated cancellations do not exhaust the container PID budget.
Routine cancellation first asks the launcher to kill and reap its namespace;
after one second the supervisor can force termination. Abrupt launcher deaths
retain their UID range because teardown has no launcher receipt.

Administration defaults to one simultaneous authoring role per runner,
within its four shared slots. Increase the authoring-slot setting only with
a corresponding container memory/process allocation. Each role has a
32-thread/process limit per Linux identity; compiler children use two Go
execution threads. Checker memory also respects the runner process-memory
setting. Retain headroom for the supervisor, cache and production workerd
groups when budgeting a replica. These controls bound authoring load;
container-wide exhaustion can still interrupt active work.

`RunnerFetchResponse.jobs` contains `RunnerJobLease` values. The signed
`RUNNER_PATHS.jobInput` route returns bounded input; the existing heartbeat
and complete routes accept `RunnerJobProof` and `RunnerJobComplete`.
`RunnerJobResultSchema` validates check/test/simulate results in both runner
and Core. Job generations and random lease keys are fenced in Postgres, so
any Core replica can serve them. Retries retain the original deadline.

## Gustav authoring

Gustav's `code_check`, `code_test`, `code_simulate` and `code_submit` use the
same authoring services and runner jobs as `cld code`. They need the runner
pool; adding chat tools does not move user-code execution into Core. A busy
or unavailable runner produces the shared versioned failure result. Chat
submission saves a version; activation remains a human action.
