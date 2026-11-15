# Read and create ZIP files

Use `cloud.zip.open(file)` to list entries without decompressing them. Each
entry has `name`, `size`, `compressedSize` and `directory`. Read one file with
`await zip.read(name)` for bytes or `await zip.text(name)` for strict UTF-8.
Paths stay inside the archive; no files are written to a filesystem.

The SDK archive ceiling is 50 MiB, with at most 64 entries (directories count)
and 16 MiB expanded across all entries. Each file may expand at most 64:1.
These fixed SDK ceilings reuse the chat-file size, runtime data and path
budgets: 16 MiB is the smaller of the 50 MiB file and 16 MiB runtime data
ceilings; 64:1 permits that expanded budget from one 256 KiB bridge-sized
compressed input. Runner memory, wall-clock and bridge budgets still apply.
An output ZIP must fit the same limits. Split archives that exceed them.

Stored and deflated ZIPs work. Encrypted, multipart and ZIP64 archives,
symlinks, duplicate names, absolute paths and traversal paths are refused.
Errors use `CloudError` codes `invalid`, `limit` or `not_found`.
Read entries in sequence and check the run result before delivering files.

## Unpack a ZIP and read camt.052

Pass the selected bank-export chat path in `code_run.inputPaths`.
`cloud.finance.camt.parse` uses the already available `@k2b/stdlib/finance`
parser; only `camt.052.001.08` is supported. Amounts remain exact strings.

```js
export default async (_input, { files, signal }) => {
  if (!files[0]) throw new Error("Select a bank-export ZIP.");
  const zip = await cloud.zip.open(await files[0].file());
  const reports = [];
  for (const entry of zip.entries) {
    signal.throwIfAborted();
    if (entry.directory || !entry.name.toLowerCase().endsWith(".xml")) continue;
    const parsed = await cloud.finance.camt.parse(await zip.text(entry.name));
    if (!parsed.ok) throw new Error(`${entry.name}: ${parsed.message}`);
    reports.push({ name: entry.name, reports: parsed.data.reports.length });
  }
  return { reports };
};
```

## Return files as a ZIP

`cloud.zip.create` returns a `File` with MIME type `application/zip`.
A name defaults to `files.zip`; output names are plain filenames.

```js
export default async () => {
  const zip = await cloud.zip.create([
    { name: "summary.txt", data: "Checked the supplied reports." },
    { name: "data/rows.json", data: JSON.stringify([{ amount: "12.34", currency: "EUR" }]) },
  ], "reports.zip");
  await cloud.download(zip.name, zip);
  return { name: zip.name, bytes: zip.size };
};
```

Then use `code_export` with the returned run ID and `name: "reports.zip"`,
and `present` its returned chat path. Both selected input files (`files[0].file()`) and captured output files cross
the runner bridge. It limits each transfer to 256 KiB including base64 and the JSON envelope; ZIP does not bypass
that limit. The usable binary size is therefore below 192 KiB (about 190 KiB after
envelope overhead), for inputs as well as outputs. Larger bank exports can be
attached to chat, but cannot currently be loaded into `code_run`; split them
locally first. The 50 MiB SDK ceiling does not bypass this transport limit.
