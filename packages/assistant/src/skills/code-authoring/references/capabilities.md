# Capabilities per app

Code calls apps through the generated SDK. A handle selects the resource:
`mail.app()` for app-wide operations, `spaces.space(id)` for one Space,
`owner` for the resource that owns this Code. Method paths follow the
operation ID: `mail.conversation.tag.update` on a mailbox handle is
`owner.conversation.tag.update(...)`. The SDK takes domain input, lifts
`idempotencyKey` into call metadata. Domain Queries return `{ data, page? }`;
read fields from `data`. Actions return domain data directly, and streaming
reads return `FileRef`. A handle grants nothing: each call checks the policy,
the version approval and the current access of the account.

## Read a bounded number of pages

For paginated Queries such as `mail.conversation.list` and `spaces.task.list`,
pass `page.nextCursor` unchanged as the next input's `cursor`. Stop when
`page` is absent or `page.hasMore` is false. Always choose a fixed page or
item maximum; each page spends a normal call from the same per-run limit.
This example counts at most three pages and marks an incomplete count:

<!-- check: resource mail.mailbox -->
```ts
import { app, owner } from "@sdk";

const MAX_PAGES = 3;

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "count-inbox" }, async () => {
  let cursor: string | undefined;
  let conversations = 0;
  let complete = false;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const { data, page } = await owner.conversation.list({ view: "needs_action", limit: 50, cursor });
    conversations += data.length;
    if (!page?.hasMore) { complete = true; break; }
    cursor = page.nextCursor;
  }
  console.log(`Needs action: ${complete ? conversations : `${conversations} or more`}`);
}, { name: "count-inbox", title: "Count inbox" });
export default app;
```

Files retains its legacy `data.next` / input `after` contract; see the
[Files paging example](data.md). Narrow searches when only a sample is needed,
and label capped counts with `page.hasMore` rather than guessing from `limit`.

## When a call runs unattended

Code always runs without a person present. Each call falls into one class:

| Class | Meaning under the default Admin preset |
| --- | --- |
| **automatic** | Runs: Queries (`read`), silent Actions for the owner (`silent_you`) and drafts (`silent_draft`). AI Queries such as `core.ai.generate` count as AI instead. |
| **admin approval** | Runs after a Cloud administrator approves the version: silent Actions visible to others (`silent_shared`), AI use and internet requests. |
| **never** | Never runs unattended in this release: Actions that ask (sends, deletes, cannot undo, involves people, changes access, keeps working, sensitive, app asks), Actions without a declared policy, and silent Actions marked not for routines. Submitting such a version fails with `code_unattended_forbidden` or `code_sends_not_yet`. |
| **not in the SDK** | Streams, app-only Queries and Actions marked `code: false`; `code_check` reports `code_stream`, `code_app_only` or `code_code_false`. |

A Cloud administrator can tighten or loosen the non-asking rows; asking rows
stay **never**. The tables below list every Action of each app with its class
under the default preset. "Key required" means the Action needs an
`idempotencyKey`; Actions without one reject a key.

Queries other than AI read only and run by default, limited by the account's access. Resource
Code reads only what its service account was given; personal Code reads what
its person can read.

## Mail

