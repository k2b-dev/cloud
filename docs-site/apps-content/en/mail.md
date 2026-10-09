---
title: Mail
navTitle: Mail
section: Work
order: 110
description: Connected mailboxes with search, team context, reliable sending, and automation.
tags: [mail, email, collaboration]
updated: 2026-10-06
---

# Mail

Mail connects email accounts and turns their messages into a shared workspace.
It keeps portable mail state synchronized with the provider while adding team
context such as assignments, comments, local tags, reminders, and follow-up state.

## Use Mail

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
  recurring mailbox work.

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

## Delete and restore a mailbox

The Mail overview lists your mailboxes in a sidebar with their unread and
needs-action counts; opening one enters its workspace. The page itself is the
cross-mailbox focus queue (for me, unassigned, waiting, all active) with
**Compose** as its primary action.

People can pin a mailbox to the top of that sidebar or hide one they rarely
need. A hidden mailbox moves to a collapsed **Hidden** section, and its
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

## Manage automation access

An incoming automation that uses Spaces actions needs its creator's authorized
background access. Disabling or deleting the automation pauses or revokes that
access. Missing or revoked access stops its actions.

Mailbox administrators can pause or delete another person's automation, remove
its Spaces actions, or make cosmetic changes. Changing a definition that keeps
Spaces actions, or enabling it again, requires the original author. If Cloud
denies that change, ask the author to authorize it rather than bypassing the
check. Cosmetic edits do not restore paused or revoked access.

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
permissions decide which contacts appear. When the app is missing, stopped, or
returns data that no longer matches the contract, Mail degrades exactly as when
Contacts is unavailable.

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
cld mail archive <conversation-id> <conversation-id>
cld mail mv <conversation-id> --to "Support:Projekte / 2025"
cld mail tag add <conversation-id> --tag Priority
cld mail rm <conversation-id> --yes
```

A conversation can have up to 20 assignees. `assign --to maria,me` adds users;
`--to maria --replace` replaces the set, `--remove maria` removes a user,
and `--to none` clears it. `conversation update --assignee` replaces the set
and accepts repeated flags or comma-separated users.

`conversation users` lists eligible active users: those with mailbox-wide
write/admin access or assigned-only read/write grants, directly or through
groups. Platform administrator status alone does not confer eligibility.
Changing assignees requires mailbox-wide write/admin access. Each newly added
user receives one notification per request; self-assignment and removal send
none. A limit or eligibility failure leaves the entire assignment batch unchanged.

API and capability consumers use `assigneeUserIds` arrays and assignment modes
`add`, `remove`, and `replace`. Assignment capabilities need no revision;
the collaboration PATCH still requires `expectedRevision`. Collaboration returns ordered `assignees`;
batch results resolve the users named in the request. Workflow action
`assignConversation` keeps its single `user` configuration: a user replaces
the set with that user, and `null` clears it. “Mine” includes conversations
assigned to the current user; “Unassigned” includes conversations with no
eligible assignee. Operators can run an older Mail image after this update;
it shows the earliest assignee from each set.

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
