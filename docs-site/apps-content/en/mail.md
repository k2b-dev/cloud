---
title: Mail
navTitle: Mail
section: Work
order: 110
description: Connected mailboxes with search, team context, reliable sending, and automation.
tags: [mail, email, collaboration]
updated: 2026-10-22
---

# Mail

Mail connects email accounts and turns their messages into a shared workspace.
It keeps portable mail state synchronized with the provider while adding team
context such as assignments, comments, local tags, reminders, and follow-up state.

The sidebar lists **Focus** and your mailboxes, with pinned mailboxes first.
The open mailbox expands to Inbox, Drafts, Scheduled, Send problems, Sent,
Archive/Trash/Junk under **More**, and custom folders. On a phone, open the
mailbox title to reach these places.

The head contains view tabs (**All**, **Needs action**, **Assigned to me**,
**Waiting for reply**, **Unassigned**, and **More** for the remaining and saved
views), a **Tag** chip, and a **Search** chip for an active structured search.
Remove that chip or use **Reset** to clear filters. Folders, Scheduled, and
Send problems have no view tabs. **Choose list view**, the **…** mailbox menu,
and **Compose** are also in the head. The mailbox menu contains details,
tools, and Settings according to your access.

Assignee filters in search and saved-view summaries read **Assigned to a
specific person**. Open the search editor to change the selected
person; summaries do not show account IDs.
Saved automation assignments use the same label when the person is no longer
available in the choices.

On wide screens the conversation list grows with the window from 320 to
440 px, and the subject and messages stay in a centered reading column of at
most 760 px. **Conversation details** stand beside the reader while the reader
keeps 440 px next to them; otherwise they wait behind **Details** and open with
one click, also from the reader's own details button. Hiding the list gives
the reader that room. In Focus, a conversation opens its details beside the
queue, or over its end when there is no room; on a phone it opens in its
mailbox. List rows have three lines (sender and time, subject with its marks,
preview) and a fourth only for tags or **Waiting**. When the reader is narrow,
Reply all and Forward show only their icons, then move into **…**.

Signed-in users can choose **New mailbox**; after creation, its delivery
settings open before you enter the mailbox. If settings cannot load, the
mailbox opens directly.

## Use Mail

Opening a conversation checks its current read state, flags, folders, and message
count across the entire thread, even when the reader loads only its newest 100
messages. Changes to older messages therefore also refresh the list row before
automatic marking as read.

- Read complete conversations and search synchronized message and attachment
  content across a mailbox. Pull the conversation list down at its top, by
  touch, mouse drag, or trackpad overscroll, to fetch new mail.
- Organize provider mail with folders, read state, flags, archive, junk, and
  trash actions.
- Assign conversations, maintain a shared summary, leave internal comments,
  browse by local tag, and mark work done while Mail derives whether the next
  step needs action or is waiting for a reply.
- See meaningful status, assignment, tag, summary, and workflow changes quietly
  in the conversation at the time they happened.
- Continue the newest unfinished conversation draft directly from the reader.
- Compose and schedule messages through verified sender identities. The
  paperclip attaches files from this device or, when Cloud apps offer files,
  from one of them, such as Files. Attachments from an app arrive as copies
  and follow the same upload limits as files from the device.
- Review detected mailing lists and safely request unsubscribe or clean up existing messages when permitted.
- Use incoming automations, automatic replies, or reviewed workflows for
  recurring mailbox work. One incoming automation can mark mail read and then
  move it, and its conditions can exclude senders, domains, or text. When several
  automations match, the oldest decides the folder, and an automation skips a
  read or keyword step for mail that has moved or is being moved.

Provider folders and message flags can appear in other mail clients. Cloud-only
collaboration fields stay in Mail.

## Understand the Mail model

| Resource | Responsibility |
| --- | --- |
| Mailbox | One connected email account with provider settings and its own access rules |
| Conversation and message | A synchronized thread and its individual received or sent messages |
| Sender identity and draft | Verified sending context and message content before delivery |
| Collaboration state | Editable summaries, assignees, comments, local tags, reminders, and a derived next step with manual Done |
| Incoming automation and workflow | Reviewed flows that match incoming mail and mix bounded Mail and AI actions |

The email provider remains the source for portable mail state. Mail keeps a
synchronized Cloud copy for search, collaboration, durable commands, and
observable delivery. Credentials and refresh tokens are stored as write-only
secrets.

## Understand the working model

