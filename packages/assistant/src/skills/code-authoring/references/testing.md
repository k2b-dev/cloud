# Tests and simulation

Tests run the checked bundle in the same sandbox as production, with a fake
bridge. Every call needs a fictional reply; a missing reply fails the test and
never reaches a real app. Nothing is sent, saved or charged.

- `code_test({codeId, files, entry, tests})` runs every fixture in `tests`
  (paths `test/NAME.json`). Pass the same `tests` to `code_submit`; Core runs
  them again and shows the result to the reviewer.
- `code_simulate({codeId, files, entry, fixture})` runs one fixture with
  exactly one run, for example to explore a branch.
- On the mailbox's Code page, **Preview without effects** runs the active
  version for one real message; see [Events](events.md).

## The fixture format

```json
{
  "version": 1,
  "name": "short description of the case",
  "now": 1794211200000,
  "seed": 42,
  "mocks": [],
  "runs": [{ "entrypoint": "weekly-review", "expect": { "ok": true } }]
}
```

- `now` is Unix milliseconds; `Date.now()` and `new Date()` return it, also
  while the module loads. A run may set its own `now`. `Math.random()` uses
  `seed`. Cron does not tick: a run names the entrypoint to start.
- Entrypoints are schedule names (`weekly-review`, or `schedule:0` without a
  name) and `event:<type>@<version>` for events, such as
  `event:mail.message.received@1`. An event run takes the envelope as `input`.
- A mock names `operation` and the exact `target` (`null` for app-wide
  operations) and lists `replies` in order: `{ "ok": true, "data": … }` or
  `{ "ok": false, "error": "not_ready" }`. Optional `input` or `refs` make a
  mock more specific; the most specific one wins, a tie fails with
  `code_test_ambiguous_mock`. Used-up replies fail with `code_test_mock_exhausted`.
- Inputs and reply data must match the operation's schemas, otherwise the
  test fails with `code_test_invalid_input` or `code_test_invalid_fixture`.
- `expect` checks `ok`, `error`, the returned `value` (schedules return
  `null`) and `calls`: the exact number of calls and the given fields of each,
  such as `operation`, `idempotencyKey`, `replayed` and `result`.
- Runs in one fixture share idempotency receipts: the same key and input
  returns the first reply with `replayed: true`; the same key with other input
  fails with `idempotency_conflict`. Fixtures share nothing.

Use only fictional values: no real names, addresses, IDs or secrets.

## Test a schedule

<!-- check: personal -->
```ts
import { app, chat } from "@sdk";

app.schedule({ cron: "0 16 * * 5", timeZone: "Europe/Berlin", name: "weekend-note" }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  await chat.app().message.post({ conversation: "Cnv001", body: "Have a good weekend!", idempotencyKey: `weekend:${day}` });
}, { name: "weekend-note", title: "Weekend note" });
export default app;
```

`test/weekend-note.json`: the second run on the same day repeats the key and
replays the first result; a run a week later posts again.

<!-- fixture -->
```json
{
  "version": 1,
  "name": "weekend note posts once per Friday",
  "now": 1794582000000,
  "seed": 1,
  "mocks": [
    {
      "operation": "chat.message.post",
      "target": null,
      "replies": [
        { "ok": true, "data": { "id": "Msg0000001", "conversation": "Cnv001", "createdAt": "2026-11-13T15:00:00Z" } },
        { "ok": true, "data": { "id": "Msg0000002", "conversation": "Cnv001", "createdAt": "2026-11-20T15:00:00Z" } }
      ]
    }
  ],
  "runs": [
    { "entrypoint": "weekend-note", "expect": { "ok": true, "calls": [{ "operation": "chat.message.post", "idempotencyKey": "weekend:2026-11-13", "replayed": false }] } },
    { "entrypoint": "weekend-note", "expect": { "ok": true, "calls": [{ "idempotencyKey": "weekend:2026-11-13", "replayed": true }] } },
    { "entrypoint": "weekend-note", "now": 1795186800000, "expect": { "ok": true, "calls": [{ "idempotencyKey": "weekend:2026-11-20", "replayed": false }] } }
  ]
}
```

## Test an event handler

<!-- check: resource mail.mailbox -->
```ts
import { app, chat, mail } from "@sdk";

app.on("mail.message.received", async event => {
  const message = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete") throw new Error("Message content is not ready yet");
  if (!/urgent/i.test(message.subject)) return;
  await chat.app().message.post({
    conversation: "Cnv001",
    body: `Urgent mail from ${message.from[0]?.address ?? "an unknown sender"}: ${message.subject}`,
    idempotencyKey: `urgent:${message.id}`,
  });
});
export default app;
```

The envelope's `place` is this Code's mailbox; use its ID. The
`mail.message.read` reply is a complete message, because replies must
match the schema:

