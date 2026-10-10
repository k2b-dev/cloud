---
id: mail-work
title: Read, search, and organize
icon: ti ti-inbox
description: Find conversations, read complete threads, and change portable mail state safely.
order: 20
---

## Find the conversation you need {icon="search"}

Use **Search mailbox** for a quick search across the current mailbox. **Everything** is selected by default. It covers the synchronized message fields and extracted attachment text.

To narrow the search, use the search-in button. Choose any combination of **Sender**, **Recipients**, **Subject**, **Message body**, and **Attachment names**. With several words, a message matches when each word appears somewhere in it, for example the sender's name and a word from the subject.

For more conditions, such as dates, recipients, attachments, folders, tags, or collaboration state, choose **Search filters**.

The filter dialog shows the current search as conditions that you can edit. Choose **Add filter** for another field. When several filters are active, choose whether all filters or any filter must match. **Advanced conditions** stays collapsed until you need alternative or nested groups.

The filter dialog can search:

- From
- To or Cc
- Subject
- Message body
- Attachment name
- Internal comment
- Conversation reference
- Folder
- Local tag

Choose **Any condition** to match at least one filled field. Choose **All conditions** to require every filled field. Search filters stay in the page URL, so a reload or a shared URL keeps the current result. Choose **Clear search** to return to the unfiltered view.

Provider keywords are advanced synchronized metadata, not a normal labeling system. Existing search URLs with keywords still work, and you can still edit them. New filters use local tags for labels that people read.

Mail checks access for every search result and searches the synchronized Cloud copy. During the first sync, older messages or bodies can become searchable later, while synchronization and body loading continue.

After an attachment has synchronized, Mail extracts readable text in the background. This works for supported PDF, office document, spreadsheet, presentation, RTF, EPUB, and CSV files. The default broad search includes that extracted attachment text. A **Message body** filter searches only the email body. **Attachment name** searches file names. Files that are password-protected, scanned, unsupported, damaged, or too large stay downloadable but add no searchable text.

When extracted attachment text matches, the result names the attachment and shows a short matching excerpt. The result opens the exact message that owns it. To get the original file, use the download action on the result.

## Use follow-up, assignment, and folders for different purposes {icon="layout-list"}

The built-in **Follow-up** views show what happens next. **Assignment** shows who owns the work. Except for **Done**, these views leave out conversations that are only in Trash or Junk. Examples are spam that your provider filed there, or mail that someone deleted. When you move such a conversation back, it appears again with its next step.

| Section | View | What it shows |
| --- | --- | --- |
| Follow-up | Needs action | Conversations where the team needs to review or act |
| Follow-up | Waiting for reply | Conversations where a confirmed team reply waits for someone else. New incoming mail moves them to Needs action. |
| Follow-up | Later | Conversations hidden until the selected time. At that time, they appear again with the same next step. New incoming mail shows them immediately. |
| Follow-up | Done | Conversations marked Done |
| Assignment | Assigned to me | Conversations assigned to you |
| Assignment | Unassigned | Conversations without an assignee, or whose assignee no longer has **Edit** access to this mailbox |
| Mail / More | All mail | Mail from every provider folder except Trash, Junk, and folders whose mail stays inside them |
| More | Recent activity | Recently changed conversations |
| Mail | Scheduled | Messages that wait for later delivery |

Provider folders are a different layer. When you move a conversation to Archive, Trash, Junk, or another provider folder, the remote mail moves too. Other clients can show this. Marking a conversation **Done** changes only the Cloud follow-up state. It does not archive or move the email.

With **Manage** access, you can keep the mail of a folder inside that folder, for example a shared team folder (**Only in the folder**). Its conversations then stay out of these views and their counts:

- **Needs action**, **Waiting for reply**, **Later**, and **Done**;
- **Unassigned**, **All mail**, and **Recent activity**;
- the Mail overview (**All mailboxes**).

