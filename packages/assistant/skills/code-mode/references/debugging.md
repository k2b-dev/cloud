# Run and debug

Load the required `code_*` tools with `load_tools`. They are available only when
the connected Assistant browser advertises them. For example:
`load_tools({"names":["code_run","code_interact","code_open"]})`.
Use these exact names without `assistant.`; they are browser tools, not app
capabilities. If absent, do not claim to have
executed the code. There is no browser setup or technical switch for the user.

| Tool | Input | Result |
| --- | --- | --- |
| `code_run` | `id`, optional `inputPaths` | Starts the current saved code; returns `runId` and snapshot |
| `code_inspect` | `runId`, optional `nodeId`, `offset`, `limit` | UI, logs, errors, modal, output, and files |
| `code_interact` | `runId`, `id`, optional `value`, `action`, `item` | Performs an interaction and returns the resulting state |
| `code_stop` | `runId` | Stops and releases a test run |
| `code_export` | `runId`, `name` | Copies a captured output file into the chat; returns its path |
| `code_open` | `id` | Opens the user's app tab without starting code |

## Test the result

Write source, run it, and inspect the returned snapshot. For calculations,
verify the returned values with representative inputs and inspect output files.
For interactive apps, exercise the main action and invalid input. Fix source
and start another run when needed. No revision argument is required.

Use IDs returned in the snapshot. A button needs only its control `id`; an input
or select also needs a string `value`. A list action needs its control `id`,
`action`, and current `item` ID. Do not guess IDs from visible labels.

A pending modal has its own `id` and schema. Answer it through `code_interact`
with that ID and a `value`: boolean for confirm, scalar for text/number, a field
object for a form, or null to cancel. Invalid answers leave the dialog open for
correction. Do not reuse an ID from an earlier modal.

Run and Interact already include a compact snapshot. Inspect only when you need
more detail. Nodes are paginated (20 by default); follow `nextNodeOffset`.
Use `nodeId` to page through rows, items, or options. Counts describe the full
collection. Logs include the latest 20 entries; long text and output previews
are truncated. Use `files.save` and `code_export` for complete deliverables,
then inspect/present them with the normal chat file tools.

## Isolation and interruptions

Each run has fresh memory and captures downloads. It cannot read the user's
persistent app storage or open a native file picker. Supply authorized chat
files through `inputPaths`; no other files are available to the run.

The browser must stay connected. Each tool call has a server execution claim:
a second tab can reuse its completed result, but cannot execute the same call.
An interrupted or uncertain call is not replayed. After reload, an old run may
be gone; start a new one and repeat the needed steps. Calls have a 45-second
budget; timed-out execution is stopped. Stop obsolete runs explicitly.

If copying output had an uncertain outcome, inspect the returned or
deterministic chat path before requesting another copy. Never report an
unexecuted or incomplete test as successful.

A test run is separate from the user’s open app. Saving or running code does
not replace that app’s running version. Users can restart after the new-version
notice appears; never claim their open app has updated solely because a test passed.
