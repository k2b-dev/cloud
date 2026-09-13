# Code files

This workflow is for saved resources. For exploration or a one-time result,
pass code directly to `code_run`; no create/write sequence is needed. Before
building an app around unfamiliar data, test its processing core with a small
one-off and representative inputs. Then use the learned structure here.

Use `load_tools` with these exact Assistant tool names. Each tool has one
small input schema; there is no app prefix or capability name to translate.

| Tool | Input | Purpose |
| --- | --- | --- |
| `code_create` | `title`, `kind: "app"` or `"script"`, optional `description`, `icon` | Create one private resource; returns `id`, `entry`, and files |
| `code_read` | `id`, optional `path`, `offset`, `revision` | Current directory without path; file content with path |
| `code_write` | `id`, `path`, `content` | Create or overwrite one complete file and save immediately |
| `code_remove` | `id`, `path` | Remove a source file, preserving history and the app |
| `code_list` | optional `page`, `kind`, `q` | Find accessible apps or scripts; follow `hasNext` |
| `code_history` | `id`, optional `page` | List old saved versions for recovery |

`id` means the saved resource ID. A one-off `code_run` supplies `code` instead
and creates no saved resource. `code_open` is for GUI apps. `runId`
identifies a particular execution. The resource reader follows Cloud's standard
`id` contract. Source file paths are relative, such as `main.ts` or `lib/math.ts`.

Create returns a minimal `main.ts` entry. Replace it with the requested program.
Use the same ID for all related files, tests, and subsequent repairs. Creation
does not start code or share the app.

```json
{
  "id": "ID returned by code_create",
  "path": "main.ts",
  "content": "export default () => ({ answer: 42 });"
}
```

Every successful write returns `saved: true`. Diagnostics describe compilation
problems in the saved source; they do not mean the file was rejected. For example,
write an entry that imports a helper, write the helper, then run. Missing imports
or syntax errors prevent execution, not intermediate saves. Invalid paths,
permissions, or storage limits still reject the write.

Other files stay unchanged. Each file mutation uses the current stored bundle,
so parallel writes to different files preserve each other. The last write to the
same file wins. Do not coordinate your normal work with revision numbers.
Each test run internally keeps a fixed source snapshot; start another run to
execute edits. Removing an absent path is harmless. Removing the entry requires
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

## Work through the Cloud CLI

Use `assistant code create TITLE --kind app|script` for a saved resource.
`assistant code write ID main.ts --content-file ./main.ts` writes one complete
file and preserves its siblings. `assistant code get ID` reads source and
metadata. Source text may also come from stdin using the CLI input flags.
Use `assistant code update` only when intentionally replacing a complete source
bundle with its current revision check.

Use `assistant code run` for execution, `code sql` for a direct SELECT, and the
publication, access, and Project commands for their corresponding operations.
`code_open` in a headless CLI host returns the app URL; it does not claim to open
a user-visible tab.

## Source history storage

Saving preserves the current revision and all publications. When retained source
history reaches 250 MiB, the oldest unpublished revisions can be removed to make
room for a save. A pruned historical revision returns NOT_FOUND. Publications
are never pruned automatically. If protected history itself fills the budget,
the save fails atomically with STORAGE_FULL. An independent copy starts with
fresh source history, but also without the original's data or access grants;
explain that tradeoff before proposing it as recovery.

For saved scripts intended to be started by a person, show a short readable
summary with `ui.markdown` or a compact `ui.table` and offer detailed results
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
