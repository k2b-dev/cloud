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

All file operations return promises.

| Call | Result |
| --- | --- |
| `files.list()` | Supplied input metadata: `name`, `size`, `type` |
| `files.read(name)` | A supplied input as a `File`; use `.text()` or `.arrayBuffer()` |
| `files.open({ accept })` | A selected `File`, or `null` |
| `files.openMultiple({ accept })` | Selected `File[]` |
| `files.openFolder()` | Selected `File[]` |
| `files.save(blobOrText, name)` | Produces an output file; await completion |

`list` and `read` see only files supplied to this run, not arbitrary files in the
chat or the user's device. A visible run's `open` methods ask the user to pick
files. In a test run they use supplied inputs without opening a native picker.
A visible run's `save` downloads directly. A test run captures the output for
inspection without downloading it to the user's device.

Inputs and outputs each have a 16 MiB total budget and at most 64 files. Output
names are plain file names. Saving the same output name replaces that captured
output. Do not put directory separators in output names.

## CSV

- `await sheet.fromCsv(fileOrText, { delimiter? })` returns objects keyed by the
  header row. Blank lines are skipped and parse errors throw.
- `sheet.toCsv(rows, { delimiter?, bom? })` returns CSV text. Defaults: semicolon,
  UTF-8 BOM, CRLF, and escaped spreadsheet formulas.

## IDs

Use `ids.ulid()` for stable item identifiers. It returns a random, sortable ULID
and works in the isolated worker. Do not use `crypto.randomUUID()`, which is not
available in this execution context.

## Local persistence

- `await store.get(key)` returns JSON data or `null`.
- `await store.set(key, value)` persists JSON data.
- `await store.delete(key)` removes one value.
- `await store.keys()` lists keys.
- `await opfs.read(path)` reads a local file or returns `null`.
- `await opfs.write(path, blobOrText)` writes a local file.
- `await opfs.delete(path)` removes one file.
- `await opfs.list()` lists file paths.

Paths are relative and cannot contain empty segments, `.` or `..`. Local values
and files are scoped to the artifact and user. Test runs use fresh in-memory
storage and cannot modify a visible run's persistent data. Always await writes.
