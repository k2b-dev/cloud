---
title: Code data model
navTitle: Code data model
section: Platform services
order: 568
description: Understand Code ownership, immutable versions, Query access and run retention.
tags: [code, capabilities, data, permissions]
updated: 2026-11-01
---

# Code data model

A Code exposes `pauseReason`, `pauseRows` and `pausePolicyRevision` alongside its
state so people can identify a policy pause.

A Code has one owner and a fixed `codeId`, such as `c_8hw2`. Saving a new
version preserves that identity. Core stores Code, its versions and its runs
in the Postgres schema `code`.

## Owners and access

An owner is one of these identities:

```ts
type CodeOwner =
  | { kind: "person"; userId: string }
  | { kind: "resource"; ref: { type: string; id: string } }
  | { kind: "app"; appId: string };
```

A person creates their own personal Code and can own several Codes.
Creating resource or application Code requires current owner administration,
including for Cloud administrators. A resource or an application can own at most
one. Resource identity uses `CloudResourceRef`; Core does not interpret the
owning application's domain IDs.

The personal owner is an editor. For resource and application Code, the
owner's current administrators are editors. Resource administrators come from
the canonical reader; application administrators come from application access
grants. Reading that administration grant does not require a write-scoped credential. An application's `canManage` callback restricts changes to its access
list, independently of Code editorship. Other people get access through
explicit editor or reader shares. An editor can add or remove shares using
the common access-entry model. Cloud administration provides reader visibility
for all Code. Writing and reading run contents require ordinary editor rights,
including for administrators. Resource readability alone does not grant access
to its Code.

| Permission | Code and version source | Run metadata | Run inputs, outputs and calls |
| --- | --- | --- | --- |
| Editor | Yes | Yes | Yes |
| Reader | Yes | Yes | No |
| No Code access | No | No | No |

There are no reader shares by default. Service accounts of kind `code` cannot
use the Code management Queries, including Queries about their own Code.
A credential's scopes still limit reads and writes.

Each resource or application Code has its own credentialless service account.
Its stable machine name is `code:<resource-type>:<resource-id>` or
`code:app:<app-id>`. Its display name comes from the owner's live reader:
“Code of …” (“Code von …” in German). The label needs permission to read the owner, independently of Code editorship.
An unavailable reader supplies no cached replacement title. Creating the account grants no target permissions;
activation owns those grants.

## Immutable versions

