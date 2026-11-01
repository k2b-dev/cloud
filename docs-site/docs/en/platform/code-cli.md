---
title: Develop Code with cld
navTitle: Code CLI
section: Platform services
order: 969
description: Pull, check, test and submit Code from local ID-based project folders.
tags: [code, cli, sdk, versions]
updated: 2026-11-01
---

# Develop Code with cld

The Core `code` CLI module turns local source into checked, immutable Code
versions. Install it with `cld plugins install code`; run `cld code reference`
for the bundled command reference. Check, test and simulation use the shared
runner pool. User source never runs in the CLI or Core process.

## Create and inspect a local project

```sh
cld code init --title 'Weekly report' --out ./code
cld code init --title 'Invoices' --owner-type example.box --owner-id box_1234 --out ./code
cld code sdk pull ./code/example/box_1234
cld code check ./code/example/box_1234
```

The default owner is the current person. `--owner-type` and `--owner-id`
select a resource; `--app` selects an application owner. Creating resource or
application Code requires administration of that owner. Editing and checking
requires Code editor access and a write credential. Pull and diff require read
access.

Project folders use resource IDs. Titles and owners belong in `code.json`:

```text
code/
  me/c_1234/                  code.json  code.ts  test/
  example/box_1234/           code.json  code.ts  test/
                             sdk/       tsconfig.json
```

`code.json` has version 1, `codeId`, `title`, `owner`, `entry` and nullable
`baseVersionId`. Project commands accept the project directory or a file inside it;
omitting the path searches upward from the current directory for `code.json`.
Folder names never derive from titles or addresses. Linked filesystem paths
are refused. Source collection excludes generated `sdk`, `test`, dependencies,
build output at the project root, and hidden folders. Nested TypeScript
source directories such as `lib/test/` remain source. The checker accepts
`.ts` and `.tsx` source files.

`sdk pull` refreshes the generated SDK and TypeScript configuration. Import
only `@sdk` from Code. The binding check uses current server SDK metadata,
even when local generated files are stale.

## Read the permission list

```text
Erlaubnisse
  example.conversation.move   am eigenen Postfach Rechnungen (box_1234)   code.ts:3
  other.task.create           an Space Buchhaltung (sp_4kd2)   code.ts:8  ← neu, braucht den Admin des Space
KI           ja
Seiten       —
Webhook      —
Datenbank    —
```

Each permission keeps its operation ID, authorized target title and ID, and
one-based source location. A missing live grant is new; a removed grant is
never treated as existing because an old version mentioned it. Unavailable
reader titles fall back to resource Type and ID. Personal Code uses the
person's own rights and never asks for target-admin grants. Phase 1 supports
named schedules and hand starts; future page, webhook and database syntax fails
checking.

## Test with fixed fixtures

```sh
cld code test ./code/example/box_1234 --json
cld code simulate ./code/example/box_1234 --fixture test/monday.json --trace --json
```

Tests read declarative `test/*.json`, including nested directories.
[Code test kit](/en/docs/platform/test-code) defines `now`, `seed`, fake
capability replies and expected results. Simulation accepts exactly one
invocation. Neither command receives production access. A failed fixture,
check, assertion or runner request exits 1 and leaves an explicit result.

## Save without overwriting another author

```sh
cld code pull c_1234 --out ./fresh-code
cld code push ./fresh-code/example/box_1234 --json
# Alternative to push: cld code submit ./fresh-code/example/box_1234 --json
cld code diff ./fresh-code/example/box_1234 --json
```

If init creates remote Code but cannot write locally, its error includes
`details.config` and the Code ID. Use that ID with pull into a new directory.

Pull creates a new folder and downloads the latest saved version's exact
source and base. It refuses an existing folder. For an update, pull into a
new root and reconcile your local changes there.

Push and submit also send `test/**/*.json`; Core runs them once and shows the
result to reviewers. Push and submit use the same [version submission](/en/docs/platform/code-versions)
service: check the source, save an immutable version, and request any required
Cloud-admin approval. The active version keeps running. Both send the local
`baseVersionId`; a successful save advances that field in `code.json`.
`--base-version-id <UUID|null>` supplies an explicit base and cannot force an
overwrite.

A concurrent save returns `code_version_conflict`, “Neuere Version vorhanden”
in German, and the complete difference. The failed command leaves local files
and base unchanged. JSON contains the latest version ID and all diff rows in
`error.details`. Pull into a fresh directory, reconcile, and retry against the
newly pulled base.

Diff compares a saved version with its recorded approval baseline, including
unchanged lines and files. Its default is the project's base version;
`--version <UUID>` selects another saved version.

## Activate or start a schedule

