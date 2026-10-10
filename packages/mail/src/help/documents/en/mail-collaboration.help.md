---
id: mail-collaboration
title: Work together in a mailbox
icon: ti ti-users
description: Assign work, coordinate replies, comment internally, and understand access levels.
order: 40
---

Cloud collaboration stays attached to a conversation, while the email itself stays normal provider mail. Open **Conversation details** to see the shared follow-up state apart from your private personal reminder.

The conversation reader quietly places meaningful collaboration and workflow changes between the messages, in time order. It updates them while the conversation stays open. Each row names the person or workflow that made the change. The longer list of recent activity stays in **Conversation details**. Low-level processing events do not interrupt the message history.

## Use ownership and follow-up consistently {icon="route"}

- **Assignees** shows the people who are responsible for the conversation. A conversation can have up to 20 assignees. Add or remove them in **Conversation details**. When someone else assigns a conversation to you, you get a Cloud notification that opens it.
- To add one person to several conversations, select the conversations in the list and choose **Assign**. Then choose the person. The other assignees stay assigned. The person gets one notification for the whole selection.
- The same menu offers **Assign to me**, **Remove me**, and **Remove all assignees**. Assigning yourself or removing someone sends no notification.
- **Assigned to me** lists every conversation that you are assigned to. **Unassigned** lists the conversations that have no assignee who can still work on them.
- Mail sets the next step. **Needs action** means that the team must review or act. **Waiting for reply** means that a confirmed human reply was sent and the next step belongs to someone else.
- **Mark as done** is the only follow-up state that you set by hand. Choose it when no current action remains. Clear it to open the conversation again. Mail then takes the next step from the latest verified message.
- **Show later** removes the conversation from active work for a time and keeps its next step. Use it when the next review depends on time, not on another person. The conversation stays under **Later** until the selected time. New incoming mail makes it appear immediately.

New incoming mail changes any conversation to **Needs action**. A confirmed human reply or reply-all changes it to **Waiting for reply**, and a new message that you write starts there. Automatic replies, forwards, retries, failed sends, and unclear delivery results do not set a new next step.

Treat **Done** as a team state, not as an email archive action. Marking a conversation done or opening it again also removes it from **Later**.

## Add internal comments {icon="point"}

Internal comments are visible to people who can read the mailbox and are never sent to email recipients. Use them for handoffs, decisions, and shared context. Mail does not notify single people about comments. When one collaborator is responsible for the next step, assign the conversation.

You can edit or delete your own comments for 10 minutes after posting. Comments of workflows and of other people cannot change, also not for people with **Manage** access. A deleted comment leaves a marker in the thread, so the event does not silently disappear from the team history.

## Use personal reminders and presence {icon="route"}

**Personal reminder** is private to you. When you clear or change it, the reminders of other collaborators stay as they are. When the reminder is due, Mail creates a Cloud notification, if you still have access to the mailbox.

When live presence is available, **Active collaborators** shows the people who are viewing the conversation or writing in it now. Presence is only a hint. The shared draft lease decides who can edit a draft. While someone holds it, Mail rejects draft changes from everyone else until one of them takes over.

## Understand access levels {icon="shield-lock"}

You give access to the mailbox in **Settings → Access**. Everyone who can view the mailbox sees who has which access in **Mailbox details**: the (i) button next to **Compose**. People with **View** access see **About this mailbox** in its place. Guest accounts see only their own access and the access of their groups there.

| Access | What it allows |
| --- | --- |
| View | Read and search mail, download attachments, view collaboration context, write internal comments, and use personal reminders |
| Edit | Everything from View, plus compose and send, change provider mail state, assign work, mark conversations done or open them again, choose when a conversation appears again, and change conversation tags |
| Manage | Everything from Edit, plus connections, identities, folder mappings, shared settings, access, response policy, workflows, and mailbox deletion |
| View assigned only | Everything from View, but only in the conversations assigned to the person |
| Edit assigned only | Reply to and act on the conversations assigned to the person, within the limits in the next section |

You give access with the standard Cloud access editor to the supported people, groups, or service accounts. When you remove access, the change applies to the whole mailbox, including open live views and future actions of agents or service accounts.

## Give access to assigned conversations only {icon="user-check"}

Choose **View assigned only** or **Edit assigned only** for a person or group in **Settings → Access** when they must work on selected conversations without seeing the rest of the mailbox. Examples are a freelancer or another team. In a group, each member sees the conversations that are assigned to them.

- They see no mail until someone with **Edit** or **Manage** access assigns a conversation to them. Then they see that conversation with all its messages, also replies that arrive later. They also see its attachments, comments, and activity.
- The folder list shows only the folders that contain one of their conversations. Every count includes only their conversations. Search, **Assigned to me**, the Mail overview, Cloud search, Assistant, and `cld` work the same way.
- With **Edit assigned only**, they can reply, forward, mark as read or done, move, comment, and add existing tags in their conversations. They cannot write new messages, assign anyone, create tags or folders, merge or split conversations, or change mailbox settings.
- When an assignment ends, the conversation disappears for them immediately: from lists, open views, search, downloads, and notifications. Mail no longer carries out the replies and actions that they queued for it, including scheduled sends.

A person who also has **View**, **Edit**, or **Manage** access to the whole mailbox keeps it. The access to assigned conversations only then changes nothing for them.

## Use Contacts context {icon="address-book"}

Open **Conversation details** to see Contacts whose email addresses exactly match visible conversation participants. Multiple Contacts can match the same address. Mail shows every match that you can currently read and does not choose between them or merge them.

The **Related Mail** action on a Contact card opens an exact search with its own URL for that participant in a new tab. The separate **Related mail** section of the conversation uses shared participants and normalized subjects and explains every match.

If an external participant has no matching Contact, choose **New contact** and choose a writable contact book. Mail creates the Contact there with the shown name and email. Mail shows no button for an address that already matches a Contact that you can read. This also applies to matches that are not on the first result page.

Mail stores no Contact ownership, notes, bank details, access entries, or other private fields. Each time you open the details panel, Mail asks Contacts for a limited set of participant data. Cloud administrators can switch this section to another contact directory app; see **Choose the contact directory**. Mail shows **New contact** only when that app supports creating contacts.

The CLI shows matches for the conversation through `cld mail conversation related`, and Contacts context through `cld mail conversation context`. It shows the Contact-aware history through `cld mail conversation contact-history`.

## Link conversations to Spaces {icon="link"}

Open **Conversation details** to link the conversation to an existing Space task or event where you have **Edit** access. You can also create a linked task or event directly. The Space item owns the link. The link therefore stays intact when a group has access to the mailbox or Space and one person leaves the team.

Mail shows only Space items that you can currently view. It offers link targets only where you have **Edit** access. When you open a linked Mail conversation or Space item, that app checks your current access again. A removed or inaccessible target can therefore stay as an unavailable label until someone with **Edit** access to the Space removes the link.

For an open conversation, Cloud search also offers **Link this conversation to a task or event**. Choose an existing Spaces entry. Mail keeps the conversation open.

## Know what is shared and what is private {icon="shield-lock"}

Shared across the mailbox:

- messages and provider folders that the connected account shows,
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

For draft behavior and what a takeover does, see [Write and send messages](/app/mail/help/mail-compose).