Queries: `mail.attachment.content.read`, `mail.attachment.read`, `mail.attachment.read-content`, `mail.comment.read`, `mail.conversation.activity.list`, `mail.conversation.comment.list`, `mail.conversation.focus`, `mail.conversation.list`, `mail.conversation.read`, `mail.conversation.related`, `mail.conversation.reminder.get`, `mail.conversation.search`, `mail.delivery.list`, `mail.delivery.read`, `mail.draft.list`, `mail.draft.read`, `mail.draft.send.check`, `mail.draft.send.review`, `mail.folder.list`, `mail.mailbox.browse`, `mail.mailbox.identity.list`, `mail.mailbox.list`, `mail.mailbox.member.list`, `mail.mailbox.read`, `mail.mailbox.tag.list`, `mail.mailing-list.subscription.get`, `mail.mailing-list.subscription.list`, `mail.message.catchup`, `mail.message.event`, `mail.message.event-preview`, `mail.message.list`, `mail.message.read`, `mail.message.read-content`, `mail.reminder.read`, `mail.search`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `mail.conversation.assign` | Assign conversation | mail.mailbox | — | admin approval |
| `mail.conversation.assign.batch` | Assign conversations | mail.mailbox | — | admin approval |
| `mail.conversation.comment.create` | Create internal comment | mail.mailbox | required | admin approval |
| `mail.conversation.comment.delete` | Delete internal comment | mail.mailbox | required | never |
| `mail.conversation.comment.update` | Update internal comment | mail.mailbox | — | never |
| `mail.conversation.keep` | Keep conversation | mail.mailbox | — | admin approval |
| `mail.conversation.keep.release` | Stop keeping conversation | mail.mailbox | required | never |
| `mail.conversation.mark` | Mark email conversation | mail.mailbox | required | admin approval |
| `mail.conversation.move` | Move email conversation | mail.mailbox | required | admin approval |
| `mail.conversation.reference.ensure` | Ensure conversation reference | mail.mailbox | required | admin approval |
| `mail.conversation.reminder.cancel` | Cancel personal reminder | mail.mailbox | — | automatic |
| `mail.conversation.reminder.set` | Set personal reminder | mail.mailbox | — | automatic |
| `mail.conversation.snooze` | Show conversation later | mail.mailbox | — | admin approval |
| `mail.conversation.status.set` | Update conversation status | mail.mailbox | — | admin approval |
| `mail.conversation.status.set.batch` | Update the status of conversations | mail.mailbox | — | admin approval |
| `mail.conversation.status.update` | Update conversation status | mail.mailbox | — | admin approval |
| `mail.conversation.status.update.batch` | Update the status of conversations | mail.mailbox | — | admin approval |
| `mail.conversation.summary.write` | Write automated conversation summary | mail.mailbox | required | admin approval |
| `mail.conversation.tag.update` | Update conversation tags | mail.mailbox | — | admin approval |
| `mail.delivery.cancel` | Cancel delivery | mail.mailbox | required | never |
| `mail.draft.attachment.add` | Add draft attachment | mail.mailbox | required | admin approval |
| `mail.draft.attachment.remove` | Remove draft attachment | mail.mailbox | required | never |
| `mail.draft.create` | Create draft | mail.mailbox | required | admin approval |
| `mail.draft.discard` | Discard draft | mail.mailbox | required | never |
| `mail.draft.patch` | Change selected draft fields | mail.mailbox | — | admin approval |
| `mail.draft.send` | Send mail | mail.mailbox | required | never |
| `mail.draft.update` | Update draft | mail.mailbox | — | admin approval |
| `mail.folder.display.set` | Set where a folder's mail appears | mail.mailbox | — | never |
| `mail.mailbox.tag.create` | Create mailbox tag | mail.mailbox | required | admin approval |
| `mail.mailbox.tag.delete` | Delete mailbox tag | mail.mailbox | required | never |
| `mail.mailbox.tag.update` | Update mailbox tag | mail.mailbox | — | admin approval |
| `mail.mailing-list.unsubscribe` | Unsubscribe from mailing list | mail.mailbox | required | never |

Mail sending stays manual: create a draft and let a person send it.
`mail.attachment.content.read` returns an attachment as a [FileRef](file-ref.md). Use the
guarded Actions with `expectedRevision` from `mail.conversation.read`
(`collaboration.revision`); summaries also need `summaryRevision`. Assign
with `onlyIfUnassigned: true` to leave existing assignees alone.

<!-- check: resource mail.mailbox -->
```ts
import { app, mail, owner } from "@sdk";

app.on("mail.message.received", async event => {
  const { data: message } = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete") throw new Error("Message content is not ready yet");
  if (!message.conversationId || !/invoice/i.test(message.subject)) return;
  // Fictional user name; the search also matches names and groups, so compare the exact uid.
  const lead = (await owner.mailbox.member.list({ query: "accounting.lead", limit: 20 })).data.find(member => member.uid === "accounting.lead");
  const { data: [identity] } = await owner.mailbox.identity.list({ limit: 1 });
  const { data: conversation } = await mail.app().conversation.read({ id: message.conversationId });
  if (lead) {
    await owner.conversation.assign({
      conversationId: message.conversationId,
      assigneeUserIds: [lead.id],
      mode: "add",
      onlyIfUnassigned: true,
      expectedRevision: conversation.collaboration.revision,
    });
  }
  if (identity) {
    await owner.draft.create({
      senderIdentityId: identity.ref.id,
      intent: "reply",
      conversationId: message.conversationId,
      sourceMessageId: message.id,
      body: "Thank you, we received your invoice and will check it this week.",
      idempotencyKey: `invoice-reply:${message.id}`,
    });
  }
});
export default app;
```