This does not apply when a message of the conversation is also in a folder that shows its mail everywhere, such as the Inbox. The conversations stay in the folder itself, in **Assigned to me**, and in search and saved views.

In the sidebar, a small folder symbol next to the count marks such a folder. The count still shows its unread mail. On a phone, the navigation shows **Only in the folder** below the folder name. When one of these views leaves out the mail of a folder, a hint above the list names the folder and opens it. When you close the hint, this browser hides it for that folder.

Use **Waiting for reply** when the next step of your team depends on another person. Mail sets it after Mail confirms that a human reply or reply-all was sent. This includes replies that Mail synchronized from another email client.

Use **Show later** when the next review depends on a date or time. Choose when the conversation appears again. Until that time, it stays under **Later**, outside the active views. New incoming mail ends this earlier.

Mail sets the next step this way:

- New incoming mail always changes the conversation to **Needs action** and removes it from **Later**.
- A human reply or reply-all changes it to **Waiting for reply**, but only after Mail confirms the delivery.
- A new message that you write in Cloud starts a conversation in **Waiting for reply**. So does a message that Mail finds in your Sent folder from another email client.
- Mail from your own address that arrives in the Inbox starts in **Needs action**. An example is a contact form that sends in the name of your mailbox.
- Forwards, automatic replies, retries, and unclear delivery results do not set a new next step.

A reply that you scheduled for later counts only when Mail sends it. If new mail arrives first, the conversation moves to **Needs action** and keeps its place by the newest real message. It stays in **Needs action** when the reply goes out, because you wrote the reply before that mail. Mail still sends the scheduled reply at its time, unless you cancel it under **Scheduled**.

In **Conversation details**, you decide only whether the conversation is **Done**. When you clear Done, the conversation opens again, and Mail takes the next step from the latest verified message.

Choose **Move to folder** in the conversation actions to choose a destination with the keyboard, a pointer, or touch. On a desktop, you can also drag a conversation row onto a folder in the left navigation. Mail queues the move, and synchronization confirms the result at the provider.

To act on several conversations, select their checkboxes. Hold **Shift** while you select another checkbox or row to select the loaded range between them. One selection has at most 50 conversations, so you can follow the work at the provider.

:::reference
- **Selection toolbar:** Adds tags, archives, marks as read, assigns, and moves the selected conversations.
- **More:** Marks the selected conversations unread, flags them, removes flags, moves them to junk, or moves them to the trash.
- **Partial result:** If Mail can queue only some commands, it keeps the failed conversations selected and reports each failure.
:::

Choose **Assign** to give the selected conversations to one person. Choose **Assign to me** or **Unassign**, or search the people with **Edit** access to this mailbox. Mail confirms how many conversations changed and offers **Undo**. **Undo** removes the assignee again and does not restore the earlier assignee. The new assignee receives one notification for the whole selection. If a conversation no longer belongs to the mailbox, Mail says how many conversations did not change.

## Take a quick look before opening {icon="eye"}

With a mouse, rest the pointer on a conversation row for a moment. A quick look opens next to the list. It shows:

- the time of the newest message, the next step, the assignee, and tags;
- the subject and the stored summary, if one exists;
- the start of the newest message without quoted history;
- the first attachment and the number of earlier messages.

Move the pointer into the card to keep it open. The card closes when you move away, scroll the list, or press **Esc**. With the keyboard, focus a row and press **Space** to show or hide the quick look. **Enter** still opens the conversation. Choose the card or the row to open the conversation.

A quick look never marks a conversation as read, never creates a summary, and never loads remote images. It does not appear for the conversation that is already open or while you select conversations. It also does not appear on touch devices or when there is no room next to the list.

## Read a complete thread {icon="route"}

Choose a conversation row to open its thread. Each message has its own sender, recipients, date, body, and attachments. Expand an older message when you need its full content.

An optional conversation summary appears in a highlighted card above the messages. To keep it current with Markdown formatting, use **Edit summary** or **More conversation actions → Create summary**. Summaries are shared Mail context, and an automation can also update them.

