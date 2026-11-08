# Runtime and input files

Read [cloud contract](cloud.md) first. A script runs in an isolated, terminable
workerd isolate on the Code runner with one frozen global `cloud`, no DOM, and
no native network access. Managed `code_run` never starts Chromium. It
has no HTML interface. Pass inline JavaScript/TypeScript; `@sdk` is generated
from the current capability catalog. Saved Studio modules and contexts are
unavailable. For lasting Code load `code-authoring`.

A script default-exports a function:

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
`{path, size, type, file(): Promise<File>}`. Files load on demand. Shared app `cloud.files`, `cloud.kv` and `cloud.db`
are unavailable; use chat/Project file tools or application capabilities.
Selection and captured output budgets are 50 MiB per file, 250 MiB total, and
64 paths. Runner bridge requests and responses must additionally fit 256 KiB,
including JSON envelopes and base64 file bytes. A Blob does not bypass this
runner limit. Output names are plain filenames; a repeated name replaces the
captured file. Split transfers that exceed the bridge budget.

`signal` aborts when the host stops the run. `progress(completed,total?,label?)`
reports progress but never extends the runner's fixed wall-clock budget:
`core.code.wall_clock_ms`, at most 300 seconds including queue and approval
waits. The initial silent-script watchdog remains 15 seconds after admission.
The default 200 bridge-message budget includes logs, progress, RPCs and terminal
messages; keep diagnostics compact. At most 32 host messages may be pending.

Scheduled chat routines are retired. Rebuild timed work as reviewed personal
Code using `app.schedule` with `timeZone`, then `core.ai.chat.run` for an AI turn
or `core.ai.chat.deliver` for a prepared result. Old routine grants do not transfer.
Studio RSQL `database` grants are unavailable; use application capabilities.
No replacement database is created. Studio HTML checks, actions, presentations
and standalone apps have been retired.

Return JSON or nothing; do not return functions or class instances.
Logs appear in diagnostics. A script download is captured for `code_export`;
present its exported chat path to the person.

Use `crypto.randomUUID()` for IDs. `cloud.locale`, `cloud.timeZone`, and
`cloud.user` come from the trusted host. The runtime receives the signed-in person; it does not select a Studio app.

CSV reads detect UTF-8 then Windows-1252 and convert numeric columns in their
source convention. Ambiguous numeric columns use unambiguous number columns in the same file, then the export convention: dot decimals with a comma delimiter, otherwise the locale’s decimal mark. Columns containing unsafe integers stay text. Duplicate or blank header collisions get unique suffixes; malformed CSV and rows beyond the header fail with `invalid` and a line number.
Codes with leading zeros and dates remain text. Use
`numbers:false` to keep all values as text. `cloud.sheet.toCsv` is asynchronous:
await it before passing the result to `cloud.download`.