The mailbox's service account needs **Edit** access to the mailbox for these
Actions; reading needs **View**.

## Spaces

Queries: `spaces.calendar-destination.list`, `spaces.calendar-invitation.preview`, `spaces.calendar-invitation.response.prepare`, `spaces.calendar.events`, `spaces.calendar.list`, `spaces.comment.list`, `spaces.comment.read`, `spaces.event.agenda`, `spaces.event.list`, `spaces.item.link-candidate.search`, `spaces.item.read`, `spaces.item.reference.find`, `spaces.item.reference.list`, `spaces.item.search`, `spaces.space.activity`, `spaces.space.assignee.list`, `spaces.space.browse`, `spaces.space.containers`, `spaces.space.list`, `spaces.space.read`, `spaces.space.search`, `spaces.task.blocker.list`, `spaces.task.blocks.list`, `spaces.task.checklist.list`, `spaces.task.focus`, `spaces.task.list`, `spaces.task.work.read`, `spaces.template.list`, `spaces.template.read`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `spaces.calendar-invitation.import` | Import calendar invitation | spaces.space | — | never |
| `spaces.calendar-invitation.response.commit` | Commit calendar response draft | — | — | not in the SDK |
| `spaces.comment.create` | Create comment | spaces.space | required | never |
| `spaces.comment.delete` | Delete comment | spaces.space | required | never |
| `spaces.comment.update` | Update comment | spaces.space | required | never |
| `spaces.event.create` | Create calendar event | spaces.space | required | admin approval |
| `spaces.event.invitation.commit` | Commit event invitation | — | — | not in the SDK |
| `spaces.event.invitation.prepare` | Prepare event invitation | — | — | not in the SDK |
| `spaces.event.update` | Update event | spaces.space | — | never |
| `spaces.item.delete` | Delete Space item | spaces.space | required | never |
| `spaces.item.reference.add` | Link a Cloud resource | spaces.space | — | admin approval |
| `spaces.item.reference.remove` | Unlink a Cloud resource | spaces.space | — | never |
| `spaces.item.tags.set` | Set item tags | spaces.space | — | never |
| `spaces.reaction.add` | Add reaction | spaces.space | required | never |
| `spaces.reaction.remove` | Remove reaction | spaces.space | required | never |
| `spaces.task.blocker.add` | Add task blocker | spaces.space | — | never |
| `spaces.task.blocker.remove` | Remove task blocker | spaces.space | — | never |
| `spaces.task.checklist.create` | Add task checklist entry | spaces.space | — | never |
| `spaces.task.checklist.delete` | Delete task checklist entry | spaces.space | required | never |
| `spaces.task.checklist.update` | Update task checklist entry | spaces.space | — | never |
| `spaces.task.claim` | Claim task work | spaces.space | — | never |
| `spaces.task.create` | Create task | spaces.space | required | admin approval |
| `spaces.task.progress` | Progress task work | spaces.space | — | never |
| `spaces.task.release` | Release task work | spaces.space | — | never |
| `spaces.task.set-completed` | Set task completion | spaces.space | — | never |
| `spaces.task.update` | Update task | spaces.space | — | admin approval |
| `spaces.template.create` | Create template | spaces.space | — | never |
| `spaces.template.delete` | Delete template | spaces.space | required | never |
| `spaces.template.update` | Update template | spaces.space | — | never |

Code can create tasks and calendar events, update tasks and link a Cloud
resource to an item; everything else in Spaces needs a person.
`spaces.task.create` without `columnId` puts the task into the first open
column. Spaces events cannot start Code yet ([Events](events.md)).

## Chat

Queries: `chat.discussion.list`, `chat.message.read`, `chat.notifications.read`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `chat.discussion.post` | Post to item discussion | — | — | not in the SDK |
| `chat.message.delete` | Delete discussion message | — | — | not in the SDK |
| `chat.message.edit` | Edit discussion message | — | — | not in the SDK |
| `chat.message.post` | Post a chat message | — | required | admin approval |
| `chat.notifications.set` | Set chat notifications | — | — | not in the SDK |
| `chat.thread.follow` | Follow or unfollow a discussion | — | — | not in the SDK |

`chat.message.post` takes a `conversation` ID and a Markdown `body`. The
account must be a member of that conversation. See the
[event to chat template](template-event-to-chat.md).