A version stores all source files, the exact UTF-8 bundle, `sourceHash`,
`bundleHash` and a checked-version manifest slot. Source paths are relative
POSIX paths. Source, bundle and jsonb inputs reject NUL characters and malformed Unicode
with `BAD_INPUT`. Results preserve their exact JSON text, including escaped NUL.
Submitted versions use the checker's entry-bound source hash, described in
[Code versions and approval](/en/docs/platform/code-versions#checker-manifest).
Unsubmitted storage snapshots hash compact JSON of sorted `[path, content]`
pairs. The bundle hash is SHA-256 of the exact bundle bytes.

The source, bundle, hashes and manifest are immutable. The checker and
submission services supply the final manifest when inserting a version. The
checked-version manifest is separate from the generated SDK manifest.

A save supplies `baseVersionId`, or `null` for the first version. A stale base
fails with `CONFLICT`; read the newer version before saving again. Version
numbers increase within the Code. A run always references a version of the
same Code.

## Read through Core Queries

Use these capabilities through the standard capability client. They all
check current permissions in Core's Code service.

| Query | Input | Result |
| --- | --- | --- |
| `core.code.list` | Optional `owner`, `cursor`, `limit` (1–20) | Visible Code items with `permission` and `nextCursor` |
| `core.code.read` | `codeId` | `code` and `permission` |
| `core.code.version.read` | `codeId`, `versionId`, optional `content`, `offset`, `length` | Version metadata and optional text chunk |
| `core.code.run.list` | `codeId`, optional `cursor`, `limit` (1–50) | Run metadata and `nextCursor` |
| `core.code.run.read` | `codeId`, `runId`, optional numeric `cursor`, `content`, `offset`, `length` | Run metadata; editor-only `contents` |
| `core.code.run.count` | `since`, at most 7 days ago | `runs` and `failed` of the caller's own personal Code since then |
| `core.code.attention` | Exact `owner` | Visible Code items with `reasons`: `run_failed`, `access_missing`, `approval_pending` |
| `core.code.attention.list` | Optional `cursor` | Across owners: resource or application Code the caller may edit that needs them, with `lastRunAt` and the same `reasons` plus `paused`; checks 50 candidates per page and returns `nextCursor`, also on empty pages |

`core.code.attention` serves an owner's navigation. The reasons per Code are
the same for every reader, so Core keeps them for 30 seconds and computes one
at a time; who sees which Code is checked on every request. A target app that
does not answer within two seconds counts as no missing access.
`core.code.attention.list` serves a person's own list when no owner is known.
It finds candidates from stored state, so missing access shows with the failed
run it causes, and it reuses the same reasons.

Without an owner filter, a normal caller lists their personal and explicitly
shared Code. To discover Code through live owner administration, supply the
exact resource or application owner. Unfiltered pages never call owner
providers, including for Cloud administrators, who list all Code. Open the
Code or filter its exact owner to resolve live editor rights.
Code IDs provide the list cursor; run history uses a cursor containing the
exact creation timestamp and run ID, so newer runs do not shift later pages.
Treat both cursors as opaque. If an owner provider is unavailable, an explicit
reader share remains usable; operations that need owner administration fail
visibly until the provider recovers.

A list page can be empty while `nextCursor` is present: filtering permissions
applies to a bounded candidate window. Continue until `nextCursor` is null.
Inaccessible identities return `NOT_FOUND`. Missing person authority or
insufficient credential scopes return `FORBIDDEN`.

For version text, select `content: { kind: "source", path: "code.ts" }`,
`{ kind: "bundle" }` or `{ kind: "manifest" }`. `offset` defaults to zero;
`length` defaults to and cannot exceed 16,384 UTF-16 code units. Follow
`content.nextOffset` until null. Chunks preserve surrogate pairs; a one-unit
request can return one two-unit pair to make progress. Without a
content selector, the Query returns metadata and `content: null`.

`run.read` returns `contents: null` for readers. For editors, `contents`
contains the run input and output plus at most one capability call. Follow
`contents.nextCursor` to read calls in invocation order. A call records its
normalized `{ capability, target, refs, input }`, capability name, kind,
result, state and times. Call states are `running`, `succeeded`, `failed`,
and `uncertain`; an unfinished call in a lost attempt stays uncertain until an
authoritative result arrives. It is an observation of one attempt; it does not
provide replay or resumption.

Values larger than 16 KiB of compact JSON return `null` inline and set
`inputChunked`, `outputChunked`, `callChunked` or `resultChunked`. They remain
complete in storage. Select `content: { kind: "input" }`, `{ kind: "output" }`,
`{ kind: "call", ordinal: 1 }` or `{ kind: "result", ordinal: 1 }` to read
JSON text through `contents.content`, using the same UTF-16 chunk contract as
version text. Readers still receive `contents: null` with any selector.

`entrypoint` is the declared handler name. For a path handler it never contains
the concrete URL, request IDs, query parameters or other run input.

## Where people see Code

People meet Code in Gustav, the product name of the Assistant application.
Only the name, the icon `ti-moustache` and the plum app color changed: the
application ID stays `assistant`, its addresses stay under `/app/assistant`,
and chats, settings, files, Projects, memories, Skills and saved "always
allow" answers are untouched.

- **My apps & automations** (`/app/assistant?code=1`) lists the person's own
  Code with its state, newest run and today's run count. The sidebar shows
  the entry only when `core.code.list` with the person as owner returns an
  item; when Core cannot answer, the entry stays so the list can show its
  error with a retry. Each Code opens on the shared Code page at
  `/app/assistant/code/<codeId>`.
- **Code of …** sits at the top of the Gustav panel when the page's place
  owns Code the person may read. It lists that Code with its newest run and
  status, folds to one line while a chat is open, and shows an error with a
  retry when Core cannot list it. A place whose type is a declared Code owner
  (`code.owners`) but has no Code says so and offers to start with Gustav; any
  other place shows nothing.
- **Waiting for you** lists, below the questions from chats, Code of a place
  the person administers when it needs them (`core.code.attention.list`,
  following up to four candidate pages, then "Check more"). Each row leads to
  that place, where the Code is managed.

All of these read only through the public `core.code.*` Queries with the
person's own credentials, the same Queries any application can call.

## Storage limits and retention

Core declares these administrator settings. They have no environment-variable
fallback. Administrators edit them through Core's settings API using
`cld admin settings apply --from ./code-limits.json --yes`. See
[Code storage](/en/docs/operations/code-storage) for the JSON input and reset command.

| Setting | Default | Maximum |
| --- | --- | --- |
| `core.code.source_bytes` | 1 MiB, including paths | 16 MiB |
| `core.code.source_files` | 100 | 100 |
| `core.code.bundle_bytes` | 4 MiB | 16 MiB |
| `core.code.manifest_bytes` | 1 MiB of JSON | 4 MiB |
| `core.code.payload_bytes` | 32 KiB per run input or normalized call input | 32 KiB |
| `core.code.calls_per_run` | 200 | 1,000 |
| `core.code.calls_per_second` | 60 per Code | 1,000 |

The [Code policy](/en/docs/platform/code-policy) controls which classifications
can run. [Code policy operations](/en/docs/operations/code-policy) lists the
registered execution, AI, database and concurrency budgets.

All storage settings require positive integers. New versions use current limits; a
run pins its call and payload limits at creation. Smaller settings do not
rewrite existing versions or active runs. The bridge enforces the smaller of
the saved attempt limits and current payload/call settings on each new call.
Transport budgets bound the file count and input maximums. Run/call input admission uses Postgres's `jsonb::text`
byte count, including its separator whitespace, before invocation. Capability results use the public 256 KiB
result budget independently of the run input setting. Results and run output
use Postgres `json`, preserving exact JSON text without expanding numeric
exponents or adding whitespace. An oversized result outside the capability
contract is replaced by an explicit diagnostic without changing the recorded
execution state.

Core removes completed runs and their calls 30 days after `endedAt`, in bounded
batches. Queued and running attempts are preserved regardless of their age.
Versions remain with their Code; individual version deletion is rejected.
Deleting a personal owner cascades to their Code, versions, runs and shares.
Creator attribution uses `ON DELETE SET NULL`, so removing a creator leaves
resource-owned Code intact.

This data layer does not schedule runs, activate versions or revoke grants in
other applications. Those services own their lifecycle transactions and the
owner-deletion outbox.

## Maintainer contracts

Core modules consume `packages/core/src/code/index.ts`. It exports Zod schemas
and types (`CodeOwner`, `Code`, `CodeVersion`, `CodeRun`, `CodeCall`),
`codeQueryContracts`, `CODE_TABLES`, permission-aware reads and version/share
services. `CODE_TABLES.shares` names `code.shares`, which links editor/reader
shares to `auth.access`; it is separate from target Code grants. Use
`addCodeShare` and `removeCodeShare` to edit these shares. Repeated shares for
one principal update the existing access entry. Share and version writes lock
the Code row and recheck permission within that transaction. Other applications
consume the five capabilities instead of importing Core or accessing its tables.

`insertCodeRun`, `appendCodeCall` and `finishCodeCall` are internal runner-host
storage seams. The dispatcher must authorize execution and validate its lease
and generation in the same transaction before recording calls. They do not
grant invocation authority. `generation` and `lease_expires_at` reserve the
additive storage columns for the execution service.

Scheduling, retries, generation fencing and skipped ticks are described in
[Code runs](/en/docs/platform/code-runs).