If the conversation has unfinished drafts, the Reply action shows an indicator. Open **Conversation details** to see who created the newest draft and when it changed. You can continue it there.

Conversation details also shows a small **Related mail** section for the conversation as a whole. Mail ranks other conversations from the same mailbox that share an external participant or the same normalized subject. Each result shows why it matches. The **Related Mail** action on a Contact card is different: it opens an exact search for that one participant. Neither feature finds similar mail from message bodies, attachments, or calendar events.

When you open an unread conversation, Mail marks it as read. Use **More conversation actions** to mark it unread again, add or remove a flag, or print the conversation. A conversation that you mark unread stays unread in already open tabs until you open its row again. A live update alone does not mark it read.

By default, Mail adapts message bodies to the current theme: safe HTML in light mode and plain text in dark mode when both versions exist. To change one message, open its actions and choose **View as plain text** or **View as HTML**. To keep one mode in this browser, use **Settings → Reading → Default message format**.

HTML messages keep a limited set of layout, typography, color, spacing, and table styles. Scripts, forms, embedded objects, external stylesheets, and other active content are removed. Remote images stay blocked separately until you choose to load them.

Mail collapses the quoted history of earlier messages. Choose **Show quoted text** to expand it and **Hide quoted text** to collapse it again. An expanded quote stays open while new activity or other live updates arrive.

The top actions take the conversation out of the folder that you view, such as Inbox. This also applies when your newest reply is stored in Sent. In views that span folders, such as **All mail** or **Needs action**, they take it out of every folder where it is filed. Your copies in Sent and Drafts stay where they are, and so do messages in Junk, Trash, or the **All Mail** folder of Gmail. The exception is a conversation that is only there.

On Gmail, folders are labels, and these views act on one label: the Inbox, when the conversation is in it.

- **Archive** removes only the Inbox label and keeps your other labels and stars. A conversation outside the Inbox has nothing to archive.
- Delete and Spam move the messages with that one label to Trash or Spam. This also removes them from every other label.
- Messages filed only under other labels stay where they are.
- **Move to folder** and dragging a row follow the same rule.

In **Message view**, each row is one message. Actions on a row, dragging a row, and the actions of the open message change only that message. The other messages of its conversation stay as they are. If the same message arrived twice in a folder, Mail shows it once, and the action changes both copies. Each row shows whether the message is unread. Opening an unread message marks it read.

Under **Send problems**, Message view lists the messages whose sending needs attention, including messages that never reached a folder. Such a message is in no folder. Archive, Delete, and moving report this instead of changing it.

- **Archive** moves the conversation to the mapped archive folder. Gmail has no archive folder. Without a mapping, Archive removes the conversation from the current folder, such as Inbox, and keeps it in **All Mail**.
- **Move to Junk** moves it to the mapped junk folder. In Junk, the same action becomes **Not spam** and moves the conversation back to Inbox.
- **Delete** moves it to the mapped trash folder.

These actions require **Edit** access and the matching folder mapping. If Mail reports that the conversation has no active place at the provider, refresh the mailbox. You can also ask someone with **Manage** access to review folder discovery and mappings.

Mail queues every action, and the mail server applies it moments later. Sometimes the server does not make the change, for example because someone moved the message in another email client. Mail then names the conversation that stayed unchanged and offers **Try again**.

Read and flag changes show immediately. If the server did not make one of these changes, the conversation shows its earlier state again, also after several changes in a row. If it is unclear whether the server made the change, Mail asks you to check the conversation and does not repeat the change.

Type `>` in the Cloud search to find the actions of the buttons and menus as commands. Common actions also have keyboard shortcuts. Help → **Shortcuts** lists the shortcuts of the current view. Shortcuts do not run while you type in an input field or in the message editor.

Open **Message actions** on an individual message. Its **Sender** section has tools for this sender:

