---
id: mail-start
title: Start with Mail
icon: ti ti-mail-plus
description: Understand mailboxes, connect an account, and reach a safe first sync.
order: 10
kind: start
---

Mail organizes email around **mailboxes**. A mailbox connects one email account and contains the folders of that provider. It also sets who can view, edit, or manage it.

The email provider stays the source for portable mail state. When you move a message, change its read state, flag it, or send mail, other mail clients for the same account can show the change. Cloud adds data for collaboration: assignees, internal comments, local tags, reminders, and follow-up state. Other mail clients do not show these Cloud details.

## Choose the right starting point {icon="square-plus"}

- When you open Mail from the app navigation, Mail opens a mailbox directly. With one mailbox, Mail opens it. With more than one, Mail opens the mailbox that you used last in this browser, if you can still view it and did not hide it. Otherwise Mail opens your first pinned mailbox, or else the first mailbox in the list.
- Mail has no **Focus** page now. In each mailbox, **Assigned to me** shows what is assigned to you, and **Needs action**, **Waiting for reply**, and **Unassigned** are tabs too. An old link to Focus opens the same view or conversation in a mailbox. A notice at the top of the sidebar tells you this one time. Choose **Got it** to close it on all your devices.
- The open mailbox shows the counts of its views and folders. The other mailboxes show no counts.
- Choose the flag next to a mailbox to pin it to the top of the list. For the open mailbox, the flag and the eye are under **…** on its row.
- Choose the crossed-out eye to hide a mailbox that you rarely need, such as a no-reply address. The mailbox leaves the list, and Mail does not open it when you open Mail.
- Hidden mailboxes wait under **Hidden mailboxes** below the list. Open that section to reach one, and choose the eye to show it again.
- Your pinned and hidden mailboxes apply on every device where you sign in. They are yours alone. Others with access to a mailbox keep their own.
- Choose **New mailbox** to connect another email account.
- A new mailbox starts private. You have **Manage** access, and nobody else has access until you give it in **… → Settings → Access**.

To list the open work of all your mailboxes together, use `cld mail focus` on the command line. Each entry keeps its mailbox, and Mail checks your access again when you open it.

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

After setup, Mail finds the provider's folders and starts synchronization. Older messages can appear step by step while you already use the mailbox. Open **… → Mailbox health** to see the connection health, folder discovery, synchronization, and search state.

## Check that sending is ready {icon="send"}

Open **… → Settings → Accounts & identities → Sending identities**. An identity groups everything that Mail uses for one sending context:

- **Identity label** is visible only in the mailbox. It helps collaborators choose the right context, such as “University” or “Private”.
- Recipients see the **Display name** and the **From address**.
- A normal connection creates a default identity for the account address.
- Mail can send with an identity only after it is verified. Two identities can use the same From address and keep different defaults.
- **Automatic replies** is a separate setting of each identity. It is on by default for new identities. Mail sends automatic mail only after someone with **Manage** access creates and turns on an automatic reply or a workflow.

## Find your way in the mailbox {icon="layout-grid"}

The sidebar contains your mailboxes, with pinned mailboxes first. The open mailbox expands to its places:

- **Inbox**, **Drafts**, and **Sent**. **Scheduled** and **Send problems** show only while something waits there.
- **More** for Archive, Trash, and Junk. It stays open while one of these folders is current.
- Standard folders show their usual name in your language, for example **Sent** for "Sent Items". A folder with a name of its own keeps that name. The folder settings also show the name on the mail server.
- Custom provider folders and their nested hierarchy, with unread counts.
- **Hidden** after the mailbox list folds your hidden mailboxes into one row. Select it to show them.
- **…** beside **Mailboxes** holds **New mailbox** and **Deleted mailboxes**. Point at the heading or press Tab to show it.

The head contains:

