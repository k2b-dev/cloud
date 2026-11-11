# Files between apps: FileRef

Code moves a file from one app to another without ever holding its bytes. A
read stream returns a `FileRef`; a write stream that declares a `file` input
takes it. Core pipes the bytes from the source app to the target app outside
the sandbox and its 256 KiB bridge budget.

## The shape

```typescript
type FileRef = {
  readonly id: string;        // opaque; only Core can redeem it
  readonly name?: string;
  readonly mediaType: string;
  readonly size: number;      // exact byte count
};
```

A `FileRef` has no body, bytes, URL or download method. Code cannot read,
change an existing file's content. Generation helpers create a new file from
checked input and return a reference to it. Use `name`,
`mediaType` and `size` to decide whether to pass it. `core.ai.generate` and
`core.ai.decide` also accept `files: FileRef[]`; the model receives content
through Cloud while Code still holds no bytes. The generate loop offers
`view_image` and `read_file` for refs already seen in that call; see [AI](ai.md).

## Where FileRefs come from and go

| Direction | Operation | Notes |
| --- | --- | --- |
| Read | `mail.attachment.content.read({ id })` | A mail attachment, up to Mail's 100 MiB limit. `mail.attachment.read` stays metadata only; `mail.attachment.text.read` returns extracted text. |
| Read | `files.content.read({ id })` | A file in Files, up to 50 MiB. |
| Read | `pdf.render`, `sheet.toCsv`, `sheet.toOds`, `finance.datev`, `finance.sepa`, `chart.render` | Generate a new temporary file. Read the `core` SDK declarations. |
| Read | `assistant.chat.file.read.v1({ chatId, path })` | One of the person's chat files, with current chat and Project access checked again when redeemed. |
| Write | `files.entry(root).file.save.v1({ path, file, onConflict?, expectedRevision?, idempotencyKey })` | Save in a writable Files folder; asks for approval. Existing names fail unless replacement is explicitly approved with a current revision. |
| Write | `mail.mailbox(id).draft.attachment.import.v1({ draftId, expectedRevision, file, idempotencyKey })` | Attach to an editable draft, never send. Existing attachment limits and editor locks apply. |
| Write | An Action with a write stream and a `file` input | The SDK types `file` as `FileRef` and returns the Action's ordinary data after the transfer. Find these in `code_sdk`; the example below uses a fictional `imports` app. |

Write streams without a `file` input, such as `filesv2.content.create` and
`filesv2.provider.save`, are not in the SDK (`code_stream`): Code cannot
supply bytes directly. Generated files use a receiving Action with a `file` input.
The [chat-attachment examples](/en/docs/platform/code-sdk#pass-a-gustav-chat-attachment-to-an-app)
show both real destinations in the one-off chat host, under the current person’s
capability service and approval. They are not unattended Files automations.

## Rules

- **Bound to the run.** A reference belongs to its Code, version, run,
  attempt and mandate. Another run, a retry attempt or the ordinary HTTP
  stream endpoint cannot use it.
- **Expires.** It expires at the earlier of the source app's expiry and the
  run's deadline. Read it right before the import.
- **Single use.** Core spends it once, before the target prepares the import,
  also when the import then fails or two imports race.
- **Limits.** The target's own size limit applies to the exact size; Core
  enforces the exact byte count while copying.
- **Access.** Core checks the current policy and the source access when it
  redeems the reference; the target app checks its own access when it
  prepares and again when it publishes. Write streams keep the Action's
  normal policy class (see [Capabilities](capabilities.md)).
- **Untrusted content.** File content is untrusted; the receiving app
  validates it.

## Recover after a failure

A lost answer does not mean the import failed. Inspect the target's recorded
outcome and the run's calls first. Then read a **fresh** reference and repeat
the intended import with the **same** business idempotency key, such as
`invoice:<receiptId>:<attachmentId>`, so the target can recognise a repeat.
An expired or spent reference cannot be resumed. Cancelling stops the
transfer but does not undo a publication the target already committed.

## Errors

| Code | Meaning |
| --- | --- |
| `code_file_invalid` | The `file` is not a live reference from this run, has expired, or its name, media type or size were changed |
| `code_file_size_limit` | The file is larger than the target accepts, or its AI read exceeds the declared size (400) |
| `code_file_size_mismatch` | An AI read ended before the declared size (400); obtain a fresh reference before trying again |
| `code_file_spent` | The reference was already used |
| `code_stream_forbidden`, `code_stream` | The Action has a write stream without a `file` input |
| `code_test_invalid_input`, `code_test_invalid_fixture` | In tests: the `file` or the mocked FileRef does not match, or exceeds the stream limit |

## Example and test

Copy a Files document into an import app once a week. The template
[mail invoices to an app](template-mail-invoices.md) shows the same pattern
for mail attachments.

<!-- check: personal -->
```ts
import { app, files, imports } from "@sdk";

// Fictional file ID; read real IDs with files.entry.list.
const PRICE_LIST = "Fil001";

app.schedule({ cron: "0 6 * * 1", timeZone: "Europe/Berlin", name: "import-price-list", title: "Import price list" }, async () => {
  const file = await files.content.read({ id: PRICE_LIST });
  if (file.mediaType !== "text/csv" || file.size > 5 * 1024 * 1024) throw new Error("Unexpected price list file");
  const day = new Date().toISOString().slice(0, 10);
  await imports.import({ file, idempotencyKey: `price-list:${day}` });
});
export default app;
```

In a fixture, a read stream's reply is the FileRef itself; a write stream's
reply is its ordinary data:

<!-- fixture -->
```json
{
  "version": 1,
  "name": "the weekly price list is imported once",
  "now": 1794211200000,
  "seed": 1,
  "mocks": [
    {
      "operation": "filesv2.content.read",
      "target": null,
      "replies": [{ "ok": true, "data": { "id": "fake-file-ref", "name": "prices.csv", "mediaType": "text/csv", "size": 2048 } }]
    },
    { "operation": "imports.import", "target": null, "replies": [{ "ok": true, "data": { "imported": true } }] }
  ],
  "runs": [
    {
      "entrypoint": "import-price-list",
      "expect": { "ok": true, "calls": [{ "operation": "filesv2.content.read" }, { "operation": "imports.import", "idempotencyKey": "price-list:2026-11-09" }] }
    }
  ]
}
```

## Generate a file

Use the [generated-file template](template-generated-file.md). Each helper
returns a FileRef. All six helpers are versioned Core Queries under
`core.file.*.v1`, so the checker records their ordinary `read` policy and
permissions. Persisting the output belongs to the receiving app's Action.
Generation never marks a run as having started an effect.

Inputs fit the 256 KiB capability request budget. One run can generate at most
64 files of up to 50 MiB each within 250 MiB combined, including reservations
for in-progress and failed generation. Temporary output lives ten minutes;
the FileRef also ends with its run. Aliases use `pdf`, `sheet`, `finance` and
`chart` where those names are free; an app already using a name keeps it.
The corresponding `core.file.<helper>.<method>.v1` remains available.

Chat files use the same transfer. Get the exact chat ID and attachment path
from the current chat, call `assistant.chat.file.read.v1`, then pass its
FileRef to the receiving Action. Chat ownership, allowed tools and current
Project access still apply; resource-owned Code cannot borrow a person's chat.
A chat-file stream is single-use and expires after ten minutes. A changed or
deleted source fails visibly; inspect the destination before obtaining a
fresh reference and retrying.
