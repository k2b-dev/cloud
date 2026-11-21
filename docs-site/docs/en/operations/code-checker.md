---
title: Operate the Code checker
navTitle: Code checker
section: Operations
order: 785
description: Run the separate Code checker role with bounded compiler and bundle processes.
tags: [code, checker, limits, operations]
updated: 2026-10-31
---

# Operate the Code checker

The [Code checker](/en/docs/platform/code-checker) is a separate, credential-free
role under `packages/runner`. Build it from the repository root with
`docker build -f packages/runner/checker.Dockerfile .`. It reads one trusted
`CodeCheckRequest` JSON document from standard input and emits one
`CodeCheckResult` JSON document. It does not need a runner app key, database,
Core connection, or network access. Do not mount credentials into this role.

`packages/runner/native/checker-isolate.c` is compiled into the image. It clears
the environment, disables core dumps, and installs a Linux seccomp filter that
refuses IP sockets and io_uring setup/operations. There is no filesystem sandbox: the image must remain credential-free.
The same launcher protects tsgo and the Bun analysis/build
worker. User code is parsed and bundled as data; it is never imported or run in
the checker. The analysis compiler host reads only supplied files and the
TypeScript standard libraries. Bundler resolution uses only the supplied source
and the generated SDK.

## Set administrator budgets

`CODE_CHECK_LIMITS` and `CodeCheckLimitsSchema` in `@k2b/cloud/code` define the
contract consumed by Administration › Code. These defaults apply until
the caller supplies stored administrator settings. There are no environment
overrides.

| Limit | Default | Scope |
| --- | --- | --- |
| `sourceBytes` | 256 KiB | All submitted source, UTF-8 |
| `bundleBytes` | 1 MiB | Exact ESM output, UTF-8 |
| `requestBytes` | 8 MiB | Serialized request including generated SDK |
| `files` | 64 | Submitted source files |
| `checkMs` | 15,000 ms | All child processes together |
| `memoryBytes` | 512 MiB | Child RSS, sampled every 20 ms on Linux |
| `outputBytes` | 2 MiB | Combined stdout/stderr per child |

The stdin role also enforces the default request envelope before parsing JSON.
The per-check source and bundle budgets are independently enforced. Lowering a
budget causes a visible failure; it never produces a partially checked version.

`CODE_CHECK_TYPE_INSTANTIATION_DEPTH` documents the compiler's native depth guard
of 100, alongside its instantiation-count guard. tsgo exposes no supported switch
for changing that depth. A type bomb fails with `TS2589` or the independent time
or memory diagnostic. RSS sampling can briefly overshoot; use the deployment's
container memory limit for an operating-system hard ceiling. The checker owns
no queue: Core must bound concurrent checks before launching this role.

Cancellation and deadline expiry kill and await the current child. Output is
drained with a byte limit, and temporary source/configuration files are removed
in a `finally` block. A failed check returns a stable diagnostic and must be
shown with a retry action by its CLI or UI caller.
