# Run and debug

Load the required `code_*` tools with `load_tools`. Run, inspect, stop, export
and present execute on the Assistant server, independently of the user's tab.
`code_open` and `code_secret` use the user interface. Use the exact tool names
without `assistant.`; they are direct tools, not app capabilities. If execution
is unavailable, report that state rather than claiming the code ran.

| Tool | Input | Result |
| --- | --- | --- |
| `code_run` | `id` or `code`, optional `inputPaths`, `version`; one-off `code` may bind `resourceId` | Starts a saved script or a one-off entry; returns `runId` and a snapshot |
| `code_inspect` | `runId`, optional `waitMs` | Status, progress, logs, errors, output and captured files |
| `code_stop` | `runId` | Stops and releases a run |
| `code_export` | `runId`, `name` | Copies a captured output file into the chat; returns its path and version |
| `code_present` | `files` and `title`, or a saved app `id` | Shows an HTML app as a card in the chat after its static checks |
| `code_open` | `id` | Opens the user's app tab without starting it |

## Test the result

Write source, run it, and inspect the returned snapshot. For calculations,
verify the returned values with representative inputs and inspect output files.
Fix source and start another run when needed. Check the returned `revision`
against the saved revision you intend to deliver; runs have no revision input
argument.

HTML apps do not run in `code_run`; a saved app whose entry is `index.html`
fails there with a hint. Test their calculations in scripts, then read the
diagnostics that `code_write` returns for the app's JavaScript and CSS, and the
errors and warnings of `code_present`. In Studio, an app's errors and `console`
output appear in its console, and a failed `cloud.*` call the app did not handle
shows a notice outside the app. A chat card has no console: when the app fails
while starting, the card shows a short notice without the error text, and you do
not see it. Catch failures in the app and show `error.message` in the page.
Console lines past a per-second budget are dropped, and a blocked resource is
reported once per kind and origin.

Run already includes a compact snapshot; inspect only when you need more
detail. Logs include the latest 20 entries; long text and output previews are
truncated. Use `cloud.download` and `code_export` for complete deliverables,
then inspect or present them with the normal chat file tools.

## Isolation and interruptions

Each agent run has fresh local memory and captures downloads. It cannot read
the user’s browser storage. Scripts receive selected chat files through
`inputPaths`. Shared storage, database writes, and capabilities affect real
resources, even in agent runs. Read the corresponding reference before using them.

The server owns one isolated host per active conversation. Calls and ordered
approval decisions are durable: reconnecting continues the same call without
repeating effects. A lost host produces an explicit failure, never an automatic
rerun. Inspect saved data before deliberately starting a replacement run.
The host retains temporary runs while the conversation is active and for two
idle minutes after it finishes. Saved source and exported files remain durable.
The server admits eight hosts; a full host pool returns an availability error.
A server-run call that does not complete (rejected arguments, a timeout, an
unavailable run, a lost host) is a tool error with its reason and next step.
A `code_run` or `code_action`
whose code fails completes the call: its snapshot has `status: "error"` and
`error`. A failed `code_open` returns `{failed: true, error}` as its result.

The deadlines protect different boundaries:

- Startup: 15 seconds until a script returns or reports progress. Input reads,
  database and shared-storage requests, AI, PDF and capability calls pause it.
- The agent host has a 20-second readiness guard, also paused during input, database and shared-storage
  requests and capability waits. It must not expire just because input downloads
  exceed 15 seconds.
- A tool call has a 45-second outer budget, including compilation and file
  transfer. Capability approval waits pause this budget. Hanging input transfers
  are therefore still bounded and stopped; inspect the input/network error.
- The script context’s `progress` renews the responsive-work watchdog. Check
  its `signal`, yield between batches, and use scheduled actions for durable work.

Runtime stack positions refer to the compiled bundle, not original source
lines. Use the message and source to locate the issue; compilation diagnostics
already identify original files/positions. `outputTruncated` marks incomplete
snapshot output; do not parse or report a shortened result as complete.

If copying output had an uncertain outcome, inspect the returned or
deterministic chat path before requesting another copy. Never report an
unexecuted or incomplete test as successful.

A run is separate from the user’s open app. Saving code does not replace an
app that is already running. Users can restart after the new-version notice
appears; never claim their open app has updated solely because you saved it.
