---
id: mail-start
title: Start with Mail
icon: ti ti-mail-plus
description: Understand mailboxes, connect an account, and reach a safe first sync.
order: 10
---

Mail organizes email around **mailboxes**. A mailbox connects one email account and contains the folders of that provider. It also sets who can view, edit, or manage it.

The email provider stays the source for portable mail state. When you move a message, change its read state, flag it, or send mail, other mail clients for the same account can show the change. Cloud adds data for collaboration: assignees, internal comments, local tags, reminders, and follow-up state. Other mail clients do not show these Cloud details.

## Choose the right starting point {icon="square-plus"}

- When you open Mail from the app navigation, you see **Focus**. Focus is one work queue across every mailbox that you can view.
- **For me** shows conversations assigned to you that need action. **Unassigned** shows work that needs action and has no assignee who can still work on it.
- **Waiting** shows your assigned conversations that wait for a reply. **All active** shows every unfinished conversation that you can view and that is not in **Later**.
- Each mailbox button shows how many conversations need action. A dot on the mailbox icon means unread conversations outside Trash and Junk. Point at the button to see both exact counts.
- Open a mailbox when you need folders, a search across the mailbox, or settings.
- Choose the flag next to a mailbox to pin it to the top of the list.
- Choose the crossed-out eye to hide a mailbox that you rarely need, such as a no-reply address. The mailbox leaves the list, and its conversations leave Focus and the Focus counts.
- Hidden mailboxes wait under **Hidden** below the list. Open that section to reach one, and choose the eye to show it again.
- Your pinned and hidden mailboxes apply on every device where you sign in. They are yours alone. Others with access to a mailbox keep their own.
- On a large screen, select a Focus row to see its context, summary, workflow fields, and team notes next to the queue. On a smaller screen, the row opens the conversation in its mailbox.
- Choose **New mailbox** to connect another email account.
- A new mailbox starts private. You have **Manage** access, and nobody else has access until you give it in **Settings → Access**.

Focus does not copy or move mail between mailboxes. Each row keeps its source mailbox. When you open a row, Mail checks your current access to the mailbox again.

## Connect your first mailbox {icon="square-plus"}

:::steps
1. Choose **New mailbox**.
2. Enter a **Name** that collaborators recognize. The **Description** is optional.
3. In the settings dialog, open **Accounts & identities** and connect the account.
4. Enter the email address and choose **Find settings**. You can also enter the IMAP and SMTP hosts, ports, and TLS modes yourself.
5. Enter the password or app password that your IMAP/SMTP provider accepts.
6. For a normal mailbox, leave **Use this address for sending** turned on.
7. Choose **Verify and connect**.
:::

Mail verifies IMAP and SMTP separately before it saves the credentials. Mail encrypts the credentials, and nobody can read them back after saving: no mailbox user and no administrator. Mail offers no browser authorization and no automatic token renewal. Replace manual tokens when they expire. Your provider must allow the IMAP/SMTP authentication method that you choose.

After setup, Mail finds the folders of the provider and starts synchronization. Older messages can appear step by step while you already use the mailbox. Open **Mailbox tools → Mailbox health** to see the connection health, folder discovery, synchronization, and search state.

## Check that sending is ready {icon="send"}

Open **Settings → Accounts & identities → Sending identities**. An identity groups everything that Mail uses for one sending context:

- **Identity label** is visible only in the mailbox. It helps collaborators choose the right context, such as “University” or “Private”.
- Recipients see the **Display name** and the **From address**.
- A normal connection creates a default identity for the account address.
- Mail can send with an identity only after it is verified. Two identities can use the same From address and keep different defaults.
- **Automatic replies** is a separate setting of each identity. It is on by default for new identities. Mail sends automatic mail only after someone with **Manage** access creates and turns on an automatic reply or a workflow.

## Find your way in the mailbox {icon="layout-grid"}

The left navigation contains:

- **Compose** at the top, when you can send. The **Mailbox details** button (i) is next to it. If you can only view the mailbox, **About this mailbox** takes that place and opens the same details. On a phone, these are in the first row of the app menu.
- **Follow-up** for Needs action, Waiting for reply, Later, and Done.
- **Assignment** for Assigned to me and Unassigned.
- **Mail** for Inbox, Drafts, Scheduled, Sent, and a **More** group that you can expand.
- **Folders** for custom provider folders and their nested hierarchy. With **Manage** access, you can hide folders here. Hiding does not delete a folder or unsubscribe from it.
- **Tags** to open every conversation with a mailbox-local tag. This section appears only when at least one tag exists.
- **Saved views** that people created from reusable mailbox and collaboration filters. This section appears only when at least one view exists.
- **More** for All mail, Recent activity, Archive, Trash, and Junk. All mail combines the mailbox except Trash and Junk. More opens automatically when one of these destinations is active.
- **Mailbox tools** for synchronization, health, automations, mailing lists, remote images, shared links, and browser email-link handling. The tools that you see depend on your access.
- **Settings** at the bottom, when your access allows it.

**Mailbox details** shows everyone who can view the mailbox the same overview. People with **View** access see it as **About this mailbox**. The overview shows:

- the addresses of the mailbox, each with a copy button;
- the connection and when Mail last synchronized;
- the number of folders;
- your own access, and who has which access.

Group rows list the people that the group reaches, as far as your account can see them. Guest accounts see only their own access, the access of their groups, and how many other entries exist. The dialog changes nothing. With **Manage** access, choose **Manage access** to continue in **Settings → Access**.

The center list shows one row per conversation. The reader groups the messages of that conversation. It quietly places meaningful status, assignment, tag, summary, and workflow activity at the time it happened. Technical processing events stay out of the reading flow.

Choose **Conversation details** to open team context, local tags, ownership, comments, reminders, and the longer list of recent activity. To get more reading space, hide the conversation list.

Next to a composer, the conversation history contains only messages. Operational activity does not distract you while you write.

## Answer calendar invitations {icon="calendar-event"}

Mail recognizes `.ics` and `text/calendar` attachments up to a size limit, but **Spaces remains the calendar**. Expand an invitation to see its organizer, schedule, location, and current status.

- **Add without reply:** Add the event to a Space where you have **Edit** access, without replying.
- **Reply:** Choose **Accept**, **Maybe**, or **Decline**. Mail saves or updates the event and prepares a response in one step.

Every response opens as a Mail draft that you can edit. Mail does not say that the organizer was notified until you send the draft through the normal composer.

If the draft fails after Mail saved the event, Mail reports this partial result. A retry updates the same event and does not create a duplicate. If Spaces or the required capability is unavailable, Mail hides the calendar controls. The original calendar attachment stays available like any other file.

## Continue with a task {icon="point"}

- [Read, search, and organize mail](/app/mail/help/mail-work)
- [Write and send messages](/app/mail/help/mail-compose)
- [Work together in a mailbox](/app/mail/help/mail-collaboration)
- [Set up and manage a mailbox](/app/mail/help/mail-admin)
- [Automate responses and mailbox work](/app/mail/help/mail-automation)
- [Mail workflow YAML reference](/app/mail/help/mail-workflows)
- [Troubleshoot Mail](/app/mail/help/mail-troubleshooting)
