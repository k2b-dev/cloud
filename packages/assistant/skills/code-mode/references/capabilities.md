# Combine Cloud capabilities

Discover the actual capability through the normal capability search and load its
input contract before writing code. Try a read query directly when that helps
understand its result. Never guess a capability name, input field, or result path.

For comparisons or analysis, a one-off script can call several discovered read
capabilities, normalize their results, and return a compact comparison. Inspect
pagination, identifiers, units and date ranges before joining or totaling data.
Use a fresh short script for another question; no saved app is required. A
sample is not evidence that all records were fetched. Shared writes and actions
remain real even when the script is exploratory.

Inside a script or app, call:

```ts
const result = await capabilities.run("app.capability", { /* documented input */ });
const data = result.data;
```

The name and input must match the discovered capability. The result is the
capability result envelope, including `data` and any supplied references or
files. Inspect its documented shape before chaining it into another call.
Await dependent calls in order. Catch failures when the task has a useful
recovery; do not swallow them and report success.

The current user's Cloud permissions still apply. Read queries and actions
configured without approval run directly. Other actions request real user
approval through the chat or app host. An eligible action can offer “always
allow” for its defined scope. Existing remembered approvals are reused.
Scripts cannot approve their own requests; `code_interact` is not an approval
mechanism. Declined calls throw. Respect the decision and do not retry through
another route. A chat's allowed-tools restriction also applies to calls from
its scripts.

Failures reject the promise; the runtime removes the transport `{ok, data}`
wrapper. The returned object is the capability's own envelope (`data`, `refs`,
files when supplied), not a second transport wrapper.

Use the user's current request to decide which effects are appropriate. The
availability of a tool is not a reason to invoke unrelated actions.

When the user runs a saved resource they do not manage, every capability call
requires explicit consent, including queries and actions normally needing no
approval. The dialog identifies the resource and explains that returned data
can be stored in shared files or its database. Personal remembered approvals
do not apply, and these calls cannot create a personal always-allow rule.
Denial must leave a useful message; do not retry unchanged or bypass consent.

## Binary content

Some discovered operations return a `stream` beside `data`. This is the one
binary processing path for any app: files, invoice PDFs, audio, and imports use the same
mechanism. Never invent a download URL or put file bytes in capability JSON.

```ts
const source = await capabilities.run("example.content.read", {id: sourceId});
const file = await capabilities.streams.read(source.stream); // File
// Analyze file with the documented CSV, Excel, PDF or binary helpers.
const output = new Blob(["name,total\nAlice,42\n"], {type:"text/csv"});
const target = await capabilities.run("example.content.create", {
  path: "totals.csv", size: output.size, mediaType: output.type,
});
const receipt = await capabilities.streams.write(target.stream, output);
```

The names and fields above illustrate the flow; discover the installed app's
actual contract. Streams are tied to this run's capability calls. Preserve the
returned descriptor unchanged. Reads return a `File`; writes accept a `Blob`,
string, `ArrayBuffer` or `Uint8Array`. The payload must exactly match the approved
byte size. The runtime accepts at most 50 MiB per payload, 250 MiB of transfers
per run and 64 stream references. Do not split a larger file to bypass a limit.

After an interrupted write while the same turn is active, call
`capabilities.streams.status(target.stream)`.
A completed result is `{state:"completed", result: <capability envelope>}`;
`open` means it has not completed and `aborted` means it cannot continue.
Use `capabilities.streams.abort(target.stream)` to discard an unfinished upload.
Never blindly repeat a write or claim success from a missing response. Stream
references expire and are bound to the current conversation and foreground
turn. They stop working when that turn is canceled or ends; another turn cannot
reuse them. After a stopped turn, inspect the destination before preparing a
new write: stopping does not undo a committed file. Request a fresh read when needed. A fresh write is a new
Action and must follow the normal approval process.

Filesv2 publishes discovery/listing and cursor-based search, `content.read`,
`content.create`, folder creation, rename, move, copy, trash, and restore. Use
exact returned base IDs and entry references. Overwriting requires current
`expectedRevision`; default to creating a new output name. Follow `next` until
null when an analysis needs every entry. Trash remains recoverable; no permanent
delete capability is exposed.


For a user download from a Studio list, Filesv2 also provides an on-demand
`content.download` lease. Keep resource refs in lists and request the URL only
when selected; follow [Filesv2 and Grids downloads](files.md#list-filesv2-files-beside-grids-documents)
for expiry, permissions and error recovery.
