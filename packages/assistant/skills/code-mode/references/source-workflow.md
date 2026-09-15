# Code files

This workflow is for saved resources. For exploration or a one-time result,
pass code directly to `code_run`; no create/write sequence is needed. Before
building an app around unfamiliar data, test its processing core with a small
one-off and representative inputs. Then use the learned structure here.

## Agent-only scripts and display-only dashboards

A saved resource does not require an interactive UI. Choose `kind:"script"`
for a reusable procedure the agent calls with `code_run({id, inputPaths?})`.
Persistence is optional: a reusable converter, validator or calculation can
operate entirely on each run's inputs without a database or stored data.
Return a small JSON result and optional output files; do not create buttons,
modals or a dashboard merely to make it reusable. Its database and shared files/KV
belong to that resource and survive runs and chats. Find it again with
`code_list` and reuse its ID rather than creating a copy for each session.
Variables and agent local storage do not survive as durable shared state.

For example, a saved importer can read explicitly supplied chat files, validate
rows, store them through `database.connect()` and return inserted/rejected
counts. Subsequent authorized chats can run the same resource. Initialize schema
with Manage access before publishing, then normal Use-level runs can work with
existing rows. See [Database](database.md) and [Storage](storage.md).

For a user who only wants to see results, keep an app's UI to a dashboard over
its resource data. The agent can inspect it with `code_sql` and, with Manage,
maintain that same app's data through `code_run({code,resourceId})`, without adding
maintenance controls or rewriting its dashboard source. Display-only UI is a
presentation choice, not an additional database permission boundary. Separate
saved resources have separate databases; they do not share data automatically.

The current API runs the saved default entry, or a one-off maintenance entry.
It has no named exported app-action invocation and no arbitrary argument object
for saved runs. Use documented `inputPaths` for file inputs. Do not invent
`actions.run`, `code_action`, cross-resource database handles or hidden UI
controls as a substitute. Configurable exported app actions would be a separate
runtime feature, not something a skill can enable.

Use `load_tools` with these exact Assistant tool names. Each tool has one
small input schema; there is no app prefix or capability name to translate.

| Tool | Input | Purpose |
| --- | --- | --- |
| `code_create` | `title`, `kind: "app"` or `"script"`, optional `description`, `icon` | Create one private resource; returns `id`, `entry`, and files |
| `code_read` | `id`, optional `path`, `offset`, `revision` | Current directory without path; file content with path |
| `code_write` | `id`, `expectedRevision`, `files: [{path, content}]`, optional `entry` | Atomically save a batch and return the new revision plus diagnostics |
| `code_remove` | `id`, `path` | Remove a source file, preserving history and the app |
| `code_list` | optional `page`, `kind`, `q` | Find accessible apps or scripts; follow `hasNext` |
| `code_history` | `id`, optional `page` | List old saved versions for recovery |

`id` means the saved resource ID. A one-off `code_run` supplies `code` instead
and creates no saved resource. `code_open` is for GUI apps. `runId`
identifies a particular execution. The resource reader follows Cloud's standard
`id` contract. Source file paths are relative, such as `main.ts` or `lib/math.ts`.

Create returns a minimal `main.ts` entry. Replace it with the requested program.
The entry default-exports a function, not its returned object. Local imports may
omit `.ts` or `.js` when exactly one matching file exists; use the exact extension
when both exist. Package imports and paths outside the resource are unavailable.
Use the same ID for all related files, tests, and subsequent repairs. Creation
does not start code or share the app.

```json
{
  "id": "ID returned by code_create",
  "expectedRevision": 1,
  "files": [{ "path": "main.ts", "content": "export default () => ({ answer: 42 });" }]
}
```

Source tools return `{ok:true,data,...}` or `{ok:false,error}`. Read IDs,
`revision`, file windows and diagnostics from `data`. A successful write returns
`data.saved: true`. Diagnostics describe compilation
problems in the saved source; they do not mean the file was rejected. Save related files in one batch. Missing imports
or syntax errors prevent execution, not intermediate saves. Invalid paths,
permissions, or storage limits still reject the write.

Other files stay unchanged. Read the current `revision` before writing and pass
it as `expectedRevision`; use the returned revision for the next edit. A stale
revision returns `CONFLICT` without saving anything. Re-read and reconcile rather
than blindly retrying. Each run keeps a fixed source snapshot; start another run
to execute edits. Removing an absent path is harmless. Removing the entry requires
recreating it before execution.

Read long files through `nextOffset` until `complete` is true. Offsets count
UTF-16 units. Never replace a file with only the returned first window. If source
is being changed concurrently, use a historical revision for a consistent read.
For recovery, `code_history` returns revisions accepted by `code_read`; write the
recovered content with `code_write`.

Keep source files focused; each file is limited to 1 MiB of UTF-8 content.
Tool results are bounded to 256 KiB. Write large analysis results as output files.

Creation and file mutations run without approval prompts, within the user's
existing permissions. Replay protection is handled internally; do not supply
idempotency keys. This does not grant sharing or app deletion. Inspect current
state after an uncertain result before deciding to retry.

Give an app a concise title and an optional one- or two-sentence description of
its purpose. Users see these in the chat context and app overview cards.

## Source history storage

Saving preserves the current revision and all publications. When retained source
history reaches 250 MiB, the oldest unpublished revisions can be removed to make
room for a save. A pruned historical revision returns NOT_FOUND. Publications
are never pruned automatically. If protected history itself fills the budget,
the save fails atomically with STORAGE_FULL. An independent copy starts with
fresh source history, but also without the original's data or access grants;
explain that tradeoff before proposing it as recovery.

For saved scripts intended to be started by a person, show a short readable
summary with `ui.text({value, markdown:true})` or a compact `ui.table` and offer detailed results
with `files.save`. Keep structured return values for agent inspection. Read the
UI reference only for the presentation controls you need; a full app is optional.

Before editing source while the user is also using the editor, announce the
change. Saves reject stale revisions rather than overwriting either draft. The
user can download their current editor draft and explicitly load the latest
source before reconciling changes. Resource managers can delete apps/scripts in
Studio or with `assistant code delete ID --yes`; no agent deletion tool exists.

Studio's Advanced menu offers a manual multi-file editor for resource managers.
It is optional: continue doing normal work with `code_read` and `code_write`.
Save stores the draft without starting or publishing it. Start in the adjacent
app panel runs the saved source as a normal user run, with normal local storage
and file selection. Publish creates a release from saved changes. Agent test
runs still support isolated picker fixtures through `code_run.inputPaths`.
If a person edits at the same time, read the latest source before your next
write; do not overwrite changes you have not inspected.

## Atomic edits and data imports

Read the current revision, then save related modules together:

```js
code_write({ id, expectedRevision: 3, files: [
  { path: "data.json", fromChatFile: { path: "/validated-data.json", version: 1 } },
  { path: "main.ts", content: 'import rows from "./data.json"; export default () => ({rows: rows.length});' }
] });
```

`fromChatFile` copies a specific current-chat file version on the server. Export
validated data with `code_export`, use the resulting path/version, and avoid
printing/retyping large datasets. A stale revision or file version fails without
saving any files; re-read before reconciling. Source imports support `.json`
objects and `.csv`, `.tsv`, `.txt` strings; pass CSV strings to `sheet.fromCsv`.
Imported text must be UTF-8; decode older encodings in a script before exporting.
Each source/data file is limited to 1 MiB and the bundle to 2 MiB. Use resource
storage or its database for larger datasets. Keep full numeric precision in
stored data and format only at display time. Always rerun the saved revision;
a copied scratch script is not a test of the saved app.