```sh
cld code activate ./code/example/box_1234 --activation-id 11111111-1111-4111-8111-111111111111 --yes --json
cld code run monday ./code/example/box_1234 --key monday-manual-1 --json
```

Activation requires an approved saved version, current owner and target
administration, and a normal person's session or personal OAuth credential.
Phone sessions, API keys and machine identities are refused by Core. The CLI
also refuses activation when its host reports CI. CI can check, test and push
with its granted credential; keep personal interactive credentials out of CI.

`--version` overrides the project's base version. Reuse `--activation-id`
after a lost response. The returned [activation receipt](/en/docs/platform/code-activation)
may still be pending or waiting; it does not assert that the new version is
already active. Terminal failed/cancelled receipts exit 1.

Run starts the named schedule on the active version. Reuse `--key` only to
retry the same start. A new intentional run needs a new key. The receipt
contains the queued run ID and whether it was a duplicate; read the
[run state](/en/docs/platform/code-runs) for its final outcome.

## Pull the instance's resource Code and inspect status

```sh
cld code pull --all --out ./instance-code --json
cld code status ./instance-code --json
```

`pull --all` requires a Cloud administrator and downloads every resource-owned
Code through the same source reader as a single pull. Personal and
application-owned Code are excluded. Resource folders use short IDs, for
example `mail/box_1234`; titles and owners remain in `code.json`. If an ID
cannot be used as a filesystem segment or two resource types share the same
short ID, pull uses `mail/@<code-id>` for that Code. Existing checkouts are
never overwritten. Pull never
activates Code. It refuses existing project folders. If a later project fails,
earlier folders remain: inspect them and retry into a new root.

Status discovers every `code.json` below the selected root, or finds the
surrounding project from a source path. Without a path, it uses the current
project when present; otherwise it scans `./code`, matching pull's default. It compares local source with its saved base and reports the latest
server version, approval receipt, active version, execution state, pause reason,
and whether a newer server base exists. An empty root returns an empty list;
a missing default `./code` also returns an empty list.
Duplicate local Code IDs, linked paths, unavailable Code, and unreadable files
fail visibly. Status does not update files or advance local bases.

## Inspect runs and pause execution

```sh
cld code runs ./code/example/box_1234 --limit 20 --json
cld code runs ./code/example/box_1234 --run 11111111-1111-4111-8111-111111111111 --json
cld code pause ./code/example/box_1234 --yes --json
cld code resume ./code/example/box_1234 --yes --json
```

Run lists return metadata and `nextCursor`; pass it as `--cursor` to continue.
A single run returns metadata and an ordered call page. Pass
`contents.nextCursor` as `--call-cursor` to continue its call list. Each page
contains at most one call. Readers receive `contents: null`; editors can also
read inputs, outputs, calls and results. Large values have chunk flags; use
`--content input|output|call|result`, `--ordinal` for call/result, and `--offset`
from `contents.content.nextOffset` to continue the text. See
[Code runs](/en/docs/platform/code-runs) for call states and uncertain outcomes.

Pause and resume require `--yes` and the same execution-editor authority as
the Code surface. Phone sessions cannot change execution authority. A version
must already be active; resume rechecks its approval and is refused in CI. Pause stops new admissions;
missed events are not replayed. Pending newer versions remain pending.

## Read and replace policy

```sh
cld code policy read --json
cld code policy effective --json
cld code policy preview --revision 3 --preset admin --json
cld code policy update --revision 3 --preset admin --yes --json
```

Read returns the visible policy and its revision. Effective resolves the
current person's rules; `--owner owner.json` selects an owner and
`--author-id <UUID>` selects a resource/app version author. Other owners require
Cloud administration. Preview and update also require Cloud administration.
Update requires a full administrative credential; phone sessions are refused.

Use exactly one of `--preset off|admin|open` or `--from <file|->` for preview
and update. A file contains the complete `{preset,rules}` definition, including
all defaults and group overrides. Presets replace the whole table. Preview
pages affected Code with `--cursor` and `--limit`. Update returns the new policy
and a durable pause-job receipt; affected running Code may be paused later.

Always pass the revision read before editing. If preview or update returns
`CONFLICT`, read again, reconcile the definition and preview again. The CLI
never silently reads a newer revision or retries a stale write.

## Write secrets privately

Secret commands require Code editor access. Values are write-only and never
appear in list, set or delete responses. Keep values out of command arguments,
source files and version control. Put the value in a private file or pipe it
through stdin:

```sh
cld code secret set BANK_TOKEN ./code/example/box_1234 --from /private/bank-token --binding bank-binding.json --binding-revision null --json
# Or pipe a private secret source into the same command with --from -.
cld code secret list ./code/example/box_1234 --json
cld code secret delete BANK_TOKEN ./code/example/box_1234 --binding-revision 11111111-1111-4111-8111-111111111111 --yes --json
```

A new name requires `--binding` with a destination definition:

```json
{"origin":"https://bank.example","pathPrefix":"/api","headers":["authorization"]}
```

For an existing name, pass its current `binding_revision` from list/set as
`--binding-revision <UUID>`. Omit `--binding` to retain the destination.
Changed destinations create a new immutable binding revision and require a
new version submission. Replacing a value applies immediately to all versions
using that name. One final newline from file/stdin is removed; other bytes
are preserved. Values must satisfy the server's printable ASCII contract. Selected input files
may be symlinks, including mounted secret files. Use `--from -` for pipes.

List returns names, destinations, binding revisions and `configured`, with
`nextCursor` for `--cursor`; `--limit` accepts 1–20. Delete requires `--yes`
and the current binding revision. It removes the value for every version and
retains binding evidence. A stale binding revision fails; read metadata and
reconcile before retrying. No command reads a secret value.

## JSON and exit codes

Every command supports `--json` (one value) and `--jsonl` (one compact value).
Exit 0 means it completed the requested operation; 1 means failure, including
failed checks, tests and simulations. A successful activation/start command
returns a durable receipt, not completion of background work.

| Commands | Stable success value |
| --- | --- |
| init, pull | `{version:1, config, files}` |
| sdk pull | `{version:1, files}` |
| check | `{version:1, result, manifest, permissions}` |
| test, simulate | C17 `{version:1, mode, ok, error, diagnostics, cases, trace?}` |
| push, submit | `{version:1, submission}` |
| diff | `{version:1, diff}` |
| activate | `{version:1, activation}` |
| run | `{version:1, run:{runId, duplicate}}` |
| pull --all | `{version:1, items:[{version:1,config,files}], nextCursor:null}` |
| status | `{version:1, items:[{code,permission,baseVersionId,baseCurrent,modified,latest}]}` |
| runs | `{version:1, items, nextCursor}` |
| runs --run | `{version:1, run, contents}` |
| pause, resume | `{version:1, state}` |
| policy read | `{version:1, policy}` |
| policy effective | `{version:1, revision, rows}` |
| policy preview | `{version:1, revision, total, items, nextCursor}` |
| policy update | `{version:1, policy, pauseJobId}` |
| secret set | `{version:1, secret}` (metadata only) |
| secret list | `{version:1, items, nextCursor}` (metadata only) |
| secret delete | `{version:1, deleted}` |

Check embeds `CodeCheckResultSchema`; `manifest` is complete C8 submission
evidence or null on failure. Permission rows carry operation, target, nullable
title/typeTitle, own, needsTargetAdmin, file, line and new/existing status.
Test and simulation reuse `CodeTestResultSchema` unchanged. Output adds no elapsed times, process
IDs or local absolute paths. Stateful operations return durable IDs and times.
JSON keys and enum values remain untranslated.

Executed-command failures use
`{version:1,error:{code,message,details}}`. Conflicts retain all C8 evidence;
other details may be null. Help and failures before module loading use the
shared CLI host contract. A busy/unavailable runner fails visibly; retry when
capacity returns. HTTP work is bounded by the platform's 240-second request
budget and cancelled on disconnect.

Core defines these schemas once in `code/authoring-contracts.ts`:
`codeAuthoringContracts`, `CodeProjectSchema`, `CodeAuthoringErrorSchema`,
`CodeAuthoringPermissionSchema`, and `CodeAuthoringConflictSchema`, with
`CodeAuthoringInput<K>` and `CodeAuthoringData<K>`. `codeAuthoringServices`
exposes the matching permission-aware service operations for C19 chat tools.
They are re-exported from `packages/core/src/code/index.ts`. HTTP clients POST
inputs to `/api/code/authoring/<contract-key>` and receive the schema's data
value directly. Check/test/simulate use C13b's runner hosts; callers cannot
supply compiler paths, SDK metadata or budget overrides.

Policy and binding conflicts, denied reads/writes, incomplete pulls and invalid
local input exit 1. Status differences alone exit 0. Secret write failures
return a generic message without private input. The shared contract adds
`pullAll`, `status`, `runs`, `runRead`, `pause`, `resume`, `policyRead`,
`policyEffective`, `policyPreview`, `policyUpdate`, `secretSet`, `secretList`
and `secretDelete`; `CodeLocalStatusSchema` and `CodeWorkspaceStatusSchema`
define the local comparison. Existing C18a keys and version 1 stay unchanged.
