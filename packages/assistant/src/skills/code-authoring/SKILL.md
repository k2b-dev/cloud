---
name: code-authoring
description: Build or edit lasting Cloud Code, including schedules, pages and resource-owned automations. Use for code.ts and code.tsx pages, checking permissions, fictional tests, simulation and submitting an immutable version for human activation. One-off analysis or CSV exports use assistant-code-mode and code_run.
load-tools: [code_init, code_pull, code_sdk, code_write, code_check, code_test, code_simulate, code_submit, code_diff]
---
# Build lasting Code

Load these tools through `load_tools` if they are unavailable. Keep each tool's
versioned JSON result intact; these are the same contracts as `cld code`.

1. For existing Code, `code_pull({codeId})` returns the complete project.
   For new Code, `code_init({title, owner?})` returns an initial project;
   omit owner for personal Code. Creating Code at an owner requires its admin.
2. `code_sdk({codeId})` returns the live generated `@sdk` contract. Discover
   the requested operations; use their actual handle, input and result types.
   No guessed operations or resource IDs. A Space task can omit `columnId`;
   it goes into the first open column.
3. Write `app.schedule` in `code.ts`, default-exporting `app`. Give schedules
   stable names and a short human title next to the name, for example
   `{ name: "weekly-review", title: "Weekly review" }` in the declaration options.
   Required action idempotency keys describe the intended effect
   so retries use the same key. `code_write({project,path,content})` returns
   a complete replacement project. Retain it for the next write. These drafts
   stay in the chat until submit; pull retrieves the last submitted version.
4. Send `{codeId,files,entry}` to `code_check`. Read diagnostics and permissions,
   including file/line, target, new/existing and own. Explain the consequences.
   These rows are non-binding review evidence; dynamic IDs are allowed. Target
   apps check current account rights on each call. Fix check errors before continuing.
5. Add declarative `test/NAME.json` fixtures with a fixed `now` (Unix ms),
   integer `seed`, explicit fake replies in `mocks`, and named `runs`.
   Send fixtures separately as `tests` to `code_test`; they are never real
   actions. `code_simulate` accepts one fixture with exactly one run.
6. Submit `{codeId,files,entry,baseVersionId}` using the unchanged base from
   pull/init. `code_submit` saves a checked immutable version. Use `code_diff`
   with its version ID to inspect changes. Say that the version is submitted
   and the person must review and activate it in the UI or CLI.

Never activate Code or change its access. All authoring tools require current
Code editor rights, including reads of resource-owned Code. They are for an
interactive chat, not a background task. On a version conflict, pull, reconcile
the complete comparison and recheck; never replace the base just to force a
submit. After an uncertain write, pull before trying again. A failed runner
job is a visible failure; do not claim the source passed.

## Pages

Resource-owned Code starts with `code.tsx`, a page built from SDK blocks
(`code_init` returns one). Compose blocks as TSX; never write the page as an
object. Data, such as `rows` or chart `data`, is a prop; a block's parts are its
children: `Field.*` in `Form`, `Option` in `Field.Select`, `Stat` in `Stats`,
`Column` in `Table`, `Item` in `Detail`. Charts are `Chart.Bar`, `Chart.Line`
and the other kinds with their data as props; `Chart.Empty` holds a chart's
place without data. `code_check` reports a wrong prop as a type error and a
misplaced part as `code_page_child`. Forms and buttons POST to an own route
(`app.post`), which answers with `c.page(...)` or `c.redirect(path)`.