- The search field of the mailbox. Press `/` to go to it. The filter button next to it holds **Unread**, **Flagged**, **With attachment**, the date range, and a tag. While you search, it also holds **Search in** and the place. A number on the button shows how many filters are on. **Reset filters** removes them.
- **…** with **Automations**, **Sync mailbox**, **Mailbox health**, and **Settings** first. Mailbox details, mailing lists, remote images, shared links, email-link handling, and the choice between conversations and individual messages follow. Your access determines the entries. Readers see **About this mailbox**.
- **Compose** as the primary action when you can send.

The tabs stand above the list and the reader: **All**, **Needs action**, **Assigned to me**, **Waiting for reply**, **Unassigned**, **Later**, **Done**, **Recent activity**, **Kept**, and saved views. The row shows as many of them as its width allows, and **More** holds the rest. **Events** stays at the end. The open view always stays visible. Folders, Scheduled, and Send problems have no view tabs.

Each row has a checkbox. Check one, and the tab row becomes the bulk actions: **Done**, **Archive**, **Delete**, **Unread**, **Later**, **Assign**, **Move**, **Tags**, and **…** with junk and flag. The checkbox at the start of the tab row selects every shown conversation. Escape or **Exit selection** brings the tabs back.

On a phone, open the mailbox title to reach other mailboxes and the open mailbox's folders. Use the head for search, filters, Compose, and **…**, and the tab row for views.

**Mailbox details** shows everyone who can view the mailbox the same overview. People with **View** access see it as **About this mailbox**. The overview shows:

- the mailbox addresses, each with a copy button;
- the connection and when Mail last synchronized;
- the number of folders;
- your own access, and who has which access.

Group rows list the people that the group reaches, as far as your account can see them. Guest accounts see only their own access, the access of their groups, and how many other entries exist. The dialog changes nothing. With **Manage** access, choose **Manage access** to continue in **… → Settings → Access**.

The list shows one row per conversation. When the list is 640 pixels wide or more, a row is one line: checkbox, star, sender, subject and preview, marks, and date. A narrower list shows three lines: sender and date, subject, and preview with marks. The marks show a draft as **Draft**, Gustav's suggestion as **✦ Suggestion**, the number of messages, **Waiting**, a snooze as a clock with its day, kept conversations, attachments, and who is responsible. The reader uses the full width beside the list. The reader groups the messages of that conversation. A long conversation shows its newest messages, and **n older messages** shows the rest. It quietly places meaningful status, assignment, tag, summary, and workflow activity at the time it happened. Technical processing events stay out of the reading flow.

**Reply**, **Reply all**, and **Forward** start the reader's toolbar, followed by the actions you chose with **… > Customize toolbar**. From tablet width on, the actions have their own row above the subject. When the reader is wide enough, they show their names. When it gets narrower, they show only their icons, then move into **…** with the actions that no longer fit. **…** always lists every action.

Choose **Details** in the mailbox head to open team context, local tags, ownership, comments, reminders, and the longer list of recent activity. On a phone, use the details icon beside **…** in the reader instead. The details stand next to the reader while it keeps enough room. With less room, they open over the reader's end.

Next to a composer, the conversation history contains only messages. Operational activity does not distract you while you write.

## Arrange the list and the reader {icon="layout-columns"}

The list and the reader share the full width. Without an open conversation, the list takes all of it. With one open, the list starts at 40 percent and the reader takes the rest.

To change the split, drag the handle between the list and the reader. You can also focus the handle and use the arrow keys, with Shift for larger steps, or Home and End. Double-click the handle or press Enter on it to return to 40 percent. Mail remembers the width for you and this mailbox. The list keeps at least 320 pixels, and the reader keeps at least 480 pixels.

The width of the list decides how its rows show: one line from 640 pixels, three lines below. The window size, the handle, and a closed reader all change it the same way. The selection and the open conversation stay where they are. On a phone, the list shows three lines, and the reader opens in its place.

The key V and the **View** menu no longer exist. The first time you press V, Mail shows this at the handle.

**Done today** counts the conversations you can see that became done during the current day in Cloud's time zone. Each conversation counts once, even if reopened. The automation count uses the actor of its latest completion today.

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
