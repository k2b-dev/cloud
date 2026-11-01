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
