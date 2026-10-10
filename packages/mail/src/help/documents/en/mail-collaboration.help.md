---
id: mail-collaboration
title: Work together in a mailbox
icon: ti ti-users
description: Assign work, coordinate replies, comment internally, and understand access levels.
order: 40
---

Cloud collaboration stays attached to a conversation while the underlying email remains normal provider mail. Open **Conversation details** to see shared follow-up state separately from your private personal reminder.

The conversation reader places meaningful collaboration and workflow changes quietly between messages in chronological order and updates them while the conversation stays open. Each row names who or which workflow made the change. The broader recent activity list remains in **Conversation details**; low-level processing events do not interrupt the message history.

## Use ownership and follow-up consistently {icon="route"}

- **Assignees** name the people currently responsible for the conversation; a conversation can have up to 20. Add or remove them under **Conversation details**. When someone else assigns a conversation to you, you get a Cloud notification that opens it. To add one person to several conversations, select them in the list and choose **Assign**; the others stay assigned, and the person gets one notification for the whole selection. The same menu removes you or everyone. Assigning yourself or removing someone sends no notification. **Assigned to me** lists every conversation you are one of the assignees of; **Unassigned** lists the ones nobody who can still work on them is assigned to.
- **Next step** is derived by Mail. **Needs action** means the team must review or act. **Waiting for reply** means a confirmed human reply was sent and the next step belongs to someone else.
- **Mark as done** is the only manual follow-up state. Select it when no current action remains; clear it to reopen the conversation. Mail then derives the next step from the latest verified message.
- **Show later** temporarily removes the conversation from active work without changing its next step. Use it when the next review depends on time rather than another person. The conversation stays under **Later** until the selected time; new incoming mail makes it appear immediately.

New incoming mail changes any conversation to **Needs action**. A confirmed human reply or reply-all changes it to **Waiting for reply**, and a new message you write starts in it. Automatic replies, forwards, retries, failed sends, and ambiguous delivery outcomes do not invent a new next step. Treat **Done** as a team state, not as an email archive action. Marking a conversation done or reopening it also removes it from **Later**.

## Add internal comments {icon="point"}

Internal comments are visible to people who can read the mailbox and are never sent to email recipients. Use them for handoffs, decisions, and shared context. Mail does not notify individual people about comments, so use assignment when a specific collaborator is responsible for the next step.

Comment authors can edit or delete their own comments for 10 minutes after posting. Workflow and other authors' comments stay immutable, including for mailbox administrators. Deleted comments leave a tombstone in the thread instead of silently removing the event from team history.

## Use personal reminders and presence {icon="route"}

**Personal reminder** is private to you. Clearing or changing it does not affect another collaborator's reminder. When due, Mail creates a Cloud notification if you still have access to the mailbox.

When live presence is available, **Here now** shows collaborators currently viewing or composing in the conversation. Presence is advisory. The shared draft lease remains the authoritative signal for who can edit a draft: while someone holds it, Mail rejects draft changes from everyone else until they take over.

## Understand permissions {icon="shield-lock"}

Mailbox access is granted in **Settings > Access**. Everyone who can read the mailbox sees who has which access under **Mailbox details**, the (i) button beside **Compose**, or **About this mailbox** in its place for people who may only read. Guest accounts see only their own access and their groups' access there.

| Permission | What it allows |
| --- | --- |
| Read | Read and search mail, download attachments, view collaboration context, write internal comments, and use personal reminders |
| Write | All Read actions plus compose and send, change provider mail state, assign work, mark conversations done or reopen them, choose when a conversation appears again, and manage conversation tags |
| Admin | All Write actions plus connections, identities, folder mappings, shared settings, access, response policy, workflows, and mailbox deletion |
| View assigned only | Read actions, but only for the conversations assigned to the person |
| Edit assigned only | Write actions, but only for the conversations assigned to the person, and without assigning anyone |

Access can be granted through the standard Cloud permission editor to the supported people, groups, or service accounts. Removing access takes effect for the mailbox, including open live views and future agent or service-account actions.

## Give access to assigned conversations only {icon="user-check"}

Choose **View assigned only** or **Edit assigned only** for a person or group under **Settings > Access** when they should work on selected conversations without seeing the rest of the mailbox, for example a freelancer or another team. For a group, each member sees the conversations assigned to them.

- They see no mail until someone with full mailbox access assigns a conversation to them. They then see that conversation with all its messages, including replies that arrive later, its attachments, comments, and activity.
- The folder list shows only folders that hold one of their conversations, and every count includes only their conversations. Search, **Assigned to me**, the Mail overview, Cloud search, the Assistant, and `cld` work the same way.
- With **Edit assigned only** they can reply, forward, mark as read or done, move, comment, and tag their conversations. They cannot write new messages, assign anyone, create tags or folders, merge or split conversations, or change mailbox settings.
- When an assignment ends, the conversation disappears for them at once: from lists and open views, search, downloads, and notifications. Replies and actions they queued for it, including scheduled sends, are no longer carried out.

People with full access to the mailbox keep it; additional access to assigned conversations only changes nothing for them.

## Use Contacts context {icon="address-book"}

Open **Conversation details** to see Contacts whose email addresses exactly match visible conversation participants. Multiple Contacts can match the same address; Mail shows every currently readable match and does not choose or merge them. A Contact card's **Related Mail** action opens an exact, URL-backed search for that participant in a new tab. The separate conversation-level **Related mail** section uses shared participants and normalized subjects and explains every match.

If an external participant has no matching Contact, select **Add as contact**, choose a writable contact book, and Mail creates the Contact there with the displayed name and email. No button is shown for an address that already matches a readable Contact, including matches that are not on the first result page.

Mail stores no Contact ownership, notes, bank details, access entries, or other private fields. It requests a bounded participant projection from Contacts whenever the details panel is opened. Cloud administrators can switch this section to another contact directory app; see **Choose the contact directory**. **Add as contact** is shown only when that app supports creating contacts.

The CLI exposes conversation-level matches through `cld mail conversation related`, Contacts context through `cld mail conversation context`, and the dedicated Contact-aware history boundary through `cld mail conversation contact-history`.

## Link conversations to Spaces {icon="link"}

Open **Conversation details** to link the conversation to an existing writable Space task or event, or create a linked task or event directly. The Space item owns the link, so it remains intact when mailbox or Space access is granted to a group and one person leaves the team.

Mail shows only Space items you may currently read and offers link targets only where you may write. Opening a linked Mail conversation or Space item checks that application's current permissions again. A removed or inaccessible target can therefore remain as an unavailable label until a Space writer unlinks it.

## Know what is shared and what is private {icon="shield-lock"}

Shared across the mailbox:

- messages and provider folders visible through the connected account,
- mailbox templates and mailbox default signatures,
- mailbox saved views,
- local tags,
- conversation assignment, status, the time chosen with **Show later**, comments, references, activity, and shared drafts.

Private to one user:

- private saved views,
- private signatures and snippets,
- personal signature defaults,
- personal reminders,
- device preferences such as compose format, Undo Send window, and pane layout.

For draft behavior and takeover consequences, see [Write and send messages](/app/mail/help/mail-compose).

For an open conversation, Cloud search also offers **Link this conversation to a task or event**. Choose an existing Spaces entry; Mail keeps the conversation open.