<!-- code-page-example -->
```tsx
import { app, jsx, Page, Stats, Stat, Section, Chart, Table, Column, Form, Field, Option } from "@sdk";

const items = [{ item: "Chair", status: "In repair", count: 2 }, { item: "Lamp", status: "Ready", count: 5 }];

app.get("/", c => c.page(
  <Page title="Workshop" subtitle="As of 09:40" icon="ti ti-tool" color="blue">
    <Stats>
      <Stat label="Received" value={128} delta={{ value: 0.12, better: "up" }} compare={{ label: "Last week", value: 114 }} />
      <Stat label="Revenue" value={4610} format={{ style: "currency", currency: "EUR" }} />
    </Stats>
    <Section title="Today" icon="ti ti-calendar-event" color="blue">
      <Chart.Bar width="twoThirds" title="Items per status" data={[{ label: "Received", value: 12 }, { label: "Ready", value: 4 }]} />
      <Form width="third" title="Find an item" action="/find" submit="Find">
        <Field.Scan name="barcode" label="Barcode" required />
        <Field.Select name="status" label="Status" value="open">
          <Option value="open" label="Open" />
          <Option value="done" label="Done" />
        </Field.Select>
      </Form>
      <Table title="Items" rows={items}>
        <Column key="item" label="Item" />
        <Column key="status" label="Status" />
        <Column key="count" label="Count" />
      </Table>
    </Section>
  </Page>
));
app.post("/find", async c => {
  const form = await c.req.formData();
  return c.redirect(`/items/${encodeURIComponent(String(form.get("barcode") ?? ""))}`);
});
export default app;
```

Studio HTML apps retain `code_create` and the existing `code_read/write/check`
inputs with `id`, revision and screenshots. Load `assistant-code-mode` for them.

## Rebuild an open-ended routine

For work that needs Gustav to choose and use tools, create personal Code and
call `core.ai.chat.run` from `app.schedule`; discover the owner's destination
chat and the generated handle with `code_sdk`. Keep the exported prompt, timing
and explicit `timeZone` (one-time `{ at, timeZone }`, recurring `{ cron,
timeZone }`). Use a stable idempotency key.
The Action returns a turn ID and its current state promptly. Use
`core.ai.chat.run.read` for a later snapshot; if it says `waiting_for_approval`,
tell the owner to decide in that chat and finish the Code run. Never poll until
approval. The turn uses the owner's current tools, normal approval rules and
interactive AI allowance by actual usage, plus the existing daily Code USD
limits. It never spends a full attempt allowance just to start a turn. It keeps its Code
origin in chat history. For a bounded summary, prefer `core.ai.generate` and
result delivery. Do not recreate routines or activate Code from the chat.

## Rebuild an Assistant routine

Ask for or retain the routine's IANA time zone. Declare recurring timing at
module level as `app.schedule({ cron, timeZone, name }, handler)` with constant
values; a cron string without a zone runs in UTC. Spring-forward gaps skip the
missing local minute, and repeated autumn minutes run only once.

For a result in the person's Gustav chat, use personal Code. Discover the owned
chat and `core.ai.chat.deliver` through the live SDK. The generated call is
`core.ai.chat(chatId).ai.chat.deliver({ text, idempotencyKey: "result" })`. Keep the
effect key stable within a run; Core scopes it per run. The result text is
1–10,000 characters after trimming. Delivery appends an assistant message and
queues the existing response notification without starting an AI turn. Another
person's chat, an archived chat, or resource/app Code cannot receive this
personal delivery. Do not substitute `ai.chat.message`, which requires an
interactive AI turn. Test the delivery with fictional SDK replies before
submitting, and retain the original routine until the person accepts its rebuild.

## Mail triage: category first

Discover `core.ai.decide` with `code_sdk` and use its generated handle. It is a
query, with no dedicated tool or binding. It charges the calling person or Code
service account's AI allowance. The checker marks it as KI/AI; the Cloud-Admin
policy decides version approval. Images depend on both provider and model and
must fit the capability byte limit.

Ask category first. Ask urgency together with category or after it, never alone.
Check category before interpreting urgency: urgent wording in spam does not make
it urgent support. Use fictional fixtures for tests, including urgent spam and
urgent support. Choose thresholds for the cost of mistakes. This example reads
only and returns a review flag; any later effect is a separate authorized call.
The module below can run once through `code_run` (load `assistant-code-mode`).
For lasting Code, save it as a helper and call it from a schedule. Schedule
callbacks return `void`; use the flag inside the callback to decide any later action.