- **Find all from this sender** opens an exact mailbox search with its own URL.
- **Create automation from sender**, **Block sender**, and **Block sender domain** open the guided rule editor with the sender filled in.
- **Manage unsubscribe** appears only when the message contains standard mailing-list unsubscribe information.

## Inspect an individual message {icon="file-search"}

When you need technical information about one message, open **Conversation details**. Expand **Mail details** and choose **Headers** or **Source**. In a conversation with several messages, select the exact message at the top of the inspector.

- **Overview** shows message identifiers, provider placement, standard flags, provider keywords, MIME parts, attachments, synchronization state, and parsing warnings.
- **Spam diagnostics** shows the spam headers of the provider, if present. Cloud does not calculate or infer its own spam score.
- **Headers** shows every stored header, including repeated delivery headers.
- **Source** shows a limited preview of the exact original message. Choose **Download .eml** for the complete byte-exact file.

An `.eml` file helps you move one message to another mail client, report a delivery problem, or keep the original message for investigation. Opening the inspector does not change the message or its state at the provider.

Provider keywords stay visible in the inspector for compatibility and diagnostics. Use local tags for normal labeling. Mail does not offer provider-keyword editing in the message or conversation menus.

:::warning Check raw data before you share it
Raw headers and `.eml` files can contain private addresses, server names, routing details, authentication results, and the complete message body. Review them before sharing.
:::

For older or partly synchronized messages, Mail can have the readable content without the exact original source. In that case, the inspector explains that source and `.eml` download are unavailable.

## Manage mailing lists {icon="news"}

Mail recognizes mailing lists from the standard list information in received messages. Everyone who can view the mailbox can open **Mailbox tools → Mailing lists**. The page shows each detected list, its recent volume, its latest message, and the actions that the list offers.

The available actions depend on the information from the sender. Unsubscribe and cleanup actions require **Edit** or **Manage** access. With **View** access, you can inspect lists and follow their archive or posting links.

:::warning Check the list name before you unsubscribe
The request affects future delivery for this mailbox and can be hard to reverse. It does not delete existing messages. Mail cannot guarantee when an external list provider stops delivery.
:::

- **Unsubscribe** asks the list to stop sending mail. Mail uses a protected one-click request when the list supports it. Otherwise, Mail opens the unsubscribe page of the list or prepares the unsubscribe email that the list names.
- **Write to list** opens the address that the list names for new messages.
- **List archive** opens the archive advertised by the list.
- After a one-click unsubscribe request, **Archive existing** or **Move existing to Trash** moves up to 500 already synchronized messages at a time. Repeat the action if Mail reports that more messages remain.

Mail never opens an unsubscribe link only because you preview or read a message. Lists without standard list information do not appear in **Mailing lists**.

## Open attachments and reply to a message {icon="paperclip"}

Received attachments stay with the message that carried them. Choose an attachment chip to open or download it in a new browser tab.

**Preview** opens text, CSV, JSON, images, PDFs, audio, and video in a dialog. When a text file is Markdown and starts with a heading, that heading becomes the title, with the file name and size below it. The dialog header has **Download attachment**, and for text, CSV, and JSON also **Copy**. On a phone, the preview fills the screen.

With **Manage** access, you can also create a public download link for an attachment. Mail shows the URL only when you create the link. You can protect it with a password, an expiry time, and a limit on download sessions. To change or revoke existing links, open **Mailbox tools → Shared links**.

## Control remote images {icon="photo-shield"}

Mail blocks images that a message would load from an external server. Loading such an image can tell the sender that you opened the message. Images included directly in the message stay visible.

When a message contains blocked images, choose:

- **Load images** to load them for this open message only.
- **Always for sender** to allow images in future messages from that exact address.
- **Always for domain** to allow images from every address at that domain. Use this broader option only for a domain that you trust.

These preferences apply only to you in the current mailbox. They do not change what collaborators see. To review or remove saved preferences, open **Mailbox tools → Remote images**.

Mail loads allowed images through its protected image service, so your browser never gets the image address. The external server can still learn that someone requested its image. Keep images blocked for unknown or suspicious senders.

