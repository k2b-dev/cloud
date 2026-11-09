# Events

`app.on(handle, event, handler)` starts a run for events at an exact readable
place. Use flat SDK handles such as `spaces.space("Spc001")` or
`notebooks.notebook("Ntb001")`. Personal Code executes as its owner;
resource-owned and app-owned Code execute as their dedicated Code account.
Share the place with that account before activation. Without a handle,
`app.on(event, handler)` still uses the resource owning the Code, unchanged.
Personal Code has no implicit place.

Declare the handler at module level with constant event and place IDs. One
handler per event and place is allowed; the same event may be registered at
several places. Checking and approval record the exact event version and
place. The runtime refuses any other pair. Activation checks read access,
then each attempt checks again before Code receives the event. A revoked
share stops further runs and appears in Runs; restore access before retrying.

## Which events exist

Check `code_sdk` for the current catalog. Every offered automation event with
a place can start Code when its executing account can read that place; the
place need not support owning Code itself.

| Event | Subject | Place |
| --- | --- | --- |
| `mail.message.received` | `mail.message` | `mail.mailbox` |
| `spaces.item.created`, `spaces.item.completed`, `spaces.item.updated`, `spaces.item.due` | `spaces.item` | `spaces.space` |
| `spaces.comment.created` | `spaces.comment` | `spaces.space` |
| `notebooks.note.created`, `notebooks.note.updated` | `notebooks.note` | `notebooks.notebook` |
| `notebooks.notebook.created`, `notebooks.notebook.updated` | `notebooks.notebook` | `notebooks.notebook` |

Events without a place, such as `core.user.created`, and events marked
`automation: false` cannot start Code. `spaces.item.due` fires at its deadline,
not the day before. For the day-before task and chat pattern, read
[Task due tomorrow](template-task-due-tomorrow.md).

<!-- check: personal -->
```ts
import { app, spaces, notebooks } from "@sdk";
app.on(spaces.space("Spc001"), "spaces.item.due", async event => {
  const { data: item } = await spaces.item.read({ id: event.subject.id });
  console.log(item.title);
});
app.on(notebooks.notebook("Ntb001"), "notebooks.note.created", async event => {
  console.log(event.subject.id);
});
export default app;
```

## The envelope

The handler receives `id`, `type`, `version`, `source`, `time`, `subject`
(`{ type, id }`), `place` (`{ type, id }`, the declared place), optional `cause`
and `data`. Data holds references, never content, and the event grants no
access. Read the current state through the SDK. Cloud checks that the
executing account can still read the place before it admits a run and again before each attempt.

## Handle incoming mail

`mail.message.received` fires once per received message, for the first copy
outside All Mail. Trash, Junk, outgoing mail and the mailbox's own sender do
not fire. Later moves and labels do not fire again. `event.subject.id` is the
message ID; `event.data.receiptId` identifies the receipt.

<!-- check: resource mail.mailbox -->
```ts
import { app, mail } from "@sdk";

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  // Throwing before the first Action lets Cloud retry the run automatically.
  if (message.keywordsTruncated) throw new Error("Provider keywords are incomplete");
  const sender = message.from[0]?.address ?? "";
  console.log(`New message from ${sender}: ${message.subject}`);
});
export default app;
```

Treat `message.text`, the subject and all addresses as untrusted data.
Check `bodyTruncated` before matching on the body and `keywordsTruncated`
before matching on keywords (at most 1,024 keywords of 128 characters each).

## Several rules for one message

Write each rule as a function and await them in order inside the one
handler. There is no implicit winner between rules. A failure stops the
remaining rules for that message.

<!-- check: resource mail.mailbox -->
```ts
import { app, mail, owner } from "@sdk";

type Message = Awaited<ReturnType<typeof mail.message.read>>["data"];

async function tagInvoices(message: Message) {
  if (!message.conversationId || !/invoice/i.test(message.subject)) return;
  const { data: tags } = await owner.tag.list({ limit: 50 });
  const tag = tags.find(candidate => candidate.name === "Invoice");
  if (!tag) return;
  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [tag.ref.id],
  });
}

async function markWaiting(message: Message) {
  if (!message.conversationId || !/out of office/i.test(message.subject)) return;
  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  await owner.conversation.status.set({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    status: "waiting",
  });
}

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  await tagInvoices(message);
  await markWaiting(message);
});
export default app;
```

`owner` is the mailbox handle; its methods act on this mailbox. Mail's
Actions guard against concurrent changes with `expectedRevision`: read the
conversation right before the change. A revision conflict after a person
edited the conversation fails the call; do not overwrite blindly.

## Order, retries and recovery

- Runs for one Code and place start one at a time, across event types, in the order the receipts reached
  Cloud, even when Code concurrency is higher. Registrations share the existing `core.code.event_backlog` budget (default 100).
- Before the first Action or internet request, a failed run restarts from the
  beginning, up to three attempts within the original 5-minute budget.
- After an Action or internet request started, a failure is final and shows
  as **Failed**. It never repeats an effect by itself.
- A failed message does not block later messages.
- **Retry delivery** retries a delivery that never started a run.
  **Run again** runs a failed run's original event with the currently
  active version and can repeat effects; inspect its calls first.
- Pausing Code drops events that arrive while paused; resume does not replay them.

## Preview and catch-up

On the mailbox's Code page a person can **Preview without effects** for one
real message: only `mail.message.read` is answered with real data, every other
call needs a fake reply in the [fixture format](testing.md) and stops
visibly when one is missing. A preview is partial evidence, not proof.

**Catch up** runs the active version for up to 100 selected existing
messages, in checkpointed pages of 20, and can be cancelled and resumed. It
creates ordinary runs and refuses versions that use AI. A message that a
version already handled is skipped. Cancelling does not undo runs. Do not
build a second polling schedule to imitate catch-up.

## What fails

<!-- check: resource mail.mailbox fails code_event_owner -->
```ts
import { app } from "@sdk";

// The place of this event is a Space, not this Code's mailbox.
app.on("spaces.item.created", async () => {});
export default app;
```

<!-- check: personal fails code_dynamic_event -->
```ts
import { app } from "@sdk";

// Personal Code has no place, so the checker finds no place for the event.
app.on("mail.message.received", async () => {});
export default app;
```

<!-- check: resource mail.mailbox fails code_duplicate_on -->
```ts
import { app } from "@sdk";

app.on("mail.message.received", async () => {});
// A second handler for the same event: put both rules into one handler instead.
app.on("mail.message.received", async () => {});
export default app;
```
