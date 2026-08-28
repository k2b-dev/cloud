---
id: mail-work
title: Read, search, and organize
icon: ti ti-inbox
description: Find conversations, read complete threads, and change portable mail state safely.
order: 20
---

## Find the conversation you need {icon="search"}

Use **Search mailbox** for a quick search across the current mailbox. **Everything** is selected by default and includes synchronized message fields plus extracted attachment text. Use the search-in button to narrow the search to any combination of **Sender**, **Recipients**, **Subject**, **Message body**, and **Attachment names**.

Select **Search filters** when you need additional conditions such as dates, recipients, attachments, folders, tags, or collaboration state.

The filter dialog shows the current search as editable conditions. Select **Add filter** for another field. When several filters are active, choose whether all filters or any filter must match. **Advanced conditions** stays collapsed until you need alternative or nested groups.

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

Choose **Any condition** to match at least one filled field, or **All conditions** to require every filled field. Search filters stay in the page URL, so reloading or sharing the URL preserves the current result. Use **Clear search** to return to the unfiltered view.

Provider keywords are advanced synchronized metadata rather than a normal labeling system. Existing keyword search URLs continue to work and remain editable, but new filters use local tags for human-facing labels.

Search results are permission-checked and use the synchronized Cloud copy. During an initial sync, older messages or bodies can become searchable later as synchronization and body hydration continue.

After an attachment has synchronized, Mail extracts readable text from supported PDF, office-document, spreadsheet, presentation, RTF, EPUB, and CSV files in the background. The default broad search includes that extracted attachment text. An explicit **Message body** filter searches only the email body, while **Attachment name** searches filenames. Password-protected, scanned, unsupported, malformed, or oversized files remain downloadable but do not contribute searchable text.

When extracted attachment text matches, the result names the attachment, shows a short matching excerpt, and opens the exact message that owns it. Use the download action on the result when you need the original file.

## Use follow-up, assignment, and folders for different purposes {icon="layout-list"}

The built-in **Follow-up** views show what should happen next. **Assignment** shows who owns it:

| Section | View | What it shows |
| --- | --- | --- |
| Follow-up | Needs action | Conversations where the team needs to review or act |
| Follow-up | Waiting for reply | Conversations where a confirmed team reply is waiting on someone else. New incoming mail moves them to Needs action. |
| Follow-up | Snoozed | Conversations hidden until their snooze time. The due time reveals them without changing their next step; new incoming mail reveals them immediately. |
| Follow-up | Done | Conversations marked Done |
| Assignment | Assigned to me | Conversations assigned to you |
| Assignment | Unassigned | Conversations without an assignee |
| Mail / More | All mail | Mail from every provider folder except Trash and Junk |
| More | Recent activity | Recently changed conversations |
| Mail | Scheduled | Messages waiting for future delivery |

Provider folders are a different layer. Moving a conversation to Archive, Trash, Junk, or another provider folder changes remote mail placement and can be visible in other clients. Marking a conversation **Done** changes only Cloud follow-up state; it does not archive or move the email.

Use **Waiting for reply** when your team's next step depends on another person. Mail applies it after a human reply or reply-all is confirmed as sent, including replies synchronized from another email client. Use **Snooze until** when the next review depends on a date or time. Snoozed conversations stay out of active views until their selected time unless new incoming mail arrives first.

New incoming mail always changes the conversation to **Needs action** and ends its snooze. Sending a human reply or reply-all changes it to **Waiting for reply** only after delivery is confirmed. New messages, forwards, automatic replies, retries, and ambiguous delivery outcomes do not infer a new next step. In **Conversation details**, you only decide whether the conversation is **Done**. Clearing Done reopens it and Mail derives the next step from the latest verified message.

Use **Move to folder** from the conversation actions or Mail commands to choose a destination with the keyboard, pointer, or touch. On desktop you can also drag a conversation row onto a selectable folder in the left navigation. Mail queues the move and synchronization confirms the provider result.

