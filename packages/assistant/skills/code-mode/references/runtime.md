# Runtime and files

## Source

```json
{
  "entry": "main.ts",
  "files": [
    { "path": "main.ts", "content": "export default () => ({ answer: 42 });" }
  ]
}
```

The entry is JavaScript or TypeScript. Source paths are relative and unique.
Imports must resolve to source files within the artifact; bare package imports
and external imports are rejected. There is no generated HTML or DOM access.
Code runs in a terminable worker behind an isolated bridge. The host renders
validated UI descriptions.

The entry's JSON-compatible return value becomes the run output. Keep returned
data concise; write larger deliverables as files. `console.log`, `console.info`,
`console.warn`, and `console.error` appear in the run's diagnostics.

## Files

All file operations except `files.path` return promises. For one-off scripts and App test runs, pass the
selected current chat paths to `code_run` as `inputPaths`. For app test runs,
these are explicit picker fixtures only; `files.list/read` cannot see them.
User apps use their own picker and never receive chat inputs.

| Call | Result |
| --- | --- |
| `files.list()` | Supplied input metadata: `name`, `size`, `type` |
| `files.read(name)` | A supplied input as a `File`; use `.text()` or `.arrayBuffer()` |
| `files.open({ accept })` | A selected `File`, or `null` |
| `files.openMultiple({ accept })` | Selected `File[]` |
| `files.openFolder()` | Selected `File[]` |
| `files.path(file)` | Relative path retained across the worker bridge (synchronous) |
| `files.save(blobOrText, name)` | `null` after saving an output file; no path |

`list` and `read` see only files supplied to this run, not arbitrary files in the
chat or the user's device. A visible run's `open` methods ask the user to pick
files. In a test run they use supplied inputs without opening a native picker.
A visible run's `save` downloads directly. A test run captures the output for
inspection without downloading it to the user's device.

Selected chat inputs and captured test outputs follow the existing chat-file
budgets: 50 MiB per file, 250 MiB total, and at most 64 selected/captured files.
Script inputs are fetched only when read, not all before execution. Local user
folder selection has none of these capture limits. User downloads are released after saving, not accumulated in test capture. Output
names are plain file names. Saving the same output name replaces that captured
output. For exports over the 16 MiB JSON-message budget, pass a `Blob` rather
than a raw string: `await files.save(new Blob([csv]), "results.csv")`. Do not
put directory separators in output names.

## PDF and office documents

For local PDF and XLSX processing, read [Documents](documents.md). These APIs
parse original files in the worker without upload. Other office formats may
need the normal chat extraction workflow only when uploading is acceptable.

## CSV

- `await sheet.fromCsv(fileOrText, { delimiter?, encoding? })` returns objects keyed by the
  header row, with string values; the first returned object is already a data record (do not drop it). Blank lines are skipped and parse errors throw. File bytes default
  to strict UTF-8: invalid bytes fail instead of silently corrupting names. For
  older Excel exports use `{ encoding: "windows-1252" }`; verify representative
  names and headings. String inputs are already decoded. A valid single-column
  CSV needs no delimiter override.
- `sheet.toCsv(rows, { delimiter?, bom? })` returns CSV text. Defaults: semicolon,
  UTF-8 BOM, CRLF, and escaped spreadsheet formulas.

## IDs

Use `ids.ulid()` for stable item identifiers. It returns a random, sortable ULID
and works in the isolated worker. Do not use `crypto.randomUUID()`, which is not
available in this execution context.

## External HTTP

Use `http.fetch` with server-resolved `secret()` header references. See
[HTTP and personal secrets](http.md) for consent, scopes, limits, and recovery.
Native worker networking remains blocked.

## Persistence

Read [Storage](storage.md) only when the task needs durable data.