<!-- fixture -->
```json
{
  "version": 1,
  "name": "urgent mail is announced, other mail is not",
  "now": 1794211200000,
  "seed": 1,
  "mocks": [
    {
      "operation": "mail.message.read",
      "target": null,
      "input": { "id": "Msg001" },
      "replies": [{ "ok": true, "data": {
        "id": "Msg001", "mailboxId": "Mbx001", "conversationId": "Cnv101", "subject": "Urgent: server down", "subjectTruncated": false,
        "messageId": "<fictional-1@example.com>", "internalDate": "2026-11-09T07:59:00Z", "sentAt": "2026-11-09T07:58:00Z",
        "from": [{ "name": "Alex Example", "address": "alex@example.com" }], "to": [{ "name": null, "address": "team@example.com" }],
        "addressesTruncated": false, "flags": [], "flagsTruncated": false, "keywords": [], "keywordsTruncated": false,
        "hydrationStatus": "complete", "remoteAvailable": true, "contentType": "text/plain", "sizeBytes": 512,
        "replyTo": [], "cc": [], "detailAddressesTruncated": false, "headers": [], "headersTruncated": false,
        "text": "The server is down since 07:50.", "bodyTruncated": false, "attachments": [], "attachmentsTruncated": false, "delivery": null
      } }]
    },
    {
      "operation": "mail.message.read",
      "target": null,
      "input": { "id": "Msg002" },
      "replies": [{ "ok": true, "data": {
        "id": "Msg002", "mailboxId": "Mbx001", "conversationId": "Cnv102", "subject": "Lunch on Friday?", "subjectTruncated": false,
        "messageId": "<fictional-2@example.com>", "internalDate": "2026-11-09T08:00:00Z", "sentAt": null,
        "from": [{ "name": null, "address": "sam@example.com" }], "to": [], "addressesTruncated": false,
        "flags": [], "flagsTruncated": false, "keywords": [], "keywordsTruncated": false,
        "hydrationStatus": "complete", "remoteAvailable": true, "contentType": "text/plain", "sizeBytes": 200,
        "replyTo": [], "cc": [], "detailAddressesTruncated": false, "headers": [], "headersTruncated": false,
        "text": "Shall we?", "bodyTruncated": false, "attachments": [], "attachmentsTruncated": false, "delivery": null
      } }]
    },
    {
      "operation": "chat.message.post",
      "target": null,
      "replies": [{ "ok": true, "data": { "id": "Post000001", "conversation": "Cnv001", "createdAt": "2026-11-09T08:00:01Z" } }]
    }
  ],
  "runs": [
    {
      "entrypoint": "event:mail.message.received@1",
      "input": {
        "id": "00000000-0000-4000-8000-000000000001", "type": "mail.message.received", "version": 1, "source": "mail",
        "time": "2026-11-09T08:00:00Z", "subject": { "type": "mail.message", "id": "Msg001" },
        "place": { "type": "mail.mailbox", "id": "Mbx001" }, "data": { "receiptId": "00000000-0000-4000-8000-000000000101" }
      },
      "expect": { "ok": true, "calls": [{ "operation": "mail.message.read" }, { "operation": "chat.message.post", "idempotencyKey": "urgent:Msg001" }] }
    },
    {
      "entrypoint": "event:mail.message.received@1",
      "input": {
        "id": "00000000-0000-4000-8000-000000000002", "type": "mail.message.received", "version": 1, "source": "mail",
        "time": "2026-11-09T08:00:00Z", "subject": { "type": "mail.message", "id": "Msg002" },
        "place": { "type": "mail.mailbox", "id": "Mbx001" }, "data": { "receiptId": "00000000-0000-4000-8000-000000000102" }
      },
      "expect": { "ok": true, "calls": [{ "operation": "mail.message.read" }] }
    }
  ]
}
```

## Test AI and refusals

AI operations need explicit replies too; there is no live model in a test.
A `core.ai.generate` reply is `{ "output": …, "model": { "id": … }, "usage": null }`.
Simulate a refusal with `{ "ok": false, "error": "code_ai_daily_budget_limit" }`
and check that the Code fails or recovers as intended.

<!-- check: personal -->
```ts
import { app, core } from "@sdk";

app.schedule({ cron: "0 7 * * 1", timeZone: "Europe/Berlin", name: "weekly-quote" }, async () => {
  const quote = await core.app().ai.generate({
    task: "quote",
    prompt: "Write one short encouraging sentence for the start of the week.",
    input: {},
    output: { type: "text", maxChars: 200 },
  });
  if (typeof quote.output !== "string") return;
  // Fictional chat ID of the owner's chat.
  await core.ai.chat("Chat23").ai.chat.deliver({ text: quote.output, idempotencyKey: "weekly-quote" });
}, { name: "weekly-quote", title: "Weekly quote" });
export default app;
```

<!-- fixture -->
```json
{
  "version": 1,
  "name": "the quote is delivered; a spent AI budget fails the run",
  "now": 1794211200000,
  "seed": 1,
  "mocks": [
    {
      "operation": "core.ai.generate",
      "target": null,
      "replies": [
        { "ok": true, "data": { "output": "A fresh week, a fresh start.", "model": { "id": "fictional-model" }, "usage": null } },
        { "ok": false, "error": "code_ai_daily_budget_limit" }
      ]
    },
    {
      "operation": "core.ai.chat.deliver",
      "target": { "type": "core.ai.chat", "id": "Chat23" },
      "replies": [{ "ok": true, "data": { "id": "Msg7Ab", "status": "delivered", "targetChatId": "Chat23" } }]
    }
  ],
  "runs": [
    { "entrypoint": "weekly-quote", "expect": { "ok": true, "calls": [{ "operation": "core.ai.generate" }, { "operation": "core.ai.chat.deliver", "replayed": false }] } },
    { "entrypoint": "weekly-quote", "expect": { "ok": false, "calls": [{ "operation": "core.ai.generate", "result": { "ok": false, "error": "code_ai_daily_budget_limit" } }] } }
  ]
}
```

## What a passing test proves

A test proves the Code's logic against the replies you wrote, nothing more.
Production still checks the policy, the version approval and the account's
current access on every call. Write at least one case per branch that leads
to an Action, and one for a refused call that the Code should survive or
report. When a reply shape is unclear, read the operation's result type in
`sdk.d.ts` from `code_sdk`.
