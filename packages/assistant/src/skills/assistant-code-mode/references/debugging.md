# Run and debug

Load the required tools with `load_tools`. `code_run`, `code_inspect`,
`code_stop` and `code_export` use the Code runner, independently of the user's
tab. `code_secret` opens trusted secret entry in the web UI; CLI and unattended
turns can use existing secrets but cannot open entry. Use exact tool names
without `assistant.`; these tools are not application capabilities.

| Tool | Input | Result |
| --- | --- | --- |
| `code_run` | Inline `code`, optional `inputPaths` | Returns `runId` and a snapshot |
| `code_inspect` | `runId`, optional `waitMs` | Status, progress, logs, errors, output, captured files and view references |
| `code_stop` | `runId` | Stops and releases a run |
| `code_export` | `runId`, `name` | Copies a captured output file into the chat; returns its path and version |

Saved Studio IDs, `resourceId`, `version`, HTML checks/presentation, Studio
storage and Studio RSQL are unavailable in chat. For lasting Code and pages
load `code-authoring`.

## Verify and deliver

Inspect representative and invalid inputs, totals and output files. The
snapshot includes `views`: paths and summaries without computed values. Use
`present({path})` for every view the person should see. If work is still
running, inspect it with `code_inspect({runId,waitMs:30000})` rather than
starting another run.

Logs and output previews are bounded. `outputTruncated` marks incomplete
output; never parse or report it as complete. Use `cloud.download` and
`code_export` for complete deliverables. If copying has an uncertain outcome,
inspect the returned or deterministic chat path before requesting another copy.

A script failure completes its tool call with `status: "error"` and `error`
in the snapshot. Rejected arguments, an unavailable run or a lost host produce
a tool error. Report that state and its recovery step; never claim unexecuted
or incomplete work succeeded. Runtime stack positions refer to the compiled
bundle; compilation diagnostics identify original source files and positions.

## Isolation and interruptions

Each run starts with fresh local variables. Scripts receive only selected
chat files through `inputPaths`; another run's files and variables are not
implicitly shared. External HTTP and capability actions have real effects.
Cancellation does not undo them.

Calls and approval decisions are durable. Reconnecting follows the same call
without repeating effects. A lost Assistant host or runner attempt fails
explicitly and is never automatically replayed. Inspect saved effects before
deliberately starting a replacement run.

The runner's elapsed deadline includes queueing and approval waits; progress
does not extend it. Read [Runtime and files](runtime.md) and the canonical
[one-off chat limits](/en/docs/platform/code-runs#one-off-chat-jobs) before
choosing input sizes or planning a long job. Check the script context's
`signal` and yield between batches. Use lasting Code schedules for durable
scheduled work.