<!-- check: personal -->
```ts
import { app, chat } from "@sdk";

app.schedule({ cron: "0 16 * * 5", timeZone: "Europe/Berlin", name: "weekend-note" }, async () => {
  const day = new Date().toISOString().slice(0, 10);
  // Fictional conversation ID; take the real one from the conversation's address in Chat or ask the person.
  await chat.app().message.post({ conversation: "Cnv001", body: "Have a good weekend!", idempotencyKey: `weekend:${day}` });
}, { name: "weekend-note", title: "Weekend note" });
export default app;
```

## Notebooks

Queries: `notebooks.annotation.list`, `notebooks.annotation.read`, `notebooks.annotation.replies`, `notebooks.comment.browse`, `notebooks.comment.list`, `notebooks.comment.read`, `notebooks.note.children`, `notebooks.note.links`, `notebooks.note.preview`, `notebooks.note.read`, `notebooks.note.search`, `notebooks.note.tree`, `notebooks.notebook.activity`, `notebooks.notebook.browse`, `notebooks.notebook.containers`, `notebooks.notebook.list`, `notebooks.notebook.read`, `notebooks.notebook.search`, `notebooks.tag.list`, `notebooks.tag.notes`, `notebooks.template.list`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `notebooks.annotation.accept` | Accept a passage suggestion | notebooks.notebook | required | never |
| `notebooks.annotation.create` | Comment on a passage | notebooks.notebook | required | never |
| `notebooks.annotation.delete` | Delete your recent comment | notebooks.notebook | required | never |
| `notebooks.annotation.edit` | Edit your recent comment | notebooks.notebook | — | never |
| `notebooks.annotation.reject` | Reject or reopen a passage suggestion | notebooks.notebook | — | never |
| `notebooks.annotation.reply` | Reply to a comment | notebooks.notebook | required | never |
| `notebooks.annotation.resolve` | Resolve or reopen a comment | notebooks.notebook | — | never |
| `notebooks.annotation.restore` | Restore your recent deleted comment | notebooks.notebook | — | never |
| `notebooks.annotation.undo-accept` | Undo an accepted passage suggestion | notebooks.notebook | required | never |
| `notebooks.comment.create` | Add page discussion post | notebooks.notebook | required | never |
| `notebooks.comment.delete` | Delete page discussion post | notebooks.notebook | required | never |
| `notebooks.comment.update` | Edit page discussion post | notebooks.notebook | — | never |
| `notebooks.note.create` | Create note | notebooks.notebook | required | never |
| `notebooks.note.edit` | Edit note | notebooks.notebook | — | never |
| `notebooks.note.move` | Move note | notebooks.notebook | — | never |

Code can read and search notes; no Notebooks Action runs unattended yet.

## Contacts

Queries: `contacts.book.list`, `contacts.book.read`, `contacts.contact.list`, `contacts.contact.read`, `contacts.contact.resolve`, `contacts.contact.search`, `contacts.contact.suggest`, `contacts.note.list`, `contacts.note.read`, `contacts.tag.list`, `contacts.tag.read`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `contacts.contact.create` | Create contact | contacts.book | required | never |
| `contacts.contact.delete` | Delete contact | contacts.book | required | never |
| `contacts.contact.move` | Move contact | contacts.book | required | never |
| `contacts.contact.update` | Update contact | contacts.book | — | never |
| `contacts.favorite.set` | Set contact favorite | contacts.book | — | never |
| `contacts.note.create` | Create contact note | contacts.book | required | never |
| `contacts.tag.change` | Change contact tags | contacts.book | — | never |

Code can look up contacts, for example to recognise a sender; no Contacts
Action runs unattended yet.

## Files

Queries: `filesv2.activity.chain`, `filesv2.activity.get`, `filesv2.activity.list`, `filesv2.bases.list`, `filesv2.content.download`, `filesv2.content.read`, `filesv2.entry.list`, `filesv2.entry.read`, `filesv2.entry.search`, `filesv2.entry.search-in-base`, `filesv2.provider.list`, `filesv2.share.access`, `filesv2.storage.read`, `filesv2.template.read`, `filesv2.trash.list`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `filesv2.content.create` | Write file content | — | — | not in the SDK |
| `filesv2.entry.copy` | Copy entry | filesv2.entry | required | never |
| `filesv2.entry.move` | Move entry | filesv2.entry | required | never |
| `filesv2.entry.rename` | Rename entry | filesv2.entry | required | never |
| `filesv2.entry.trash` | Move entry to trash | filesv2.entry | required | never |
| `filesv2.folder.create` | Create folder | filesv2.entry | required | never |
| `filesv2.provider.save` | Save a new file | — | — | not in the SDK |
| `filesv2.trash.restore` | Restore entry from trash | filesv2.entry | required | never |