Below an expanded message, choose:

- **Reply** to answer the sender.
- **Reply all** to include the original recipients.
- **Forward** to start a forwarded message. Before Mail creates the draft, you decide whether to include the original attachments.
- **Use as new message** to copy one message into an independent draft that you can review. This does not change its conversation and sends nothing.
- **Quote selection** after you select text in the message body. Mail inserts the selected lines as a quoted reply, so you can answer directly below them.

For composing, drafts, attachments, signatures, and delivery options, see [Write and send messages](/app/mail/help/mail-compose).

## Create reusable views and local tags {icon="layout-list"}

Open **Settings → Organization** to create a saved view from folder and collaboration filters. A view can filter by folder, assignee, next step, local tag, and whether the conversation is in **Later**. A filter for conversations without an assignee works like **Unassigned**: it also finds conversations whose assignee no longer has **Edit** access to this mailbox.

- **Only me** creates a private view.
- **Everyone with mailbox access** creates a mailbox view and requires **Edit** access.
- You cannot change the visibility after creation. Create a replacement view if you need a different visibility.

Local tags are mailbox labels for people, search, and automations. Choose a tag under **Tags** in the left navigation to open all matching conversations. Local tags are not IMAP folders or provider keywords, and other clients do not show them.

:::warning Deleting a local tag removes it everywhere
Mail removes a deleted local tag from every conversation in that mailbox. Saved views and search links that filter by a deleted tag or folder find no conversations for that condition.
:::

## Correct conversation grouping {icon="arrows-split-2"}

Mail groups a message with the conversation that its reply headers point to. This also works when a reply synchronized before the message that it answers. Replies to a message that the mailbox does not hold stay together.

A message without reply headers joins an earlier conversation only when both of these apply:

- its subject starts with a prefix such as `Re:`, `AW:`, or `Fwd:`;
- it was exchanged with the same outside person within 30 days.

Otherwise, it starts its own conversation. Two senders who both write "Invoice" stay apart.

A message stays one message wherever it is stored. Another email client can move or copy it to another folder. Your own mail can arrive back in the Inbox through a list, a team address, or a Bcc to yourself. In these cases, the conversation shows the message once. Mail recognizes such a copy by its headers, such as Message-ID, sender, subject, and date. It recognizes a copy of someone else's mail also by its unchanged size.

You need **Edit** access for these actions. They change how Cloud groups conversations, not the message content.

:::warning There is no automatic undo
You can adjust the grouping again with the same actions. This does not restore earlier assignments, reminders, or other collaboration state.
:::

Choose the action:

- **Merge with another conversation** when two Cloud conversations belong together.
- **Start new conversation from this message** on an individual message, when a reply starts a new topic.
- **Move message to another conversation** on an individual message, when it belongs in an existing thread.

To merge, choose the destination from the same mailbox by sender or subject. Review the source and the destination in the confirmation, then merge.

- The target keeps its assignee and work state.
- Source messages, comments, drafts, local tags, and references move to the target.
- Personal reminders also move. If someone has a reminder on both conversations, Mail keeps their reminder on the target.
- Mail removes the source conversation.

Splitting in the web interface selects one message. That message and its linked comments move to a new, unassigned conversation. Drafts, tags, references, reminders, and other comments stay with the source. The source keeps its assignee and work state. At least one message must stay in the source.

Mail records changes in the conversation activity. If another person changes either conversation before you confirm, Mail rejects your outdated change. Reload and review it again.

## Search this mailbox {icon="search"}

In a mailbox, press **Cmd/Ctrl+Shift+K** to search its messages and attachments. The mailbox name appears as a chip. Remove the chip to search the whole Cloud.

For an open calendar invitation, Cloud search offers **Add or update this event in Spaces**. When you can reply, it also offers **Prepare a reply to this invitation**. Choose a calendar where you have **Edit** access. Then confirm the import or choose your response. Replies open as drafts that you review before sending.
