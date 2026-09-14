# Run and debug

Load the required `code_*` tools with `load_tools`. Run, inspect, interact, stop,
and export execute on the Assistant server, independently of the user's tab.
`code_open` and `code_secret` use the user interface. Use the exact tool names
without `assistant.`; they are direct tools, not app capabilities. If execution
is unavailable, report that state rather than claiming the code ran.

| Tool | Input | Result |
| --- | --- | --- |
| `code_run` | `id` or `code`, optional `inputPaths`, `version` | Starts saved source or a one-off entry; returns `runId` and snapshot |
| `code_inspect` | `runId`, optional `nodeId`, `offset`, `limit`, `waitMs` | UI, logs, errors, modal, output, and files |
| `code_interact` | `runId`, `id`, optional `event` or modal `answer` | Performs an interaction and returns the resulting state |
| `code_stop` | `runId` | Stops and releases a test run |
| `code_export` | `runId`, `name` | Copies a captured output file into the chat; returns its path and version |
| `code_open` | `id` | Opens the user's app tab without starting code |

## Test the result

Write source, run it, and inspect the returned snapshot. For calculations,
verify the returned values with representative inputs and inspect output files.
For interactive apps, exercise the main action and invalid input. Fix source
and start another run when needed. No revision argument is required.

Use IDs returned in the snapshot. A button needs only its control `id`; an input
or select uses `event: {type:"change", value:...}`. Table/chart selection uses
`event: {type:"select", key:...}`. See [Analytics UI](analytics.md) for all events.
Each inspected control includes `interactions` examples. Add the current `runId`
and adjust the event value; send the object directly, not JSON encoded as text.
Do not guess IDs from visible labels.

A pending modal has its own `id` and schema. Answer it through `code_interact`
with that ID and an `answer`: boolean for confirm, scalar for text/number, a field
object for a form, or null to cancel. Invalid answers leave the dialog open for
correction. Do not reuse an ID from an earlier modal.

Run and Interact already include a compact snapshot. Inspect only when you need
more detail. Nodes are paginated (20 by default); follow `nextNodeOffset`.
Use `nodeId` to page through rows or options. Counts describe the full
collection. Logs include the latest 20 entries; long text and output previews
are truncated. Use `files.save` and `code_export` for complete deliverables,
then inspect/present them with the normal chat file tools.

## Isolation and interruptions

Each agent run has fresh local memory and captures downloads. It cannot read
the user’s persistent browser storage or open a native file picker. Scripts
receive selected chat files through `inputPaths`; app tests use those paths
only as isolated picker fixtures. Shared storage, database writes, and capabilities affect real resources,
even in agent runs. Read the corresponding reference before using them.

The server owns one isolated host per active conversation. Calls and ordered
approval decisions are durable: reconnecting continues the same call without
repeating effects. A lost host produces an explicit failure, never an automatic
rerun. Inspect saved data before deliberately starting a replacement run.
The host retains temporary runs while the conversation is active and for two
idle minutes after it finishes. Saved source and exported files remain durable.
The server admits eight hosts; a full host pool returns an availability error.

The deadlines protect different boundaries:

- Startup and short callbacks: 15 seconds of readiness/execution time. Pending
  input reads pause startup; file reads/pickers and database/shared-storage
  requests pause callback timers.
- The agent host has a 20-second readiness guard, also paused during input, database and shared-storage
  requests and capability waits. It must not expire just because input downloads
  exceed 15 seconds.
- A tool call has a 45-second outer budget, including compilation and file
  transfer. Capability approval waits pause this budget. Hanging input transfers
  are therefore still bounded and stopped; inspect the input/network error.
- `work.run` has no total-duration limit while the worker heartbeat responds;
  15 seconds without a heartbeat terminates it. Use checkpoints for CPU loops.
  `code_inspect` waits at most 30 seconds per call and returns current progress.

Runtime stack positions refer to the compiled bundle, not original source
lines. Use the message and source to locate the issue; compilation diagnostics
already identify original files/positions. `outputTruncated` marks incomplete
snapshot output; do not parse or report a shortened result as complete.

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

The CLI keeps its host alive until a background job finishes; `--steps-file` can
inspect or interact before that final wait. A pending unanswered dialog needs an
explicit interaction step. Ctrl+C closes the host. The final result must show
completion before an export or a success claim.

`code_update` changes metadata only. The existing CLI command `assistant code
update` instead replaces a complete source bundle and metadata with a revision
check. Prefer `assistant code write` for ordinary file edits; do not confuse
that CLI command with the agent's metadata tool.
