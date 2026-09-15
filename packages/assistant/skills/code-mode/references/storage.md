# Store resource data

Choose local storage for data belonging to this user and browser. Choose shared
storage for data that users of the saved app or script need together. One-off
scripts can explicitly use an existing resource with `code_run({code, resourceId})`
and Manage access. Save a script only when it needs its own durable shared data.

All operations are asynchronous. Await writes before reading their result or
reporting success.

| Data | Local | Shared |
| --- | --- | --- |
| Read JSON | `kv.local.get(key)` | `kv.shared.get(key)` |
| Write JSON | `kv.local.set(key, value)` | `kv.shared.set(key, value)` |
| Delete JSON | `kv.local.delete(key)` | `kv.shared.delete(key)` |
| List keys | `kv.local.keys()` | `kv.shared.keys()` |
| Read file | `files.local.read(path)` | `files.shared.read(path)` |
| Write text or Blob | `files.local.write(path, value)` | `files.shared.write(path, value)` |
| Delete file | `files.local.delete(path)` | `files.shared.delete(path)` |
| List files | `files.local.list()` | `files.shared.list()` |

Missing values or files return `null`. File reads return a Blob; use `.text()`
or `.arrayBuffer()`. Paths are relative, without empty, `.` or `..` segments.
Use JSON-compatible values for key/value storage.

Shared storage belongs to the resource, across edits, publications, and
restores. Forks start with empty storage. Users allowed to run a published
resource can use its shared storage; draft access requires Manage. Publishing
source does not publish a separate copy of its data.

Agent test runs use temporary local storage. Shared operations affect the real
resource even in a test run: use appropriate test records and never assume that
rerunning code undoes prior writes. Shared files default to 250 MiB per resource and 50 MiB per file, with no
file count limit. Operators can configure both byte limits. Shared KV has its
own 16 MiB and 1,000-entry budget.

Chat inputs are separate from persistent resource files. A script gets only
selected current-chat inputs through `inputPaths`. A GUI app requests uploads
through its own file-picker controls and decides whether to retain them.

## Listing many keys

`keys({after?, limit?})` and `list({after?, limit?})` return a sorted page of keys,
with a default and maximum limit of 1,000. For another page, pass its last key as
`after`; stop when a page is shorter than the limit. Deleting or inserting keys
while listing can change subsequent pages. Local listings no longer fail merely
because the resource contains over 1,000 files. Metadata collection itself is
bounded to 16 MiB; split enormous local stores into resources when necessary.

Local item writes have a 16 MiB per-item budget and use the browser's storage
quota. Shared file transfers use binary HTTP; do not Base64-encode files.
Neither storage quota
limits the number or total size of documents selected for local processing.

Studio's Advanced → Local data lets each user inspect, download or delete their
own files/KV in the current browser profile. It stops this page's runs before
deletion; other tabs may create data again. Advanced → Shared data requires
resource Manage access and affects everyone. These administrative controls do
not change normal app runtime data permissions. A CLI process cannot inspect or
clear the user's existing browser profile; guide them to Local data instead.


Operators configure `assistant.storage_file_mib` and
`assistant.storage_total_mib` in Cloud settings, or use
`cld assistant studio-admin storage-settings` and `storage-configure` with
`{"fileMiB":50,"totalMiB":250}` as JSON input. The single-transfer ceiling is
64 MiB; the total setting allows up to 1 TiB per resource. Both values must
be positive integers in MiB. Effective writes must fit both limits.
Lower limits never delete files. Reads, deletes, and replacements that do not
increase stored bytes remain possible (within the transfer ceiling).

Use `cld assistant code file-upload ID --file invoice.pdf --key invoices/invoice.pdf`
and `file-download ID --key invoices/invoice.pdf --out invoice.pdf` for binary
files. Existing keys are replaced; choose a new key when retaining both files.
`code storage` and `storage-manage` retain JSON for KV and file list/delete only.
Storage limits do not increase chat, parsing, runtime-message or output budgets.
