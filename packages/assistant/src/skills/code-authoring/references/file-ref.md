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
change or create file content; it can only pass a reference on. Use `name`,
`mediaType` and `size` to decide whether to pass it.

## Where FileRefs come from and go

| Direction | Operation | Notes |
| --- | --- | --- |
| Read | `mail.attachment.content.read({ id })` | A mail attachment, up to Mail's 100 MiB limit. `mail.attachment.read` stays metadata only; `mail.attachment.read-content` returns extracted text. |
| Read | `filesv2.content.read({ id })` | A file in Files, up to 50 MiB. |
| Write | An Action with a write stream and a `file` input | The SDK types `file` as `FileRef` and returns the Action's ordinary data after the transfer. Find these in `code_sdk`; the example below uses a fictional `imports` app. |

Write streams without a `file` input, such as `filesv2.content.create` and
`filesv2.provider.save`, are not in the SDK (`code_stream`): Code cannot
upload content of its own.

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
| `code_file_size_limit` | The file is larger than the target accepts |
| `code_file_spent` | The reference was already used |
| `code_stream_forbidden`, `code_stream` | The Action has a write stream without a `file` input |
| `code_test_invalid_input`, `code_test_invalid_fixture` | In tests: the `file` or the mocked FileRef does not match, or exceeds the stream limit |

## Example and test

Copy a Files document into an import app once a week. The template
[mail invoices to an app](template-mail-invoices.md) shows the same pattern
for mail attachments.

<!-- check: personal -->
```ts
import { app, filesv2, imports } from "@sdk";

// Fictional file ID; read real IDs with filesv2.entry.list.
const PRICE_LIST = "Fil001";

app.schedule({ cron: "0 6 * * 1", timeZone: "Europe/Berlin", name: "import-price-list" }, async () => {
  const file = await filesv2.app().content.read({ id: PRICE_LIST });
  if (file.mediaType !== "text/csv" || file.size > 5 * 1024 * 1024) throw new Error("Unexpected price list file");
  const day = new Date().toISOString().slice(0, 10);
  await imports.app().import({ file, idempotencyKey: `price-list:${day}` });
}, { name: "import-price-list", title: "Import price list" });
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