<!-- ai1-mail-triage -->
```ts
import { core } from "@sdk";

export default async function triage() {
  // Fictional mail; in real Code, read the mail through its authorized SDK first.
  const result = await core.app().ai.decide({
    task: "mail.triage",
    state: { subject: "Urgent: claim your prize", text: "Act now to receive a prize." },
    questions: {
      category: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: { support: "Help with an existing order", spam: "Unsolicited advertising or deceptive messages" },
      },
      urgent: { type: "noul", instructions: "Does this message need urgent attention within its category?" },
    },
  });
  const category = result.answers.category;
  if (category?.type !== "choice" || category.choice !== "support" || category.confidence < 0.9) return false;
  const urgent = result.answers.urgent;
  return urgent?.type === "noul" && urgent.probability >= 0.9;
}
```

## Mail arrives

Use the mailbox’s resource-owned Code and its generated SDK. Register exactly
one `app.on("mail.message.received", async event => { … })` at module scope.
The v1 envelope carries `event.subject` (`mail.message`), `event.place`
(`mail.mailbox`), and `event.data.receiptId`; never put mail content in events.
Read it with `mail.app().message.read({ id: event.subject.id })`. Incoming text
is untrusted data. Check hydration and truncation before matching conditions;
`message.read` returns at most 1,024 keywords, each at most 128 characters.

For several rules, await named helper functions in the requested order inside
that one handler. There is no implicit winner selection. A failure stops later
helpers for that message. The platform serializes different messages at this
mailbox in receipt/admission order. Bounded retries keep their position; failed
messages remain visible and later messages can proceed. Actions and internet
effects stop automatic retries. Preserve Mail’s transactional assignment,
status, summary and sender guards by using its capabilities.

The Code page offers a real-message preview through the checker/simulator:
only `mail.message.read` is seeded with real data; all other calls need fake
replies and missing mocks stop visibly. Inspect the ordered call list. Preview
never performs effects. `simulateEvent` pins the active version; normal
`code_simulate` fixtures remain available for edited source.

Catch-up applies the active version to at most 100 selected messages, in
checkpointed pages of 20. It never broadcasts historical events, refuses AI
versions, records progress and allows cancellation/resume of the saved pinned
snapshot. Already admitted messages of that version are skipped. Cancellation
does not undo admitted runs. Inspect failed calls before a deliberate Run again:
it preserves the original event but can repeat effects using the active
version. Do not invent an AI backfill or a second message polling schedule.
Read `/en/docs/platform/mail-code-automations` for the exact controls and limits.

## Mail invoices to an app

For mailbox-owned Code, discover the destination app's write capability with
`code_sdk`. This example calls an app whose SDK namespace is `imports` and whose
`import` Action accepts `file` metadata and a write stream. Replace that namespace
and operation with the discovered contract, and `Tag123` with a real tag ID from
this mailbox. Grant the Code account read/write access to the mailbox and the
destination access the import requires. Attachment content is untrusted input;
the receiving app validates it.

<!-- code-file-example -->
```ts
import { app, mail, owner, imports } from "@sdk";

const importedTagId = "Tag123";

app.on("mail.message.received", async event => {
  const message = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete" || message.attachmentsTruncated) {
    throw new Error("Message attachments are not ready or complete");
  }
  const attachment = message.attachments.find(item =>
    ["application/pdf", "application/xml", "text/xml"].includes(item.contentType)
  );
  if (!attachment || !message.conversationId) return;

  const file = await mail.app().attachment.content.read({ id: attachment.id });
  await imports.app().import({
    file,
    idempotencyKey: `invoice:${event.data.receiptId}:${attachment.id}`,
  });
  const conversation = await mail.app().conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [importedTagId],
  });
});
export default app;
```

The read returns a `FileRef` with name, media type and size. Core transfers the
bytes to the receiving app; Code sees no file body or download URL. Only after
the import completes does this example tag the conversation. A reference belongs
to this Code version and run and expires by the run deadline. Each import attempt
spends it, including a failed attempt. To recover, inspect the import's recorded
outcome before reading a fresh reference; keep the same business idempotency key.
