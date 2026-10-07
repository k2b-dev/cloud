# Code files

This workflow is for saved resources. For exploration or a one-time result,
pass code directly to `code_run`; no create/write sequence is needed. Before
building an app around unfamiliar data, test its processing core with a small
one-off and representative inputs. Then use the learned structure here.

## Agent-only Apps and display-only dashboards

All reusable programs are Apps. Publish explicit [App actions](app-actions.md)
for a procedure the agent can call without Manage access or artificial buttons.
Persistence is optional: a reusable converter needs no database. A saved importer
can use the same App's database and files across authorized chats. Initialize its
schema with Manage before publishing; normal Use-level runs work with existing
rows. Separate Apps have separate data. One-off scripts stay scoped to the chat;
`code_run({code,resourceId})` explicitly requires Manage for App maintenance.

For a display-only dashboard, expose maintenance actions separately from its interface.
The user sees results while the agent operates the published handlers. A Skill can
explain when to use those handlers without duplicating their code. Skill and App
access remain separate; never assume sharing one also shares the other.

Use `load_tools` with these exact Assistant tool names. Each tool has one
small input schema; there is no app prefix or capability name to translate.

| Tool | Input | Purpose |
| --- | --- | --- |
| `code_create` | `title`, optional `description`, `icon` | Create one private resource; returns `id`, `entry`, and files |
| `code_read` | `id`, optional `path`, `offset`, `revision` | Current directory without path; file content with path |
| `code_write` | `id`, `expectedRevision`, `files: [{path, content}]`, optional `entry` | Atomically save a batch and return the new revision plus diagnostics |
| `code_remove` | `id`, `path` | Remove a source file, preserving history and the app |
| `code_list` | optional `page`, `q` | Find accessible Apps; follow `hasNext` |
| `code_history` | `id`, optional `page` | List old saved versions for recovery |

`id` means the saved resource ID. A one-off `code_run` supplies `code` instead
and creates no saved resource. `code_open` and `code_present` show apps with an
interface. `runId` identifies a particular execution. The resource reader follows
Cloud's standard `id` contract. Source file paths are relative, such as
`index.html`, `app.js` or `lib/math.js`.

Create returns a minimal `index.html` entry: an app with an interface. Write its
`index.html`, `style.css` and `app.js` as [HTML apps](apps.md) describes; app
JavaScript imports only other app `.js` files, with relative paths and the
extension. For a saved script that `code_run` executes instead, write the script
and pass it as `entry`; it default-exports a function. Script imports may omit
`.ts` or `.js` when exactly one matching file exists, and may import `.json`,
`.csv`, `.tsv` and `.txt` files. Package imports and paths outside the resource
are unavailable. Use the same ID for all related files and subsequent repairs.
Creation does not start code or share the app.

```json
{
  "id": "ID returned by code_create",
  "expectedRevision": 1,
  "files": [
    { "path": "index.html", "content": "<main><h1>Tips</h1><output id=\"tip\"></output></main>" },
    { "path": "app.js", "content": "document.querySelector('#tip').textContent = cloud.money.format(cloud.money.fromDecimal('4.20', { currency: 'EUR' }));" }
  ]
}
```

Source tools return `{ok:true,data,...}` or `{ok:false,error}`. Read IDs,
`revision`, file windows and diagnostics from `data`. A successful write returns
`data.saved: true`. Diagnostics describe problems in the saved source: compiler
messages for scripts and actions, and for an HTML app the static findings in its
JavaScript and CSS. They do not mean the file was rejected. Save related files in one batch. Missing imports
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

Creation and ordinary source edits run without approval prompts, within the user's
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

For Apps intended to be used by a person, show a short readable summary in the
page and offer detailed results with `cloud.download`. Keep structured return
values of scripts and actions for agent inspection. An interface is optional; an
App may only offer actions.

Before editing source while the user is also using the editor, announce the
change. Saves reject stale revisions rather than overwriting either draft. The
user can download their current editor draft and explicitly load the latest
source before reconciling changes. Resource managers can delete Apps in
Studio or through the reviewed tools in [Management](management.md).

Studio's Advanced menu offers a manual multi-file editor for resource managers.
It is optional: continue doing normal work with `code_read` and `code_write`.
Save stores the draft without starting or publishing it. Start in the adjacent
preview runs the files in the editor, saved or not, with the app's real data.
Publish creates a release from saved changes.
If a person edits at the same time, read the latest source before your next
write; do not overwrite changes you have not inspected.

## Atomic edits and data imports

Read the current revision, then save related modules together:

```js
code_write({ id, expectedRevision: 3, files: [
  { path: "data.json", fromFile: reference }, // exact reference returned by code_file_stat
  { path: "main.ts", content: 'import rows from "./data.json"; export default () => ({rows: rows.length});' }
] });
```

`fromFile` copies one explicit chat, Project, or App file reference as UTF-8 source.
Read [File transfers](files.md) to obtain the exact reference with `code_file_stat`.
Imports receive fresh review because the bytes become source that can be shared
or published. Export validated data with `code_export`, then inspect it, and avoid
printing/retyping large datasets. A stale revision or file version fails without
saving any files; re-read before reconciling. Script imports support `.json`
objects and `.csv`, `.tsv`, `.txt` strings; pass CSV strings to `cloud.sheet.parseCsv`.
An HTML app reads data files from `cloud.files` or from a `.js` module that
exports them.
Imported text must be UTF-8; decode older encodings in a script before exporting.
Each source/data file is limited to 1 MiB and the bundle to 2 MiB. Use resource
storage or its database for larger datasets. Keep full numeric precision in
stored data and format only at display time. Always rerun a saved script's
saved revision; a copied scratch script is not a test of the saved resource.