To operate on several conversations, select their checkboxes. Hold Shift while selecting another checkbox or conversation row to select the loaded range between them. Mail limits one selection to 50 conversations so provider work remains observable. The selection toolbar can mark, flag, archive, move, junk, or delete the selected conversations. If only some commands can be queued, Mail keeps the failed conversations selected and reports each failure explicitly.

## Read a complete thread {icon="route"}

Select a conversation row to open its thread. Each message has its own sender, recipients, date, body, and attachments. Expand an older message when you need its full content.

An optional conversation summary appears in a highlighted card above the messages. Use its **Edit summary** button or **More conversation actions > Create summary** to maintain it with Markdown formatting; summaries are shared Mail context and can also be updated by an automation. If the conversation has unfinished drafts, the Reply action shows an indicator. Open **Conversation details** to see who created the newest draft, when it was updated, and continue it.

Conversation details also shows a small **Related mail** section for the conversation as a whole. Mail ranks other conversations from the same mailbox when they share an external participant or the same normalized subject, and shows the matching reasons with each result. This is distinct from a Contact card's **Related Mail** action, which opens an exact search for that one participant. Neither feature infers similarity from message bodies, attachments, or calendar events.

Opening an unread conversation marks it as read. Use **More conversation actions** to mark it unread again, add or remove a flag, or print the conversation. A conversation that you mark unread stays unread in already open tabs until you deliberately open its row again; a live update alone does not mark it read.

Mail adapts message bodies to the current theme by default: safe HTML in light mode and plain text in dark mode when both versions are available. Open an individual message's actions and choose **View as plain text** or **View as HTML** to override that message. Choose a persistent mode for this browser under **Settings > Reading > Default message format**.

HTML messages keep a bounded set of layout, typography, color, spacing, and table styles. Scripts, forms, embedded objects, external stylesheets, and other active content are removed. Remote images remain blocked separately until you choose to load them.

The top actions operate on the conversation's active provider placement:

- **Archive** moves it to the mapped archive folder.
- **Move to junk** moves it to the mapped junk folder. In Junk, the same action becomes **Not spam** and moves the conversation back to Inbox.
- **Delete** moves it to the mapped trash folder.

These actions require write access and the corresponding folder mapping. If Mail reports that the conversation has no active provider placement, refresh the mailbox or ask an administrator to review folder discovery and mappings.

Select **Mail commands** above the conversation list to search the same actions that appear in buttons and menus. Common commands also have keyboard shortcuts. Open **Configure keyboard shortcuts** from Mail commands to change or disable them on this device. Shortcuts do not run while you are typing in an input or message editor.

Open an individual message's **Message organization actions** for sender-scoped tools:

- **Find all from this sender** opens an exact, URL-backed mailbox search.
- **Create rule from sender**, **Block sender**, and **Block sender domain** open the guided rule editor with the sender already filled in.
- **Manage unsubscribe** appears only when the message supplies standard mailing-list unsubscribe information.

## Inspect an individual message {icon="file-search"}

Open **Conversation details**, expand **Mail details**, and choose **Headers** or **Source** when you need technical information about one message. In a conversation with several messages, select the exact message at the top of the inspector.

- **Overview** shows message identifiers, provider placement, standard flags, provider keywords, MIME parts, attachments, synchronization state, and any parsing warnings.
- **Spam diagnostics** shows provider-supplied spam headers when present. Cloud does not calculate or infer its own spam score.
- **Headers** shows every stored header, including repeated delivery headers.
- **Source** shows a bounded preview of the exact original message. Choose **Download .eml** for the complete byte-exact file.

An `.eml` file is useful when transferring one message to another mail client, reporting a delivery problem, or preserving the original message for investigation. Opening the inspector does not change the message or its provider state.

Provider keywords remain visible in the inspector for interoperability and diagnostics. Use local tags for normal labeling; Mail does not offer provider-keyword editing in the message or conversation menus.

