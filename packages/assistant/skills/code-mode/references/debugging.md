# Run and debug

Load the required `code_*` tools with `load_tools`. They are available only when
a connected Assistant browser or CLI execution host advertises them. For example:
`load_tools({"names":["code_run","code_interact","code_open"]})`.
Use these exact names without `assistant.`; they are browser tools, not app
capabilities. If absent, do not claim to have
executed the code. There is no browser setup or technical switch for the user.

| Tool | Input | Result |
| --- | --- | --- |
| `code_run` | `id` or `code`, optional `inputPaths`, `version` | Starts saved source or a one-off entry; returns `runId` and snapshot |
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

Each agent run has fresh local memory and captures downloads. It cannot read
the user’s persistent browser storage or open a native file picker. Scripts
can receive selected authorized chat files through `inputPaths`; GUI apps
cannot. Shared storage, database writes, and capabilities affect real resources,
even in agent runs. Read the corresponding reference before using them.

The execution host must stay connected. Each tool call has a server execution claim:
a second tab can reuse its completed result, but cannot execute the same call.
An interrupted or uncertain call is not replayed. After reload, an old run may
be gone; start a new one and repeat the needed steps. Calls have a 45-second
execution budget, paused while waiting for capability approval; timed-out
execution is stopped. Stop obsolete runs explicitly.

If copying output had an uncertain outcome, inspect the returned or
deterministic chat path before requesting another copy. Never report an
unexecuted or incomplete test as successful.

A test run is separate from the user’s open app. Saving or running code does
not replace that app’s running version. Users can restart after the new-version
notice appears; never claim their open app has updated solely because a test passed.


## Direct Cloud CLI execution

`assistant code run --chat CHAT --input-file run.json` executes without a model
turn or an open browser tab. The CLI starts the same isolated worker in headless
Chromium. Supply a JSON `code_run` input, such as `{"code":"export default () => 42"}`
or `{"id":"RESOURCE_ID","version":2}`. Historical versions require Manage.

Optional `--steps-file steps.json` supplies an array of `{name,args}` steps using
`code_interact`, `code_inspect`, or `code_export`. The command supplies the current
`runId` automatically. It returns each snapshot and closes the worker afterward.
Upload inputs with the normal chat file commands, then select them in
`inputPaths`. Use `code_export` steps to retain outputs in the chat.

Actions requiring approval need an explicitly authorized `--approve` capability
name or an interactive Assistant chat. Source code cannot grant approval.
