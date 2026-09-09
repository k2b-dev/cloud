# Kit

Use `cld kit help` and `cld kit sdk --json` to discover current commands and SDK
methods. Kit stores app source and grants in Cloud; scripts run only after the
user clicks Start in their browser. The CLI never runs scripts or accesses the
browser's OPFS/KV. Money, CSV and UI helpers run in the isolated worker.

## Create, inspect and edit

```sh
cld kit init ./tool --blank
cld kit validate ./tool --json
cld kit push ./tool --json
cld kit list --search "tool" --page 1 --json
cld kit manifest abc123 --json
cld kit get abc123 --json
cld kit pull abc123 ./new-checkout --json
cld kit sdk --json
```

Omit `--blank` for the CSV workshop and history starter. Edit the files and
`kit.json`; every *.script.js defines a navigation item with
`export default kit.script({ name, run() {} })`. Helpers use relative .js imports.
`push` creates an app when the manifest has no ID and records its short ID and
revision. Later pushes replace the complete project against that revision.
`pull` requires a new directory and refuses to overwrite a checkout. `list`
is paginated: continue while hasNext is true. `manifest` reads metadata and file
paths; `get` and `pull` also read complete source and require Use permission.

## Focused source changes

These commands use the same service as Assistant capabilities. `--input-file`
reads JSON from a file; `--stdin` reads it from stdin. Inspect command help
for the complete input options.

```sh
cld kit source read abc123 --input-file read.json --json
cld kit source validate abc123 --input-file changes.json --json
cld kit source apply abc123 --input-file changes.json --json
```

A read request is `{ "path": "main.script.js", "expectedRevision": 4 }`.
Follow `nextOffset` until `complete` at the same revision. Offsets and lengths
count UTF-16 units. Never replace a whole file using only a partial read.

A change request has `expectedRevision` and any of:

- `upsert`: `{ path, content }` entries containing complete new file contents;
- `delete`: exact relative paths;
- `edits`: `{ path, offset, deleteCount, content }`, one range per existing file.

Each path appears in only one operation. Omitted files remain unchanged. Update
imports in the same batch. Validation checks the final project without saving or
executing it. Applying commits the batch atomically and returns the new revision.
Capabilities cap the JSON request at 256 KiB; use focused edits for large files.
The REST/CLI transport accepts larger project transfers within Kit's source limits.

On `REVISION_CONFLICT`, reread and reconcile. Do not blindly retry a stale or
unknown save outcome. Static validation does not prove runtime behavior; open the
returned app URL, explicitly start the tool, and test representative inputs.

## Administration

The terminal workflow supports app administration when the user authorizes it,
even though Assistant's Kit capabilities deliberately expose only source editing.
All operations enforce the caller's current Cloud permissions.

```sh
cld kit update abc123 --input-file metadata.json --json
cld kit access list abc123 --json
cld kit access grant abc123 --help
cld kit access set abc123 --help
cld kit access revoke abc123 --help
cld kit delete abc123 --yes --json
```

Metadata JSON contains `expectedRevision` and the fields to change: `name`,
`description`, `persistenceEnabled`. Omitted fields and all source remain intact.
The revision advances, so refresh an existing local checkout before pushing it.
Grant commands support users, groups and authenticated users, not public access.
Use their exact principal and permission flags from `--help`.

Read permission shows metadata; write/Use allows source access and running;
admin allows source editing, metadata changes, sharing and app deletion. Keep
at least one administrator. Grant/revoke only within the user's requested scope.
Delete only an explicitly selected app with deletion authorization. Deletion
removes source and grants; it cannot remove browser data on other devices.

Sharing shares code, never browser-local results. Disabling persistence blocks
script reads and writes without deleting retained data. There is no temporary
fallback. The browser Settings explorer can still inspect retained local data;
all users with Use access can clear their own app-local data after confirmation.

## Authoring help

Kit's registered Help contains usage, editing, Assistant and sharing guides plus
SDK articles for script, ui, file, sheet, money, store and opfs. Use the existing
Cloud Help search/read tools when available. SDK Help signatures and `cld kit sdk`
come from one source; do not assume unsupported APIs exist.

For file tools use `ui.workbench({ controls, content, footer })`, with sections,
file pickers, lists, tables and status. Inputs should filter appropriate file
types; processing must still validate contents. `ui.markdown`, `ui.link` and
`ui.linkButton` provide presentation and navigation. `kit.money` handles exact
currency amounts. Preserve originals and give useful empty, loading and error
states. The user explicitly starts every tool; code changes do not auto-run it.

### Markdown pages

Project files may also use `.md`. Each Markdown file appears in app navigation; its first `# Heading` supplies the title, falling back to its filename. The editor offers **Add Markdown page**, the shared Markdown editor, and a live preview. Pages render directly without a worker launch. Existing source read, validate, apply, pull, and push operations handle Markdown with the same permissions, revision guards, and file size limits. Markdown cannot be imported as JavaScript. An app needs at least one script entrypoint or Markdown page.