We recommend **Needs action** as your inbox: the work status (**Needs action**, **Waiting for reply**, **Done**) is your queue; folders are filing.
Every incoming message sets **Needs action** and clears **Show later** once Mail loads it or gives up loading it, whatever its folder. A confirmed human reply sets **Waiting for reply**.
Moving, archiving, filing, and marking read change no work status. Follow-up and assignment views span folders; see [Choose where a folder's mail appears](#choose-where-a-folders-mail-appears) for folder visibility.
**Assigned to me** and **Unassigned** leave out **Done** and **Later** conversations.

### Finish work and keep the provider Inbox in step

Mark **Done** in **Conversation details**, with `cld mail done <conversation-id> --mailbox <mailbox>`, `cld mail conversation update <id> --revision <r> --done`, `POST /api/mail/mailboxes/{mailboxId}/conversations/completion`, or an automation's `set_status: done`.
Done updates only Cloud collaboration state and activity, clears **Show later**, and sends no provider command. It does not archive, move, or mark read. Other mail clients still show the email in the provider Inbox.

To also clear that Inbox, choose **Archive**, run `cld mail archive <conversation-id> --mailbox <mailbox>`, or add `move_to_folder` to the same automation.
The archive command takes up to 50 IDs and acts on Inbox messages unless `--in` names another folder. On Gmail, it removes only the Inbox label. Archiving keeps the work status; it never marks Done.

### File noise and keep important mail visible

For newsletters, sign-in codes, or shipping updates, use one automation: `mark_read`, `set_status: done`, then `move_to_folder`. Save this as `newsletter.yaml`:

```yaml
name: File the Example newsletter
enabled: true
scope:
  mode: matching
  conditions:
    mode: all
    items:
      - { field: sender_domain, operator: is, value: news.example.com }
steps:
  - id: 2f1c7a52-0b8e-4d3a-9c41-6a5e8f0d1b01
    kind: mail_action
    action: { kind: mark_read }
  - id: 2f1c7a52-0b8e-4d3a-9c41-6a5e8f0d1b02
    kind: mail_action
    action: { kind: set_status, status: done }
  - id: 2f1c7a52-0b8e-4d3a-9c41-6a5e8f0d1b03
    kind: mail_action
    action: { kind: move_to_folder, folderId: Newsletters }
```

Create it with `cld --json mail automation create --definition-file newsletter.yaml`. This example is enabled; omitting `enabled` defaults to `false`.
For important mail, add no status step: incoming mail already sets **Needs action**.

In the guided editor, **AI classify** starts with **Important**, **Routine**, and an If branch: **Set status → Needs action** for **Important**, **Set status → Done** otherwise. Add **Move to folder** to the **Routine** branch to file it too.
An automation's **Done** or **Waiting for reply** covers only its triggering message, even if Mail loads it later or gives up loading it. Other incoming mail sets **Needs action** again. A person's Done or **Show later** also covers messages Mail still loads.
When several automations match, the oldest decides the folder. Another skips its read step if the message has left its folder or is being moved. Keep read and move in one automation, with read first; the local status step can share that path.
For existing mail, enable a saved automation without AI steps, then run `cld --json mail automation backfill start <automation-id> --revision <revision> --yes`. One backfill hands over at most 100 messages; `limited` means run it again. For moving only, see [`cld mail sender move`](#automate-mail-from-the-terminal).

### Choose the right follow-up and mailbox pattern

- **Show later** (`cld mail conversation update <id> --revision <r> --snooze-until <ISO>`) hides a conversation in **Later** until that time, then returns it with the same status; new incoming mail ends it earlier, and Done cannot be snoozed.
- A personal reminder (`cld mail reminder set <id> --due <ISO>`) is private, sends you a Cloud notification when due, and changes no status.
- A saved view (`cld mail saved-view create`, **Settings → Organization**) filters folder, assignee, next step, local tag, and Later, for example “Needs action + tag Priority”; it filters the same status, without creating a separate queue.

For a personal mailbox, work from **Needs action**. Automations mark noise Done and file it. Mark Done when finished; also archive if you want another mail client's Inbox clean. **Waiting for reply** follows automatically; use **Show later** for date-dependent work.

For a shared mailbox, use **Unassigned** with **Needs action** as team intake. Assign an owner with **Assign**, `cld mail assign <id> --to <user>`, or automation `assign_user`. Each person works from **Assigned to me**; the owner's confirmed reply sets **Waiting for reply**, and the owner marks **Done**. For team folders outside shared lists, use [**Only in the folder**](#choose-where-a-folders-mail-appears).

### Make a clean start with old conversations

For thousands of old Needs action conversations, choose a mailbox or folder and a cutoff. This Bash loop needs `jq` and keeps newer mail in Needs action:

```bash
mailbox=Personal            # or a folder: "Personal:Newsletters"
before=2026-09-01           # keep newer conversations in Needs action
cursor=
while :; do
  page=$(cld --json mail ls "$mailbox" --view needs_action --limit 100 ${cursor:+--cursor "$cursor"}) || break
  jq -r --arg before "$before" '.items[] | select(.latestMessageAt < $before) | .id' <<<"$page" \
    | xargs -r -n 50 cld mail done --mailbox "${mailbox%%:*}"
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [ -n "$cursor" ] || break
done
```

Lists are newest first by `latestMessageAt` and page by position, so marking a page Done does not shift the next page; pass the same scope and view with `--cursor`. To finish every conversation in the view, drop the `select(...)` filter. Each `done` call takes up to 50 IDs, covers messages Mail still loads, and exits 1 when an ID reports `not_found`.
Done changes nothing at the provider. To also empty the provider Inbox, run `cld mail archive` with the same IDs; an ID without Inbox messages reports an error and the command exits 1.

## Choose where a folder's mail appears

Each folder has one display setting, the same for everyone in the mailbox:

| Display | Sidebar | All mail, work views, and their counts | Search and saved views |
| --- | --- | --- | --- |
| Everywhere (`everywhere`) | Shown | Included | Found |
| Only in the folder (`folder_only`) | Shown | Left out | Found |
| Hidden (`hidden`) | Hidden | Left out | Found |

Use **Only in the folder** for shared or team folders whose mail should not
fill the shared work lists. The folder itself still lists its conversations and
counts its unread mail, and **Assigned to me** and **Send problems** keep every
conversation. Search results from the API, `cld`, and agent tools name the
folder each result is filed in. The views left
out are All mail, Needs action, Waiting, Later, Done, Unassigned, Recently
active, and the cross-mailbox overview; agent tools follow the same rule.

A subfolder uses its parent's display when that one is stricter: it can keep
more mail inside, never less. A conversation leaves those views only when one
of its messages lies in an **Only in the folder** or **Hidden** folder and none
lies in an **Everywhere** folder. Sent, Drafts, Trash, Junk, and the provider's
collections such as Gmail's All Mail, Important, and Starred do not count. With
Gmail, a conversation labelled only `Shared` stays in that folder although it
is also in All Mail and holds your reply in Sent; once a message of it arrives
in the Inbox, it appears everywhere again.

Mailbox administrators change the display with
`PATCH /api/mail/mailboxes/{mailboxId}/folders/{folderId}` and
`{"display": "folder_only"}`, `cld mail folder display set folder_only <folder-id>`,
or the agent action `folder.display.set`. In Mail, they choose it under
**Settings > Folders**, where selecting a folder opens the three displays with
a short explanation and the folder's actions, and subfolders show the display
they inherit. The sidebar marks each folder set to **Only in the folder**, the
phone navigation names it below the folder, and
All mail and the work views name such a folder in a hint until the person
dismisses it in that browser. Sent, Drafts,
Trash, Junk, and provider collections cannot be set to `folder_only`, because
they never decide where mail appears; a parent's **Only in the folder** changes
nothing for them, and only **Hidden** takes them out of the sidebar. `GET /api/mail/mailboxes/{mailboxId}/folders`
and `cld mail folders` show each folder's own display, the effective one, and
the parent it comes from. Newly discovered folders show their mail everywhere,
whether or not the account subscribes to them.

## Keep conversations that must not be deleted

Some mail is evidence, for example that a customer was informed. Anyone who can
write in a mailbox can **Keep** a conversation; the lock it gets protects the
whole conversation, including replies that join it later and messages that are
split off or merged elsewhere; the conversation that receives them becomes kept
too. While a conversation is kept, Mail refuses to delete its messages, to move
them to Trash, Junk, or Drafts, or to delete a folder that holds them, with
status 409 and the code `CONVERSATION_KEPT` (for a folder,
`FOLDER_HAS_KEPT_CONVERSATIONS`). A folder counts as Trash, Junk, or Drafts by
the provider's role or by the role configured in Mail; Drafts is included
because Mail imports what lands there as drafts, and discarding a draft deletes
it on the server. The check sits where every Mail command is
created and again right before the mail server is changed, so the web app,
selections, incoming automations, workflows, the API, `cld`, and the Assistant
all get the same answer, also for a delete queued shortly before the keep.
Archiving, moving between other folders, marking, and replying stay allowed.
Cancelling a scheduled message also stays allowed, because it was never sent;
if it was the conversation's only message, the conversation and its keep end
with it, and the audit log records the cancellation as
`mail.scheduled_send.cancel`.

Mail already stores the original source and the decoded attachments of every
message it loads. Keeping a conversation loads its remaining messages first and
retries messages whose loading failed earlier, except those over 128 MB. When
another client or the server deletes a kept message, or a delete that Cloud
started just before the keep finishes, Mail keeps showing its copy in the
folder where it was last, marked as deleted on the server. The copy can be read,
searched, and exported as `.eml`. Conversation actions (archive, move, mark)
change it in Cloud only, next to the commands for the server's messages; a
command for that one message on the mail server, such as
`cld mail message delete`, reports `KEPT_COPY_ONLY`. A message the server
deletes before Mail could load it, for example while the mailbox is paused or
its folder is not synchronized, or one larger than 128 MB, has no Cloud copy.
When another client deletes a whole folder, Mail shows the folder as missing
and keeps its messages there, without the deleted-on-server mark.

Only mailbox administrators (**Manage**) lift the protection, after a
confirmation that names the consequence: the conversation can be deleted
again, and messages of which only Cloud's copy remains disappear from the
mailbox; keeping it again later does not bring them back. Keeping and lifting
are recorded in the conversation activity and the audit log
(`mail.conversation.keep`, `mail.conversation.keep.release`). A keep that a
merge, split, or reassignment carried into another conversation is recorded
there as `mail.conversation.keep` by the person who moved the messages, with
`carriedFrom` naming the source conversation. There is no retention date.

| Surface | Keep | Lift |
| --- | --- | --- |
| Web app | **More conversation actions > Keep**, or the toolbar | **Stop keeping** |
| API | `PUT /api/mail/mailboxes/{mailboxId}/conversations/{conversationId}/keep` | `DELETE` on the same path |
| `cld` | `cld mail keep <conversation-id>...` | `cld mail unkeep <conversation-id>` |
| Capabilities | `conversation.keep` | `conversation.keep.release` |

The **Kept** view (`view=kept`, `cld mail ls --view kept`) and the search
condition `{"type":"kept"}` list a mailbox's kept conversations from every
folder, newest first. Conversation rows carry `kept`, messages carry
`deletedOnServer` (with `remoteAvailable: false`), and `conversation.read`
names who kept the conversation and since when. See
[Mail storage for kept conversations](/en/docs/operations/deployment-requirements#mail-storage-for-kept-conversations)
for the storage this takes.

## Delete and restore a mailbox

The Mail overview lists your mailboxes in a sidebar with their unread and
needs-action counts; opening one enters its workspace. Inside a mailbox the
same sidebar names the other mailboxes without counts, so opening a mailbox
never waits for the cross-mailbox counts; the open mailbox shows its folders
with live counts, and its pin and hide sit under **…** on its row. The page itself is the
cross-mailbox focus queue (for me, unassigned, waiting, all active) with
**Compose** as its primary action.

People can pin a mailbox to the top of that sidebar or hide one they rarely
need. A hidden mailbox moves to a collapsed **Hidden mailboxes** section, and its
conversations leave the focus queue and its view counts; it stays connected and
opens directly. Mail stores pins and hidden mailboxes per principal, so they
apply on every device and never change what others see. A service account or
agent keeps its own lists, like a person, and a personal API key uses its
person's lists. Each list holds up to 200 mailboxes the principal can still
read; a mailbox whose access ends drops out of the lists and returns with the
access.

`GET /api/mail/mailboxes/preferences` reads the lists, and
`PATCH /api/mail/mailboxes/{mailboxId}/preference` pins or hides one mailbox;
`cld mail mailbox preferences|pin|unpin|hide|unhide` wraps both. The focus API
and `cld mail focus` cover every readable mailbox; pass the hidden ones as
`excludeMailboxIds` to get the overview's queue.

Open **Recently deleted mailboxes** at the bottom of that sidebar to load
mailboxes you can restore. The list loads on demand and supports retry and
pagination.

Moving a mailbox to **Recently deleted** pauses its transport and retains its
Cloud data. It does not delete provider mail. A mailbox administrator can
restore it, but synchronization stays paused until the connection and mailbox
health have been checked and synchronization is explicitly resumed.

Back up Cloud's Postgres data, including Mail attachments and collaboration
history. Reconnecting the email provider does not restore Cloud-only data.
See [Deployment requirements](/en/docs/operations/deployment-requirements)
for the backup boundary.

## Assign conversations and limit access to them

A conversation can have up to 20 assignees. People with mailbox-wide Write or
Admin access assign them; each newly added person gets one notification per
request. **Assigned to me** lists the conversations a person is one of the
assignees of, and **Unassigned** the ones without an assignee who can still
work on them. Only people being added must have access; someone whose access
ended stays assigned until removed, also when others are added. The API takes
`assigneeUserIds` with the modes `add`, `remove`, and `replace` on
`POST /api/mail/mailboxes/{mailboxId}/conversations/assign`,
and replaces the whole set with `assigneeUserIds` on the collaboration
`PATCH`. Lists, search, focus items, and the workflow data type
`mailConversation` report `assigneeUserIds`; collaboration reports
`assignees`. The workflow action `assignConversation` keeps its single `user`:
it replaces the assignees with that person, and `null` removes them all.
Merging two conversations keeps the assignees of both, and splitting one gives
the new conversation the same assignees.

The API marks up to 50 visible conversations of one mailbox done or reopens
them with `POST /api/mail/mailboxes/{mailboxId}/conversations/completion`
and `{ "conversationIds": ["<id>"], "completion": "done" | "open" }`.
It needs write access, including assigned-only write access, and no revision.
Results follow request order; each reports `ok` with `workStatus` and
`revision`, or `not_found` for missing or invisible conversations.

Next to View, Edit, and Manage, a mailbox grant for a person or group can cover
only the conversations assigned to the person: **View assigned only** (`read`)
or **Edit assigned only** (`write`). The access API takes it as
`"scope": "assigned"` on `POST` and `PATCH /api/mail/mailboxes/{mailboxId}/access`
and returns it on each such entry; a `PATCH` without `scope` keeps the grant's
scope. `cld mail access grant|set` and `cld mail admin mailbox access grant|set`
take `--scope assigned`, and `cld mail ls` shows each mailbox's scope:

```bash
cld mail access set <mailbox-id> --group "Reply Team" --permission write --scope assigned
```

Such people:

- see no mail until a conversation is assigned to them, then that
  conversation with all its messages, including later replies;
- see only the folders that hold one of their conversations, and counts,
  search, the overview, live updates, Assistant actions, and `cld` cover only
  their conversations;
- with `read`, comment, set personal reminders, and show that they are viewing;
- with `write`, also reply and forward with drafts, attachments, and scheduled
  sends, change mail state, move, delete, choose existing tags, edit the summary,
  and mark done or snooze their conversations, but never compose new mail or
  recover a failed delivery as a new message, assign anyone, use the mailbox's
  recipient suggestions, manage tags, folders, or settings, or merge and split
  conversations.

Every other conversation, message, draft, and attachment answers 404 to them,
as if it did not exist, and they see and cancel only the commands they started.
A reply draft or scheduled send disappears for them, and a scheduled send no
longer goes out, once the message it answers or sends moves to a conversation
they cannot see.
A link to a folder without one of their conversations opens that folder empty,
while a link to a folder that does not exist opens the mailbox, so such a link
tells them only that the folder exists, never its name or content. When an
assignment ends, access ends at once: lists,
open views, search, attachment downloads in progress, reminders, and queued or
scheduled actions they started for the conversation stop. A person with
mailbox-wide access keeps it; an additional assigned-only grant changes
nothing. Older Mail images ignore assigned-only grants and treat these people
as having no access.

## Manage automation access

An incoming automation that uses Spaces actions needs its creator's authorized
background access. Disabling or deleting the automation pauses or revokes that
access. Missing or revoked access stops its actions.

Mailbox administrators can pause or delete another person's automation, remove
its Spaces actions, or make cosmetic changes. Changing a definition that keeps
Spaces actions, or enabling it again, requires the original author. If Cloud
denies that change, ask the author to authorize it rather than bypassing the
check. Cosmetic edits do not restore paused or revoked access.

## Re-run failed incoming automations

A backfill skips every message that an earlier backfill already handed to the
same automation version, even when that run failed or was canceled. To run such
messages once more, a mailbox administrator starts a retry backfill:

```bash
cld --json mail automation backfill start <automation-id> --revision <revision> --retry-failed --yes
cld --json mail automation backfill status <automation-id> <operation-id>
```

A retry backfill takes only messages whose latest run of the current automation
version ended `failed` or `canceled` before the retry started, whether that run
came from new mail or from an earlier backfill. It never repeats a run that
succeeded, needs attention, or is still running. Like a normal backfill, it
hands over at most 100 messages: while the status says `limited`, start another
retry backfill. Each message runs at most once per retry operation.

A retry runs the whole flow again, including the steps that succeeded before
the failure. Steps that set a state, such as moves, flags, assignment, status,
tags, the summary, or a Spaces link, set the same state again. Steps that
create something on every run would create it a second time, so Cloud refuses
a retry backfill for flows that add internal comments, create reply drafts, or
create Spaces events. A run that moved its message before it failed is not
retried, because the message is no longer where that run found it.

To repair failed runs, use retry backfills alone. A normal backfill is for
messages that arrived before the automation was active: it hands over every
matching message that no earlier backfill of this version handed over,
including messages the automation already processed on arrival, so their steps
run again. After a retry backfill, the automation menu in Mail settings offers
**Retry failed messages** to continue with another retry. **Automations >
Activity** shows how the new runs ended.

## Write signatures and snippets

The composer shows **Signature** below your text when a signature is available.
New messages, replies, and forwards start with the sender's default; a personal
default takes precedence over the mailbox default. Choose another signature or
**No signature**. Switching the sender switches to that sender's default.

Signatures stay separate from the editable text. Preview and the sent message
show the signature after your text. When you write above a quoted reply or a
forwarded message, the signature goes between your text and that message. The
copy in the provider's Drafts folder contains only your text, so add a
signature yourself if you send the draft from another mail program. Opening an
older draft moves a recognized signature out of the text into the signature
choice. Mail still warns before sending about placeholders left in the text.

Use Markdown and Liquid in signatures and snippets. Type `/` to insert snippets
only. Mail fills in snippet values when you insert them; signatures keep their
variables until preview and send.

Each mailbox can have one logo. In Mail, open the mailbox's **Settings → Writing → Logo**
to upload or replace it, change its display width or alt text, or remove it after
confirmation. These changes require **Manage** access; people with **Edit** access
see the logo and its values read only. Changing the width or alt text stores a new
version with the same image. Alternatively, upload it with
`cld mail compose logo set --file logo.png`.
Use `{{ mailbox.logo }}` in any signature to place it in new messages,
replies, forwards, and older signatures still marked in the body. Mail sends
the logo as an inline image part referenced by `cid:`, never as a remote link.
The API, CLI, and composer previews show the same image bytes. In plain text,
the placeholder becomes the logo's alt text. In snippets it stays empty.
Use the logo tag alone: filters, conditions, and assignments using `mailbox.logo`
are rejected. Whitespace variations such as `{{mailbox.logo}}` and
`{{- mailbox.logo -}}` are supported. Each image occurrence counts toward the
same preview and send size limit; reduce repeated logos if the message is too large.

Upload a PNG or JPEG of at most 100 KiB (102400 bytes) and 1200×400 pixels.
Mail removes private image metadata, including camera and GPS details, before
storing the logo. JPEG files marked as rotated are rejected; save the image upright first.
Display width defaults to 200 px; `--width` accepts 1–600 px. Alt text is
required and defaults to the trimmed mailbox name; use `--alt` to change it
(1–200 characters, no control characters). `cld mail compose logo get` shows
the current logo; `cld mail compose logo remove --yes` removes it. Without a
logo, the placeholder stays empty and preview warns that the logo is missing.
The provider's Drafts copy has no signature and therefore no logo. A message
keeps the logo it had when it was queued for sending, including scheduled
messages and retries, even if an administrator later replaces or removes the logo.

API and Assistant clients choose the signature with `signatureTemplateId` on
draft create, update, or patch. Pass a template ID for that signature or `null`
for none. Omit the field to use the sender's default on create or keep the
current choice on update or patch. Never write a signature into the body.

| Variable | Value |
| --- | --- |
| `actor.display_name` | Name of the person who previews or sends the message, or inserts the snippet; a user-bound service account uses the name of its user, another service account its own name, other automations "Mailbox automation" |
| `actor.email` | Email address of the person in actor.display_name; empty when there is none |
| `sender.display_name` | Display name of the sender identity, or its address when it has no name |
| `sender.email` | From address of the sender identity |
| `sender.reply_to` | Reply-To address of the sender identity; empty when not set |
| `mailbox.logo` | The mailbox logo as an inline image in signatures; empty when the mailbox has no logo and in snippets |
| `mailbox.name` | Mailbox name |
| `mailbox.description` | Mailbox description; empty when not set |
| `message.subject` | Subject of the draft |
| `message.to` | List of To addresses |
| `message.cc` | List of Cc addresses |

For example, write this signature:

```liquid
Best regards
{{ actor.display_name }}
{{ mailbox.name }}
```

To separate the addresses in `message.to` and `message.cc`, use `join`:
`{{ message.to | join: ", " }}`.

## How Mail fits Cloud

Mail owns mailbox synchronization, conversations, drafts, sending, and mailbox
automation. Cloud supplies identity, resource access, encrypted settings,
notifications, workflow infrastructure, application discovery, and shared Help
and administration surfaces. Mail also integrates with Spaces for calendar
invitations without turning Mail into the calendar owner.

## Choose the contact directory

Mail reads recipients and participant contacts from the built-in
[Contacts](/en/apps/contacts) app by default; a new or upgraded installation
needs no configuration. Cloud administrators can switch to another application,
for example a customer-management app that implements the
[contact-directory contract](/en/docs/platform/contact-directory).
**Administration → Mail** shows the current app and whether it uses the
Contacts defaults or a custom mapping; **Configure** opens the editor.

The editor stores six Mail settings. Each capability list offers only
capabilities whose published schemas match the contract, and **Save** rejects a
mapping Mail cannot use with a message on each affected field. **Use Contacts
defaults** restores the built-in mapping.

Administrators can do the same from a terminal. `cld` sends the mapping to the
same server check and exits with status 1 and the same issues when Mail cannot
use it:

```bash
cld mail admin contact-directory show
cld mail admin contact-directory candidates --app crm
cld mail admin contact-directory set --app crm --suggest customer.suggest --resolve customer.match --no-read --no-books --no-create --yes
cld mail admin contact-directory reset --yes
```

| Setting | Default | Required |
| --- | --- | --- |
| `mail.contact_directory.app` | `contacts` | Yes |
| `mail.contact_directory.suggest` | `contact.suggest` | Yes |
| `mail.contact_directory.resolve` | `contact.resolve` | Yes |
| `mail.contact_directory.read` | `contact.read` | No; empty disables **Compose email** from a contact reference |
| `mail.contact_directory.list_writable_books` | `book.list` | No; together with `create` |
| `mail.contact_directory.create` | `contact.create` | No; empty hides **New contact** |

Mail calls the selected app as the requesting person, so that app's
permissions decide which contacts appear. When the selected app is not installed
(not registered), Mail hides contact features without an error. Recipient
suggestions still come from the mailbox. The details panel has no contacts
block. **Administration → Mail** still reports the missing app.

When a registered app stops briefly or returns data that no longer matches the
contract, the details panel shows **Contacts unavailable** with **Retry**.
Recipient fields still offer mailbox addresses.

### Mailbox recipient suggestions

While you type in **To**, **Cc**, or **Bcc**, contact-directory suggestions come
first. Addresses known from this mailbox follow, marked with a mail icon.
They work without the Contacts app. Duplicate addresses appear once. The arrow
keys highlight a suggestion and Enter adds it.

`GET /api/mail/mailboxes/:mailboxId/recipient-suggestions?query=ada&limit=8`
returns `{ items: [{ address, displayName, lastSeenAt, writtenTo }] }`.
It requires mailbox-wide read access. Assigned-only access gets `403`.
Users and service accounts use the same route and permission check.

The query has 2–320 characters after trimming. The limit defaults to 8 and has
a maximum of 20. Mail reads the newest 2,000 messages of the mailbox. Within
them, it skips messages with no live placement or with any live Junk or Drafts
placement, so those messages still count toward the 2,000. It also skips this
mailbox's sender and reply-to identities. Addresses the mailbox wrote to come
first; recency and frequency decide the remaining order. Older correspondents
come from the contact directory.

## Find detailed product help

Open **Help** inside Mail for account setup, search, reading, composing,
collaboration, incoming automations, workflows, administration, and
troubleshooting.
Developers can read [Resource authorization](/en/docs/identity/authorization),
[Notifications](/en/docs/platform/notifications), and
[Workflow overview](/en/docs/automation/workflow-overview) for the shared
contracts Mail adopts.

## Automate Mail from the terminal

`cld mail` covers everyday mail with the same short verbs as other Cloud
modules. A mailbox is its ID or exact name, and a folder is
`<mailbox>:<path>` with `/` between folders, the same path the web app shows.
Conversations, messages, and drafts are their IDs. A name or path that matches
several resources fails with status 409 and lists every candidate; Mail never
picks one:

```bash
cld mail ls --json
cld mail ls "Support:Projekte / 2025" --view mine --json
cld mail show <conversation-id> --json
cld mail cat <message-id>
cld mail search --any "renewal" --json
```

Triage takes up to 50 conversation IDs at a time. Archive, move, read, flag,
and trash act on the conversation's messages in the Inbox unless `--in` names
another folder:

```bash
cld mail assign <conversation-id> <conversation-id> --to me
cld --json mail done <conversation-id> <conversation-id>
cld mail reopen <conversation-id>
cld mail archive <conversation-id> <conversation-id>
cld mail mv <conversation-id> --to "Support:Projekte / 2025"
cld mail tag add <conversation-id> --tag Priority
cld mail rm <conversation-id> --yes
```

`assign --to maria,me` adds people to the conversations and keeps the others;
`--replace` replaces them, `--remove maria` removes one, and `--to none`
removes everyone. `cld mail conversation users` lists who can be assigned.

`done` and `reopen` need no revision. Done also covers messages Mail still
loads. Each result reports `ok` with the resulting status and revision, or
`not_found` for a missing or invisible conversation. Partial results exit with
status 1. For bulk cleanup, see [Make a clean start with old conversations](#make-a-clean-start-with-old-conversations).
Lists return `items` and `nextCursor`; pass `--cursor` to read another page.

API clients can undo the move commands returned by a conversation action with
`POST /api/mail/mailboxes/{mailboxId}/conversations/{conversationId}/actions/undo`
and `{ "commandIds": ["<command-uuid>"] }`. The request requires write access
and a visible conversation, and accepts at most 500 command IDs, the bound for
one conversation action. Every command must be a move by the requesting actor
for a message of that conversation in that mailbox; otherwise the whole
request is refused. Resource IDs are public short IDs; command IDs remain UUIDs.

Results follow the requested order. `cancelled` means the queued move was
stopped before it ran; `reversed` includes an inverse command's `id`, `state`,
and `code` to follow through command outcomes. Mail records an accepted Undo
per command. `pending` means the server finishes it itself once the original
move settles and its destination copy is known; the client may stop asking.
When the provider did not report the new copy, Mail finishes after a folder
sync, within about a minute of that copy appearing. A recorded Undo finishes
within 15 minutes of the first request; otherwise it answers `unavailable`,
also when the original settles later. A paused or disconnected mailbox keeps
it `pending` within that window.
A failed or cancelled original resolves as `not_applied`. Repeated requests
and concurrent clients get the same single inverse. `unavailable` also means
Mail cannot safely reverse the move, for example because it needs attention
or current access or keep rules refuse the inverse. Each
inverse is queued independently, so one refusal does not prevent the others.

`reply` and `forward` create a draft from a conversation's latest message, and
`send` sends a draft:

```bash
cld mail reply <conversation-id> --body "Thanks, it is on its way." --json
cld mail send <draft-id> --wait
```

Administration, providers, identities, automations, and operator commands keep
their group names, such as `cld mail admin` and `cld mail provider`. Run
`cld mail help` for the full list. The renamed commands are listed in
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#mail-cli-commands).

`--any` searches every indexed Mail field, including text extracted from
supported attachments in a traced background job. Attachment matches identify
the file and show a bounded excerpt; an explicit body search excludes
attachment text, and `--attachment-name` searches only filenames.

Agents and other Cloud clients can inspect one attachment's current extraction
status and page through already persisted text with the public Mail Capability:

```bash
cld capabilities query mail attachment.read-content \
  --input '{"id":"<attachment-id>","offset":0,"length":16384}' \
  --json
```

This Query rechecks current mailbox access, never parses a document inline,
and labels extracted Markdown as untrusted email content. Continue with the
returned UTF-8 byte `nextOffset`; a pending or terminal status returns metadata
without invented content.

Mail Capability lists return compact resource views with the fields needed to
choose the next operation. Conversation and message rows include bounded content
previews, so an agent can select relevant results without reading every message body.
`conversation.read` includes the shared summary, collaboration state, local tags,
and the five latest message previews. Use `message.list` to page through the
complete history and `message.read` only for an exact body. Attachment metadata
and extracted content remain separate bounded reads.

Run `cld mail help` for mailbox, conversation, message, collaboration,
provider, automation, and workflow commands. Run `cld mail <command> --help` before a
mutation or delivery operation to read its current fields and safety checks.

To clean up existing mail from one sender or domain, check the count with `cld mail sender preview --match domain --value example.com`, then run `cld mail sender move --match domain --value example.com --destination archive --yes`. Use `--destination trash` or `--folder <name-or-id>` for other targets and `--match sender` for one address. Moving needs write access. Like incoming automations, it matches the first From address and never the mailbox's own sender addresses. It leaves mail in Sent, Drafts, Trash, and Junk where it is, and it does not move kept conversations to Trash. On Gmail, it moves each message once from the Inbox, so Archive removes only the Inbox label and a folder replaces it with that label; only Trash and Junk also take archived mail from All Mail. Each call queues at most 500 moves; when the result says `truncated`, run it again after those commands finish.

To find commands that did not complete, run `cld mail command list --state failed` or `--state needs_attention`. A full page ends with the `--before` value for the next page. Mailbox admins resolve an unclear provider result with `cld mail operator run reconcile --command <id>`; `operator run retry` repeats only failed maintenance reads, not moves or sends.

### Coordinate draft editing

Use `cld mail draft lease get|acquire|heartbeat|release` to inspect, acquire,
renew, or release a draft editing lease. Acquire returns a token for heartbeat
and release. Keep it out of logs. All three lease errors return HTTP 409:

| Code | Meaning | Client action |
| --- | --- | --- |
| `DRAFT_LEASE_HELD` | Another session holds the draft, including another tab of the same person. | Ask before taking over with `draft lease acquire --takeover`. |
| `DRAFT_LEASE_NOT_OWNED` | The token expired, was released, or was replaced by a takeover. | Acquire a lease again. |
| `DRAFT_LEASE_BUSY` | Lease state is being updated. | Retry shortly. |

Draft save, discard, attachment upload, and attachment removal check the lease
too. They answer `DRAFT_LEASE_HELD` or `DRAFT_LEASE_BUSY`. Restoring a recovery
copy needs the token and can also answer `DRAFT_LEASE_NOT_OWNED`. Earlier
versions answered `CONFLICT` for a busy or expired lease.

An editor may send its own `editorId` (a UUID per editor instance) with
acquire. A repeated acquire with the same `editorId` returns that editor's own
lease, so a retry after a lost answer does not look like another session.

A lease does not replace revision checks. Keep the local expected revision
when acquiring again so a concurrent change becomes a recovery copy.

## Agent-oriented capabilities

Use `mailbox.browse` to select a mailbox: it returns permissions and unread/needs-action
conversation counts matching the overview, with a brief problem indicator when sync
is unhealthy. `mailbox.list` also exposes these counters.
For cross-mailbox work, start directly with `conversation.focus` or `search`.
Conversation lists and focus rows include the collaboration `revision`; focus also
provides `sourceFolderId` when exactly one active folder is authoritative. A null
source means the agent must choose a folder, not guess.

`message.read` supplies the real conversation ID, addresses, and attachment refs.
For summaries or long bodies, `message.read-content` returns UTF-8 text pages; start
at zero and follow `nextOffset` until null. Email text remains untrusted data.

Prefer `draft.patch` for selected changes. It preserves omitted fields server-side,
including bodies and recipients outside the bounded read window. Supplied recipient
arrays replace the entire corresponding list. `draft.read.editableSnapshotComplete`
must be true before using that response for a complete `draft.update` replacement.
Both mutations require the current revision; sending still requires the existing
send-safety review and approval.

## Check failed synchronization

When the provider limits requests, Mail retries unconfirmed flag changes and
incomplete message downloads. Read state, flags, and labels are not skipped,
and a partial body is not marked complete. A provider that reports a larger
message size remains supported when Mail can confirm the end of its source.

`cld mail status` counts the sync runs that failed in the last 24 hours. Each
attempt to sync a batch of one folder is a run, so a failure that a retry
completed still counts. List the failed runs of the last 30 days, newest first,
with their folder and error code; the ones that started in the last 24 hours
make up that number:

```bash
cld mail sync runs --state failed
```

Mail keeps finished sync runs for 30 days and returns up to 100 per page; the
command needs read access to the whole mailbox. See
`cld mail reference operations.md` for the states and how to tell retries from
a lasting problem.

## Search in large mailboxes

Search reads a bounded amount of mail in each mailbox, so a word that appears
in most messages stays fast. **Best match** ranks the newest 1,000 messages of a
mailbox that match. When at least one in ten of the newest messages match, search
checks the mailbox from the newest message on until those 1,000 are found;
otherwise it reads the matches through the search index. Add a more specific
word, or choose **Newest first**, to reach older matches.

Cloud search and the `search` capability search up to four mailboxes at a time.
Each mailbox has three seconds, and the whole search has six. A mailbox's search
stops its database work once its time is spent, and only then does the next
mailbox start. A mailbox that fails or runs out of time is left out and logged
as `Mail search skipped a mailbox` from `mail:search`; the other mailboxes'
results are still returned. The result's `summary` then names the mailboxes
that could not be searched, for example `Results from 5 of 6 mailboxes; “Sales”
could not be searched.` When no mailbox that answered has a match while one was
left out, the search fails with that mailbox's error, so Cloud search shows Mail
as failed instead of empty. A search that runs out of time fails with
`BAD_INPUT` and `Search query exceeded the execution limit`, not with an
internal error.

BM25 ranking with `pg_textsearch` is optional; Mail creates its index when the
extension is installed. Once the index exists, Postgres must keep the library
preloaded. See
[Optional Mail search ranking](/en/docs/operations/deployment-requirements#optional-mail-search-ranking).

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.


## Commands in global search

**Compose email** opens the Mail compose flow. A contact-context Command first
loads the contact from the configured contact directory with your current
permissions; choose an address when the contact has several. Mail still asks for a writable mailbox and verified sender.
Nothing is sent automatically.

Creating a task or event from a conversation now opens the existing Spaces
form. The source conversation appears as a removable link before submission.
After saving or canceling, you return to the conversation with your Mail
filters preserved.
Calendar invitation, RSVP, and delivery workflows keep their existing behavior.

## Actions in Cloud search

Cloud search exposes reply, reply-all when applicable, and forwarding for the selected conversation. An open details panel also supplies assignment and a personal reminder. These actions open the existing composer or controls; they never send an email automatically.

Available keyboard shortcuts appear next to actions and in Layout Help.

Cmd/Ctrl+Shift+K searches conversations across accessible mailboxes. Cmd/Ctrl+Alt+N opens a new email from the current writable mailbox. R opens a reply to the selected conversation outside input fields; it never sends it. Search actions update the open palette in place. Actions for the selected object appear before page actions.

## Check the complete message before approval

When the Assistant asks to send or change a draft, choose **Read the complete proposal** to inspect the full proposed text, recipients and attachment list. The proposal can include unsaved changes. The draft link opens the current draft, which may have changed since the question was asked.

If the sending content changes after your check, Mail stops and queues no message. Open the draft, check it again and approve a new attempt. A signature that changes with the current time may need editing first. Mail does not retry or approve the new content automatically.
