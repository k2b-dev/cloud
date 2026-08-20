---
id: mail-start
title: Start with Mail
icon: ti ti-mail-plus
description: Understand mailboxes, connect an account, and reach a safe first sync.
order: 10
---

Mail organizes email around **mailboxes**. A mailbox connects one email account, contains the folders exposed by that provider, and defines who may read, operate, or administer it.

The email provider remains the source for portable mail state. Moving a message, changing its read state, flagging it, or sending mail can therefore appear in other mail clients connected to the same account. Cloud adds collaboration data such as assignees, internal comments, local tags, reminders, and follow-up state. Those Cloud-only details do not appear in other mail clients.

## Choose the right starting point {icon="square-plus"}

- Opening Mail from the app navigation shows **Focus**, a combined work queue across every mailbox you may read.
- Use **For me** for assigned conversations that need action, **Unassigned** for unowned work, **Waiting** for your assigned conversations waiting on a reply, or **All active** for every unfinished, unsnoozed conversation you may read.
- Each mailbox button shows its unread and needs-action conversation counts. Open a mailbox when you need folders, mailbox-wide search, or settings.
- On a large screen, select a Focus row to review its context, summary, workflow fields, and team notes beside the queue. On a smaller screen, selecting the row opens the conversation in its mailbox.
- Select **New mailbox** when you need to connect another email account.
- A new mailbox starts private. You are its administrator until you grant access in **Settings > Access**.

Focus does not copy or move mail between mailboxes. Each row keeps its source mailbox, and opening it checks your current mailbox permission again.

## Connect your first mailbox {icon="square-plus"}

:::steps
1. Select **New mailbox**.
2. Enter a **Name** that collaborators will recognize. The description is optional.
3. In the settings dialog, open **Accounts & identities** and connect the account.
4. Enter the email address and select **Find settings**, or enter the IMAP and SMTP hosts, ports, and TLS modes yourself.
5. For a configured Google or Microsoft account, select the browser OAuth button and approve access. Otherwise enter the password, app password, or OAuth2 access token supplied by the provider.
6. Leave **Create the default identity for this address** enabled for a normal mailbox.
7. Select **Verify and connect**.
:::

Mail verifies IMAP and SMTP separately before storing the credential. Credentials and OAuth refresh tokens are encrypted and write-only: after they are accepted, no user or mailbox administrator can reveal them again. Managed OAuth connections refresh automatically and show **Reconnect** when provider consent has expired or was revoked. Manual credentials remain available for every generic IMAP/SMTP provider.

After setup, Mail discovers the provider's folders and begins synchronization. Initial history can appear progressively while the mailbox remains usable. Open **Mailbox tools > Mailbox health** to see connection health, folder discovery, synchronization, and search state.

## Check that sending is ready {icon="send"}

Open **Settings > Accounts & identities > Sending identities**. An identity groups everything Mail should use for one sending context:

- **Identity label** is private to the mailbox and helps collaborators choose the right context, such as “University” or “Private”.
- **Display name** and **From address** are visible to recipients.
- A normal connection creates a default identity for the account address.
- Every identity must be **verified** before Mail can send with it. Two identities may use the same From address while keeping different defaults.
- **Automatic replies** is a separate identity permission. It is enabled by default for new identities, but automatic mail is sent only after an administrator creates and enables an automatic reply or workflow.

## Understand the mailbox workspace {icon="layout-grid"}

The left navigation contains:

- **Follow-up** for Needs action, Waiting for reply, Snoozed, and Done.
- **Assignment** for Assigned to me and Unassigned.
- **Mail** for Inbox, Drafts, Scheduled, Sent, and an expandable More group.
- **Folders** for custom provider folders and their nested hierarchy. Mailbox administrators can hide folders here without deleting or unsubscribing them.
- **Tags** for opening every conversation with a mailbox-local tag. This section appears only when at least one tag exists.
- **Saved views** created from reusable mailbox and collaboration filters. This section appears only when at least one view exists.
- **More** for All mail, Recent activity, Archive, Trash, and Junk. All mail combines the mailbox except Trash and Junk. More opens automatically when one of these destinations is active.
- **Mailbox tools** for synchronization, health, automations, mailing lists, remote images, shared links, and browser email-link handling. Available tools depend on your permission.
- **Settings** at the bottom when your permission allows it.

The center list shows one row per conversation. The reader groups the messages in that conversation. Use the **Conversation details** button to open team context, local tags, ownership, comments, reminders, and recent activity. You can hide the conversation list when you need more reading space.

## Work with calendar invitations {icon="calendar-event"}

Mail recognizes bounded `.ics` and `text/calendar` attachments, but **Spaces remains the calendar**. Expand an invitation to see its organizer, schedule, location, and current status. You can add it to a writable Space without replying, or choose **Accept**, **Maybe**, or **Decline** to save/update the event and prepare a response in one step.

Every response opens as an editable Mail draft. Mail does not claim that the organizer was notified until you send it through the normal composer. If draft creation fails after the event was saved, Mail reports that partial result and a retry updates the same event instead of creating a duplicate. If Spaces or the required capability surface is unavailable, the integration controls stay hidden and the original calendar attachment remains available like any other file.

## Continue with a task {icon="point"}

- [Read, search, and organize mail](/app/mail/help/mail-work)
- [Write and send messages](/app/mail/help/mail-compose)
- [Work together in a mailbox](/app/mail/help/mail-collaboration)
- [Set up and manage a mailbox](/app/mail/help/mail-admin)
- [Automate responses and mailbox work](/app/mail/help/mail-automation)
- [Mail workflow YAML reference](/app/mail/help/mail-workflows)
- [Troubleshoot Mail](/app/mail/help/mail-troubleshooting)