The Files app is `filesv2`. Code can list, search and read entry metadata,
and `filesv2.content.read` returns a file as a [FileRef](file-ref.md) to pass
to another app. Code cannot write file content, and no Files Action runs
unattended yet.

Reading from several apps in one personal page:

<!-- check: personal -->
```tsx
import { app, contacts, filesv2, jsx, notebooks, Page, Table, Column } from "@sdk";

app.get("/", async c => {
  const [base] = (await filesv2.app().bases.list({})).data.items;
  const files = base ? (await filesv2.entry(base.ref.id).entry.list({ sort: "modified", order: "desc" })).data.items.slice(0, 10) : [];
  const { data: people } = await contacts.app().contact.search({ query: "supplier", tags: [], limit: 10 });
  const { data: notes } = await notebooks.app().note.search({ query: "supplier", tags: [], limit: 10 });
  return c.page(
    <Page title="Suppliers">
      <Table width="third" title="Recent files" rows={files.map(file => ({ name: file.name, modified: file.modified }))}>
        <Column key="name" label="Name" />
        <Column key="modified" label="Changed" />
      </Table>
      <Table width="third" title="Contacts" rows={people.map(person => ({ name: person.title }))}>
        <Column key="name" label="Name" />
      </Table>
      <Table width="third" title="Notes" rows={notes.map(note => ({ title: note.title }))}>
        <Column key="title" label="Title" />
      </Table>
    </Page>
  );
});
export default app;
```

## Gustav (Core AI)

Queries: `core.ai.chat.read`, `core.ai.chat.resources`, `core.ai.chat.run.read`, `core.ai.chat.search`, `core.ai.chats.resources`, `core.ai.chats.search`, `core.ai.decide`, `core.ai.generate`, `core.ai.skill.access.read`, `core.ai.skill.read`, `core.ai.skill.reference.read`, `core.ai.skills.list`, `core.ai.task.read`, `core.ai.task.run.read`, `core.ai.tasks.list`.

| Action | Title | Target | Key | Unattended |
| --- | --- | --- | --- | --- |
| `core.ai.chat.deliver` | Deliver a Code result to your chat | core.ai.chat | required | automatic |
| `core.ai.chat.message` | Message another AI conversation | core.ai.chat | required | never |
| `core.ai.chat.run` | Start a Gustav turn from personal Code | core.ai.chat | required | admin approval |
| `core.ai.skill.access.change` | Change Skill access | core.ai.skill | required | never |
| `core.ai.skill.create` | Create an Assistant Skill | — | required | never |
| `core.ai.skill.delete` | Delete an Assistant Skill | core.ai.skill | required | never |
| `core.ai.skill.enabled.set` | Set personal Assistant Skill state | core.ai.skill | — | never |
| `core.ai.skill.reference.remove` | Remove an Assistant Skill reference | core.ai.skill | — | never |
| `core.ai.skill.reference.set` | Set an Assistant Skill reference | core.ai.skill | — | never |
| `core.ai.skill.references.set` | Set Assistant Skill references | core.ai.skill | — | never |
| `core.ai.skill.update` | Update an Assistant Skill | core.ai.skill | — | never |
| `core.ai.task.create` | Create an Assistant routine | core.ai.chat | required | never |
| `core.ai.task.delete` | Delete an Assistant routine | core.ai.chat | required | never |
| `core.ai.task.pause` | Pause an Assistant routine | core.ai.chat | — | never |
| `core.ai.task.resume` | Resume an Assistant routine | core.ai.chat | — | never |
| `core.ai.task.run` | Run an Assistant routine now | core.ai.chat | required | never |
| `core.ai.task.update` | Update an Assistant routine | core.ai.chat | — | never |

Only `core.ai.chat.deliver` and `core.ai.chat.run` are meant for Code; both
work in personal Code alone ([AI](ai.md)). Routines and Skills are managed by
people, not by Code.

## When a call is refused

A refused call rejects its promise with an error whose message is a stable
code, such as `code_policy_never` or `code_approval_required`. The run shows
the first call the target refused (403 or 404); a 404 can mean missing access
or a missing object. See [Troubleshooting](troubleshooting.md).
