# Events

`app.on(event, handler)` starts a run for each matching event. Only resource
Code can subscribe, and only to events at its own owner, the **place** of the
event. Personal and app-owned Code cannot subscribe. Declare the handler at
module level with a constant event name; one handler per event.

## Which events exist

| Event | Subject | Place | Can start Code today |
| --- | --- | --- | --- |
| `mail.message.received` | `mail.message` | `mail.mailbox` | Yes, in the mailbox's Code |
| `spaces.item.created`, `spaces.item.completed` | `spaces.item` | `spaces.space` | No: Spaces offers no Code of a space yet |
| `notebooks.note.created`, `notebooks.note.updated` | `notebooks.note` | `notebooks.notebook` | No: Notebooks offers no Code of a notebook yet |
| `notebooks.notebook.created`, `notebooks.notebook.updated` | `notebooks.notebook` | `notebooks.notebook` | No: as above |
| `core.user.created` | `core.user` | none | No: events without a place start no Code |

An event can start Code only when its app lets one of its resources own Code.
Today that is the mailbox alone. `code_check` reports `code_event_owner` for
an event at another place and `code_dynamic_event` in personal Code. Check `code_sdk` for the current list; do not promise
a Spaces, Notebooks, Chat, Contacts or Files automation until its place can own Code.

## The envelope

The handler receives `id`, `type`, `version`, `source`, `time`, `subject`
(`{ type, id }`), `place` (`{ type, id }`, this Code's owner), optional `cause`
and `data`. Data holds references, never content, and the event grants no
access. Read the current state through the SDK. Cloud checks that the
service account can still read the place before it admits a run.

## Handle incoming mail

`mail.message.received` fires once per received message, for the first copy
outside All Mail. Trash, Junk, outgoing mail and the mailbox's own sender do
not fire. Later moves and labels do not fire again. `event.subject.id` is the
message ID; `event.data.receiptId` identifies the receipt.

<!-- check: resource mail.mailbox -->
```ts
import { app, mail } from "@sdk";

app.on("mail.message.received", async event => {
  const { data: message } = await mail.app().message.read({ id: event.subject.id });
  // Throwing before the first Action lets Cloud retry the run automatically.
  if (message.hydrationStatus !== "complete") throw new Error("Message content is not ready yet");
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

type Message = Awaited<ReturnType<ReturnType<typeof mail.app>["message"]["read"]>>["data"];

async function tagInvoices(message: Message) {
  if (!message.conversationId || !/invoice/i.test(message.subject)) return;
  const { data: tags } = await owner.mailbox.tag.list({ limit: 50 });
  const tag = tags.find(candidate => candidate.name === "Invoice");
  if (!tag) return;
  const { data: conversation } = await mail.app().conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [tag.ref.id],
  });
}

async function markWaiting(message: Message) {
  if (!message.conversationId || !/out of office/i.test(message.subject)) return;
  const { data: conversation } = await mail.app().conversation.read({ id: message.conversationId });
  await owner.conversation.status.set({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    status: "waiting",
  });
}

app.on("mail.message.received", async event => {
  const { data: message } = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete") throw new Error("Message content is not ready yet");
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

- Runs for one mailbox start one at a time, in the order the receipts reached
  Cloud, even when Code concurrency is higher.
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