Raw headers and `.eml` files can contain private addresses, server names, routing details, authentication results, and the complete message body. Review them before sharing. For older or partially synchronized messages, Mail may have the readable content without the exact original source; in that case the inspector explains that source and `.eml` download are unavailable.

## Manage mailing lists {icon="news"}

Mail recognizes mailing lists from the standard list information included in received messages. Every mailbox reader can open **Mailbox tools > Mailing lists** to see each detected list, its recent volume, its latest message, and the actions advertised by the list.

The available actions depend on the information supplied by the sender. Unsubscribe and cleanup actions require Write or Admin access; readers can inspect lists and follow their advertised archive or posting links.

- **Unsubscribe** asks the list to stop sending mail. Mail uses a protected one-click request when the list supports it. Otherwise Mail opens the list's unsubscribe page or prepares the advertised unsubscribe email.
- **Write to list** opens the address supplied for new list messages.
- **List archive** opens the archive advertised by the list.
- After a one-click unsubscribe request, **Archive existing** or **Move existing to Trash** can move up to 500 already synchronized messages at a time. Repeat the action if Mail reports that more messages remain.

Confirm the list name before unsubscribing. The request affects future delivery for this mailbox and may be difficult to reverse. It does not delete existing messages, and Mail cannot guarantee when an external list provider will stop delivery.

Mail never opens an unsubscribe link merely because you preview or read a message. Lists without standard list information do not appear in **Mailing lists**.

## Open attachments and reply to a message {icon="paperclip"}

Received attachments stay with the message that carried them. Select an attachment chip to open or download it in a new browser tab.

Mailbox administrators can also create a public download link from an attachment. The URL is shown only at creation and can be protected with a password, expiry time, and download-session limit. Manage or revoke existing links under **Mailbox tools > Shared links**.

## Control remote images {icon="photo-shield"}

Mail blocks images that a message would otherwise load from an external server. Loading one of these images can tell the sender that the message was opened. Images included directly in the message remain visible.

When a message contains blocked images, choose:

- **Load images** to load them for this open message only.
- **Always for sender** to allow images in future messages from that exact address.
- **Always for domain** to allow images from every address at that domain. Use this broader option only for a domain you trust.

These preferences apply only to you in the current mailbox. They do not change what collaborators see. Open **Mailbox tools > Remote images** to review or remove saved preferences.

Mail retrieves allowed images through its protected image service instead of exposing the image address to your browser. The external server can still learn that its image was requested, so keep images blocked for unknown or suspicious senders.

Under an expanded message, choose:

- **Reply** to answer the sender.
- **Reply all** to include the original recipients.
- **Forward** to start a forwarded message. You can decide whether to include the original attachments before the draft is created.
- **Use as new message** to copy one message into an independent, reviewable draft without changing its conversation or sending immediately.
- **Quote selection** after selecting text in the message body. Mail inserts the selected lines as a quoted reply so you can answer directly below them.

For composing, drafts, attachments, signatures, and delivery options, see [Write and send messages](/app/mail/help/mail-compose).

## Create reusable views and local tags {icon="layout-list"}

Open **Settings > Organization** to create a saved view from folder and collaboration filters. A view can filter by folder, assignee, next step, local tag, and snooze state.

- **Only me** creates a private view.
- **Everyone with mailbox access** creates a mailbox view and requires write access.
- Visibility is fixed after creation. Create a replacement view if you need a different visibility.

Local tags are mailbox labels used by people, search, and automations. Select a tag under **Tags** in the left navigation to open all matching conversations. They are not IMAP folders or provider keywords and do not appear in other clients. Deleting a local tag removes it from every conversation in that mailbox.

## Correct conversation grouping {icon="arrows-split-2"}

Use **Merge with another conversation** when two Cloud conversations belong together. On an individual message, use **Start new conversation from this message** when a reply introduces a new topic, or **Move message to another conversation** when it belongs in an existing thread. These actions require write access and change Cloud's conversation grouping without changing the message content.
