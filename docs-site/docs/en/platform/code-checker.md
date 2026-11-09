---
title: Code checker
navTitle: Code checker
section: Platform services
order: 681
description: Check Code types, review called operations and targets, and build an immutable runner version.
tags: [code, checker, permissions, runner]
updated: 2026-11-09
---

# Code checker

The Phase 1 checker validates Code before a version can be stored or activated.
It checks types with the native TypeScript compiler (tsgo), reads permissions
from [SDK handles](/en/docs/platform/code-sdk), and bundles the source into
one ESM module. Checking never executes the source or calls a capability.
The server check is authoritative; a local result does not grant access.

## Read check output

The checker supplies the output contract for `cld code check`. The Core CLI
module connects the command to this contract; `checkCode` does not install CLI
commands.
A successful check lists each operation, its target, source file and line as
review evidence. It does not report or grant current access. Core compares this
list with the running version's manifest to label entries `new` or `existing`.
Dynamic handles have a target type with `id: null` in this evidence.

The CLI can resolve resource titles through authorized readers. The checker
returns coordinates, never titles or a claim that the person can grant them.
`new` means the supplied comparison list does not contain that exact operation
and target. This comparison never limits runtime calls. Additional `refs`
targets appear as separate rows for the same operation.

A failure has diagnostics with a stable `code`, a human-readable `message`, and
one-based `file`, `line`, and `column`. It has no manifest or executable bundle.
TypeScript errors retain their
`TS` number, such as `TS2589` for an excessively deep type instantiation.

## Keep targets and registrations readable

All Code modes accept dynamic resource IDs. Imported constants and `as const`
tuples produce known target IDs in review evidence. Dynamic permission rows
retain the target Type and use a null ID. An app-wide operation has a null
target. `manifest.permissions` is a non-binding review aid: the target checks
current rights at execution, regardless of static evidence.

Call SDK methods directly on a handle or on `app`. A handle may be assigned to a
variable or passed through a typed function. Detaching a method, including using
`.call`, `.apply`, or `.bind`, loses its target and is a check error. Type-check
suppression comments are rejected because they can hide permission-bearing calls.

Only `@sdk` and relative imports of files supplied in the same Code project are
allowed. External packages, `bun`, `@k2b/cloud`, absolute paths, dynamic imports,
and triple-slash references are rejected. SDK namespace imports, SDK re-exports,
and the host control `__codeSdk` are reserved. Use explicit `import type` for types; ordinary imports are preserved as runtime
imports. Type-only imports obey the same rules. Project files use relative paths ending in `.ts` or `.tsx`; paths cannot
escape the project. No package configuration, plugins, or author-provided
`tsconfig.json` are loaded.

Actions omitted for `code: false` and streaming operations have explicit errors.
Removed app members (`nav`, `webhook`, `fetch`) and `c.user.provider` are type
errors; analysis also reports `code_removed_api`.
A second `app.on` for the same event and place also reports
`code_duplicate_on`, including an explicit owner handle after an implicit owner
subscription.

Declare `app.use()` at module scope, as a statement or a `const` initializer,
with an optional string-literal path prefix; prefix variables and casts are
rejected. Keep app registrations direct, without reflection or erased aliases.
Invalid registrations report
`code_static_middleware`. Calls inside a middleware callback contribute ordinary
capability evidence and are attributed to subsequent routes its prefix may
match, including public routes. They add no permission of their own and do not
change approval or runtime admission. Request-variable keys and values are
checked against the types declared through `app.use<Variables>()`.

