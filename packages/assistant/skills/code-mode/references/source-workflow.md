# Code files

Use `load_tools` with these stable capability IDs. Cloud returns the callable
function names; do not guess transport-specific names.

| Capability | Input | Purpose |
| --- | --- | --- |
| `assistant.code_create` | `title`, optional `description` | Create one private app; returns `id`, `entry`, and files |
| `assistant.code_read` | `id`, optional `path`, `offset`, `revision` | Current directory without path; file content with path |
| `assistant.code_write` | `id`, `path`, `content` | Create or overwrite one complete file and save immediately |
| `assistant.code_remove` | `id`, `path` | Remove a source file, preserving history and the app |
| `assistant.code_list` | optional `page` | Find accessible apps; follow `hasNext` |
| `assistant.code_history` | `id`, optional `page` | List old saved versions for recovery |

`id` always means the app ID, including `code_run` and `code_open`. `runId`
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

Cloud capability requests and results are limited to 256 KiB, including JSON.
Keep source files focused and within that transport budget. Only return concise
metadata from tools; write large analysis results as output files.

Creation and file mutations run without approval prompts, within the user's
existing permissions. Cloud still requires idempotency keys. This does not grant
sharing or app deletion. Reuse a key only for retrying the same logical operation, and
inspect current state after an uncertain result before deciding to retry.

Give an app a concise title and an optional one- or two-sentence description of
its purpose. Users see these in the chat context and app overview cards.
