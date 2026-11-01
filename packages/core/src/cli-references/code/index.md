# Code

Develop Code in local files, check it on Cloud's runner, and save an immutable
version. Use `cld code help` for the current command flags. Every command supports
`--json` and `--jsonl`; exit code 0 means the requested operation succeeded,
and 1 means failure, including a failed check, test, or simulation.

## Start a project

```sh
cld code init --title 'Weekly report' --out ./code
cld code init --title 'Invoices' --owner-type example.box --owner-id box_1234 --out ./code
cld code sdk pull ./code/example/box_1234
cld code check ./code/example/box_1234
```

Without owner flags, `init` creates personal Code. Use `--app <id>` for
application-owned Code instead of `--owner-type` and `--owner-id`. Creation
requires administration of the owner. Other source operations require Code
editor access and a write credential; pull and diff require read access.

Folders use short resource IDs: `example/box_1234`, `me/c_1234`, or
`example/c_1234` for an application owner. Titles and owner identities are in
`code.json`, alongside `codeId`, `entry`, and `baseVersionId`. Folder names never
contain email addresses or titles. Run project commands inside that directory,
or pass its path (a file inside the project also resolves to its `code.json`).

`sdk pull` writes `sdk/sdk.d.ts`, `sdk/sdk.js`, `sdk/manifest.json`, and
`tsconfig.json`. These generated files may be replaced on the next SDK pull.
They are excluded from source submission. The only SDK import in user code is
`@sdk`. Check uses the current server SDK, even if the local SDK is stale.

## Check, test and simulate

```sh
cld code check ./code/example/box_1234 --json
cld code test ./code/example/box_1234 --trace --json
cld code simulate ./code/example/box_1234 --fixture test/monday.json --json
```

Check reports every operation, target title and ID, source file and line.
A newly required target grant is marked “neu, braucht den Admin des …” in
German output. Unavailable titles fall back to the resource Type and ID.
Pages, webhooks and databases show a dash in Phase 1; their later syntax is
rejected by the checker.

Tests are declarative `test/*.json` fixtures; nested test folders are supported.
Each fixture fixes `now`, `seed`, mock replies and named entrypoint invocations.
Simulation accepts exactly one invocation. Both use fake capability data and
cannot write production resources. `--trace` adds run boundaries. See the canonical Test Code documentation for the fixture fields.

A busy or unavailable runner returns a visible failure. Retry after capacity
returns. A failed check saves no version.

## Pull, push and submit

```sh
cld code pull c_1234 --out ./fresh-code
cld code push ./fresh-code/example/box_1234 --json
# Alternative to push: cld code submit ./fresh-code/example/box_1234 --json
cld code diff ./fresh-code/example/box_1234 --json
```

Pull downloads the latest saved source, including its exact base version, into
a **new** folder. An existing folder is refused to preserve local edits. Use a
new `--out` root when comparing remote work with your local files.

Push and submit both check the source and save it through the same submission
service. Policy determines whether the saved version needs Cloud-admin
approval. Neither command activates it. They send `baseVersionId` from
`code.json` and update that local field only after a successful save. An
explicit `--base-version-id <UUID|null>` overrides the base; it never forces an
overwrite.

If someone else saved first, the command exits 1 with “Neuere Version
vorhanden” and the complete source difference. JSON preserves
`code_version_conflict`, `latestVersionId`, and the diff rows in
`error.details`. Pull into another directory, reconcile the changes, and use
the newly pulled base. Never replace a base merely to silence a conflict.

Diff compares a saved version against its recorded approval baseline. It
uses the project's base version by default; `--version <UUID>` chooses another
saved version. It includes unchanged rows and files.

## Activate and run

```sh
cld code activate ./code/example/box_1234 --activation-id 11111111-1111-4111-8111-111111111111 --yes --json
cld code run monday ./code/example/box_1234 --key monday-manual-1 --json
```

Activate uses the project's base version unless `--version <UUID>` is set.
It requires `--yes` and a caller-chosen `--activation-id`. Reuse that ID after
a lost response. A returned pending/waiting state is a durable activation
receipt; it does not mean the version is already running. A terminal failed
or cancelled receipt exits 1.

Activation requires a normal person's session or personal OAuth credential,
current owner administration and every target permission, plus any required
version approval. Phone sessions, API keys and machine identities cannot
activate. CI may check, test and push using its granted credential; the CLI
also refuses activate when its host reports CI. Do not use a person's
interactive credential in CI.

Run starts a named schedule on the **active** version. The required `--key`
prevents duplicate starts when retrying after a lost response. Use a new key
for a new intentional run. The result is a queued run receipt, not the run's
final outcome.

## Pull the instance's resource Code and inspect status

```sh
cld code pull --all --out ./instance-code --json
cld code status ./instance-code --json
```

`pull --all` requires a Cloud administrator and downloads every resource-owned
Code through the same source reader as a single pull. Personal and
application-owned Code are excluded. Resource folders use short IDs, for
example `mail/box_1234`; titles and owners remain in `code.json`. Pull never
activates Code. It refuses existing project folders. If a later project fails,
earlier folders remain: inspect them and retry into a new root.

Status discovers every `code.json` below the selected root (the current
directory by default), or finds the surrounding project from a source path. It compares local source with its saved base and reports the latest
server version, approval receipt, active version, execution state, pause reason,
and whether a newer server base exists. An empty root returns an empty list.
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

## Stable JSON

The Core shared contract is `codeAuthoringContracts` in
`packages/core/src/code/authoring-contracts.ts`, re-exported from `code/index.ts`.
C19 chat tools use the same schemas and `codeAuthoringServices`.

| Command | JSON success value |
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

`result` in check is `CodeCheckResultSchema`; `manifest` is the complete
submission manifest or null on check failure. Permission rows contain
`operation`, `target`, `title`, `typeTitle`, `own`, `needsTargetAdmin`, `file`, `line`, and `status`.
Unavailable titles are null; status is `new` or `existing`. Existing grants
are observed live rather than inferred from old source. Personal Code never
needs target-admin grants; `needsTargetAdmin` is always false for it.

Errors from executed commands use
`{version:1,error:{code,message,details}}`; details is null unless the owning
service supplies structured evidence. Help and failures before module loading
follow the shared CLI host's output contract. JSON names and enum values are
never translated. Fixed source, catalog, grants and fixtures produce the same
check/test JSON; generated SDK files are stable. Stateful saves and starts
return their durable IDs and timestamps. No result adds local machine paths,
process IDs or elapsed times.

Policy and binding conflicts, denied reads/writes, incomplete pulls and invalid
local input exit 1. Status differences alone exit 0. Secret write failures
return a generic message without private input. The shared contract adds
`pullAll`, `status`, `runs`, `runRead`, `pause`, `resume`, `policyRead`,
`policyEffective`, `policyPreview`, `policyUpdate`, `secretSet`, `secretList`
and `secretDelete`; `CodeLocalStatusSchema` and `CodeWorkspaceStatusSchema`
define the local comparison. Existing C18a keys and version 1 stay unchanged.
