# Runtime and input files

Read [cloud contract](cloud.md) first. A script runs in an isolated, terminable
worker with one frozen global `cloud`, no DOM, and no native network access. It
has no interface; interfaces are [HTML apps](apps.md). Imports may reference only
the resource’s own JavaScript, TypeScript, JSON, CSV, TSV, or text source files.

A script or app action default-exports a function:

```js
export default async (input, { files, signal, progress }) => {
  const result = [];
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    result.push(...await cloud.sheet.parseCsv(await file.file()));
    progress(index + 1, files.length, file.path);
  }
  await cloud.download("result.csv", await cloud.sheet.toCsv(result));
  return { rows: result.length };
};
```

`files` contains only the chat files selected through `code_run.inputPaths`:
`{path, size, type, file(): Promise<File>}`. Actions receive an empty array.
Files load on demand. `cloud.files` is separate durable shared app storage.
Input and captured output budgets are 50 MiB per file, 250 MiB total, and
64 paths. Output names are plain filenames; a repeated name replaces the
captured file. Large downloads should use a Blob to avoid the JSON-message budget.

`signal` aborts when the host stops the run. `progress(completed,total?,label?)`
reports bounded progress and renews the 15-second responsive-work watchdog.
Split long synchronous loops into batches, yield to the event loop, and check
the signal. Progress is available only while the entry function runs and does not roll back completed writes. For durable unattended
work use a scheduled action; the task must grant its capabilities, HTTP targets,
and database operations. Flat `cloud.db` operations `list`, `get`, `insert`, `update`, and `delete` match grants `rows.list`, `rows.get`, `rows.insert`, `rows.update`, and `rows.delete`; `query` matches `query`.
Runtime calls need no `connect` grant; `code_database` `tables.create` provisions the database under its `tables.create` grant.
Scheduled hosts use the same library and permissions.

Return JSON or nothing; do not return functions or class instances.
Logs appear in diagnostics. A script download is captured for `code_export`;
an interactive app download is handed to the viewer.

Use `crypto.randomUUID()` for IDs. `cloud.locale`, `cloud.timeZone`, and
`cloud.user` come from the trusted host. `cloud.user` is null for anonymous
public-share visitors; personal KV and database writes are denied there.

CSV reads detect UTF-8 then Windows-1252 and convert numeric columns in their
source convention. Ambiguous numeric columns use unambiguous number columns in the same file, then the export convention: dot decimals with a comma delimiter, otherwise the locale’s decimal mark. Columns containing unsafe integers stay text. Duplicate or blank header collisions get unique suffixes; malformed CSV and rows beyond the header fail with `invalid` and a line number.
Codes with leading zeros and dates remain text. Use
`numbers:false` to keep all values as text. `cloud.sheet.toCsv` is asynchronous:
await it before passing the result to `cloud.download`.