Declare schedules as module-level calls with a constant five-field cron expression
or a constant `{ at, timeZone }` for a [one-time run](/en/docs/platform/code-sdk#run-once-at-a-chosen-time), and an
optional constant name and human `title` in the declaration options. Titles follow
the [SDK title contract](/en/docs/platform/code-sdk#name-an-automation);
invalid or dynamic titles report `code_static_title`. A name in an imported options object needs a literal
type, such as `{ name: "weekly" as const }`. Names must be unique. Unnamed
schedules use the SDK's `schedule:0`, `schedule:1`, … identifiers in runtime module
evaluation order. Resource-owned and personal Code need at least one schedule;
otherwise the checker returns `code_no_entrypoint`. The manual
start and scheduled start invoke the same named runner export.

## Consume a checked version

Platform tools import `checkCode`, `CodeCheckRequest`, `CodeCheckHost`, and
`CodeCheckResult` from `@k2b/cloud/code`. Supply source files, the entry path,
the installation-generated SDK, a trusted list of AI operation IDs, current
permissions, and optional administrator limits. AI use is true when a detected
operation appears in that trusted list. The request's SDK, operation metadata,
existing permissions, executable paths, and budgets come from the host, never
from the Code author.

`CodeCheckHost` accepts either a remote `check(request, signal)` function or
the mandatory Linux isolation executable, native tsgo binary, trusted
analysis/build worker, and Bun. Core uses the remote form. There is no fallback
to an unisolated process. Pass an `AbortSignal` to cancel a check; the checker
kills and reaps its child and returns `code_check_cancelled`.

On success, store the exact source, bundle, and `CodeVersionManifest` together.
Validate stored manifests with `CodeVersionManifestSchema`. This version-1
contract, shared with the version service, contains:

- `entrypoints`: schedule/manual kinds, named ESM exports, optional trimmed human `title`, cron expression or
  null, optional one-time `at` and `timeZone`, and declaration file and line;
- `permissions`: `{ operation, target, file, line, entrypoints? }`, with a row
  for each literal target and additional reference. `entrypoints` lists, sorted,
  the schedules whose handler contains the call: an inline function, or a
  function declaration or `const` function the schedule names directly, also
  from another file. Only the handler's own body counts: a call in a helper
  that the handler calls, in a nested function such as a `map` callback, or in
  a function bound with `let` has no `entrypoints` field. Share dialogs name the
  automation from it ("for “weekly”") and leave the line out when it is absent;
  it never affects authorization;
- `ai`: whether the detected calls use AI;
- `hashes`: lowercase SHA-256 digests for `source`, `sdk`, and `bundle`.

The source hash covers `JSON.stringify({ entry, files })`, with `files` holding
`[path, source]` pairs sorted by path. The SDK hash covers the `GeneratedCodeSdk`
as JSON with recursively sorted object keys, using the platform's canonical
capability hashing. It remains stable after JSON storage reorders keys. The bundle
hash covers the exact UTF-8 ESM bytes. A host must not reformat the stored bundle.
The runner loads that ESM and calls `bundle[entrypoint](input, cloud)`. The bundle
binds the SDK to the supplied bridge before evaluating user modules, then calls
the selected schedule. For `code_run`, the entry module exports a default
function; the runner export `run` passes it the input.

The checker's permission list is non-binding review evidence. A version entry
binds the runner to the approved immutable version and its subject. The bridge
applies policy to each actual call and the target checks current resource
rights. An operation's absence from static evidence is not a rights decision.
Literal types and casts never prove runtime authority.
Only modules reachable through runtime imports from the entry contribute
permissions and schedules. The checker compares that graph with the modules
loaded by the bundler and rejects a mismatch with `code_import_elided`. If this
occurs, inspect the imports and retry the check. The bundle verifies the registered schedules against the manifest after loading.

Files ending in `.tsx` build [Code pages](/en/docs/platform/code-sdk#return-a-page)
with the SDK's `jsx` factory and page blocks; a misplaced block part reports
`code_page_child`. Workerd-compatible web types remain visible, but they grant no outbound
network access. Use the SDK's authorized bridge operations for external effects.

## Use the Core runner host

Core consumers import `createCodeCheckRequest` and `createRunnerCodeCheckHost`
from `packages/core/src/code/index.ts`. First build the request with
`await createCodeCheckRequest(codeId, files, entry, context)`; this authorizes
editing and generates SDK metadata from the current catalog. Then call
`checkCode(request, createRunnerCodeCheckHost(context), signal)` or the host's
`check` method. Do not accept SDK metadata or checker budgets from author JSON.

The host enqueues a bounded `check` job and waits for its validated
`CodeCheckResultSchema` result. Jobs share the signed long-poll runner pool
and free slots with production runs. They receive a generation and separate
lease key, with no bridge run token. Cancellation fences the job. A lost
checker lease can be retried within the original deadline and attempt budget.

`submitCodeVersion` repeats this server check before storing a submission.
The exact bundle and static manifest evidence must match; a forged or stale
client result is refused. This check grants no execution permission.

`CodeJobError.code` is `code_job_busy`, `code_job_request_limit`,
`code_job_output_limit`, `code_job_time_limit`, `code_job_cancelled`, or
`code_job_failed`. Busy means
retry later. Administration > Code bounds pending jobs and queue allowance;
no caller waits indefinitely. Forward the request's cancellation signal.
