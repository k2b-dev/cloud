---
id: mail-compose
title: Write and send messages
icon: ti ti-pencil
description: Compose, recover drafts, use templates, attach files, and control delivery.
order: 30
---

## Start a message {icon="square-plus"}

Choose **Compose** for a new message. In a conversation, choose **Reply**, **Reply all**, **Forward**, or **Quote selection**. Mail first creates a shared draft and then opens its focused composer page. Mail keeps the purpose of the draft, so the final action button says **Send**, **Reply**, **Reply all**, or **Forward**.

Choose a verified sender in **From**, add recipients, and enter a subject and body. **Cc/Bcc** shows the additional recipient fields. Recipients never see the Bcc list. Your own copy in Sent keeps it, so any mail client shows whom you blind-copied.

The composer is separate from the mailbox workspace. **Back to mailbox** saves the latest changes, releases the editing lease, and returns to the mailbox. **Open in new window** moves the same draft to its own browser window. It never creates a second draft.

## Continue the draft with Assistant {icon="sparkles"}

Choose **Write with AI** to save the current Mail draft and open it in a new Assistant chat. Assistant starts with the draft attached as a Cloud resource. It gets only the Mail operations that it needs to read and update the draft, search related history, and propose sending.

For recipients without doubt, Mail can also attach the matching contacts that you can read in the contact directory, which is Contacts by default. A missing or unavailable contact directory does not block the chat.

The Assistant chat does not copy the message into a separate Mail draft and does not gain additional mailbox access. Mail checks your current access each time Assistant reads or changes the draft. Assistant shows updating or sending mail as an Action review. Sending still requires your explicit approval and the normal final check of Mail. To review the current composer state directly, return to Mail through the draft link.

## Use Cloud Mail for email links {icon="link"}

You can ask the current browser to use Cloud Mail for standard `mailto:` links:

:::steps
1. Open **Mailbox tools → Email link setup**.
2. When the browser asks, confirm the prompt.
:::

This setting belongs to the browser or operating system, not to a mailbox or Cloud account. Cloud therefore shows no permanent switch for a default app.

A browser can remember an earlier rejection and not ask again. If no prompt appears:

:::steps
1. Open the site controls next to the address.
2. Open the site settings.
3. Reset the protocol handlers for this site.
4. Choose **Email link setup** again.
:::

An email link can fill To, Cc, Bcc, Subject, and a plain-text Body. Before Cloud creates the draft, it shows the mailbox where you have **Edit** access and the verified sender. Links cannot choose a hidden sender, attach local files, or send automatically. In browsers without support for protocol handlers, you can still use **Compose** normally.

## Choose Markdown or Plain text {icon="route"}

Open **Message options** and choose the format for the current draft:

:::compare
- **Markdown** shows **Write** and **Preview**. When the draft belongs to a conversation, it also shows **History**.
- **Plain text** has no Preview pane. A standalone message stays in one editor. A conversation draft shows **Write** and **History**.
:::

Mail sends Markdown as readable HTML with the mailbox email design and a text alternative. Plain text sends no HTML alternative. You can arrange the available panes. Mail keeps the layout compatible when another draft offers a different set of panes.

History loads only when you open it. Mail first expands the newest message. You can expand or collapse several messages independently, and Mail loads earlier summaries page by page. Mail loads a complete message only when you expand it. Links and attachments have the same security protection as in the conversation reader.

Your default format is in **Settings → Writing → Compose format**. Changing the default does not change existing drafts.

## Resume an existing conversation draft {icon="pencil"}

Drafts belong to the mailbox, not only to the browser that created them. When a conversation already has drafts, **Reply**, **Reply all**, or **Forward** opens **Continue a draft?**. The dialog shows who created each draft, when it changed, and a preview of its content. Continue the right draft or create a separate message.

Mail saves the shared draft while you work. It also keeps a recovery journal in the browser for changes that have not reached the server yet. After a reload or a broken connection, Mail can restore these browser changes.

Only the session that currently holds the editing lease can change the draft. Mail refuses saves, attachment changes, and discards from every other session, tab, agent, or CLI call, and it names the current editor. If nobody holds the lease, the next editor can change the draft again. Your own expired session therefore never blocks you.

If another tab or person edits the draft, Mail names that session when possible. You can continue read-only or move editing to this tab on purpose. After the dialog closes, the composer keeps a quiet reminder.

:::warning Take over makes the other editor read-only
Choose **Take over** only when you want the other editor to lose editing.
:::

Mail shows a temporary connection problem separately and does not ask you to take over. Outdated saves within your own session can create recovery copies. Use the recovery action in the composer to inspect and restore them.

Drafts live in Cloud as shared drafts.

- **Drafts folder:** The Drafts folder in the sidebar lists every shared draft of the mailbox, the most recently edited first. Its number counts them. Choose a draft to open it in the composer.
- **Reply indicator:** A conversation with drafts shows an indicator on Reply.
- **CLI:** `cld mail draft list` lists these drafts, together with drafts that are scheduled or being sent.
- **Provider copy:** When the provider allows it, Mail keeps a copy of each draft in the provider's Drafts folder, so other mail programs show it. Drafts that another mail program saves there appear in Mail as shared drafts.
- **Gmail:** Gmail also shows drafts in All Mail. Mail ignores messages marked as drafts outside the Drafts folder.
- **Missing drafts:** If drafts from other mail programs are missing, someone with **Manage** access can check which folder **Special folder mappings** uses for Drafts.

Mail can synchronize the draft to the provider's Drafts folder. If you then edit it in another mail program, Mail updates the same shared draft and does not add a second one. Mail keeps its own version and offers the external version as a recovery copy in these cases:

- the draft changed in Mail in the meantime;
- the other program saved its copy next to the current copy of Mail instead of replacing it;
- the returning text contains unresolved placeholders.

If the draft was already sent or discarded, a later save from another program appears as a new draft.

If another session schedules, sends, or discards the draft, every open composer reloads the current draft state. It stops saving and stops renewing its editing lease. The composer stays read-only and allows no second send or takeover. Unsaved local text stays visible. You can copy it or save it as a new independent draft. When the original message belongs to a conversation, **Open message** returns to it.

:::warning Discard draft removes the draft for everyone
**Discard draft** removes the shared draft for everyone with access to the mailbox. To keep the draft, return to the mailbox instead.
:::

## Use signatures and snippets {icon="pencil"}

Type `/` in the body to search available signatures and snippets. Mail inserts the chosen template into the draft, where you can edit or remove it.

- **Snippet:** Inserts reusable text with its values already filled in. Values such as `{{ actor.email }}` appear as plain text. In Markdown messages, Mail adds a backslash only before characters that would change the formatting, for example `\*`.
- **Signature:** Keeps its safe Liquid variables until preview and send. Values such as `{{ sender.display_name }}` or `{{ mailbox.name }}` are filled in at delivery.
- **Private:** Only the owner sees the template.
- **Mailbox:** The template is shared with collaborators.

When a verified sender has a default signature, Mail inserts it automatically into new messages, replies, and forwards. In a reply or forward, Mail places the signature before the quoted message history. A personal default replaces the mailbox default for that sender. You can still edit the inserted source. Signatures are not mandatory or locked.

With **Manage** access, you change templates and defaults in **Settings → Writing**. Choose **Edit design** there to open the mailbox CSS editor. Its preview updates from the current unsaved CSS. The Preview in the composer uses the same rendering as delivery.

## Attach files {icon="paperclip"}

Choose **Attach files** and choose one or more files, or drag files from your desktop onto the composer. The composer is highlighted while it can accept the drop. Upload progress and failures appear next to the draft attachments. You can retry or cancel an incomplete upload, and remove an attached file before sending.

If the page reloaded or closed during an upload, the draft shows that file as **Upload not finished** when you open it again. Cancel it and attach the file again.

:::reference
- **One attachment:** At most 100 MiB.
- **One draft:** At most 200 attachments and 100 MiB in total.
- **Incomplete upload:** You cannot send while an attachment upload is incomplete or failed.
:::

Your mail provider can set a smaller limit for the complete outgoing message. Before Mail queues delivery, it counts the final encoded email, including headers and attachment encoding. Encoding makes an attached file larger in transit.

When the provider publishes a current limit, Mail rejects an oversized message before SMTP starts and tells you both sizes. Remove attachments, or share a large file with a public download link instead. An unknown or outdated provider limit does not prevent sending.

When you forward a message with attachments, Mail includes the original files in the new draft by default. If the forwarded body is enough, remove single attachments in the composer.

## Add a calendar invitation {icon="calendar-plus"}

Open **Message options** and choose **Add calendar invitation**. Choose an existing event, or create a small event directly in a Space where you have **Edit** access. Spaces owns the event and its invitation sequence. Mail attaches the generated `.ics` file to the current draft. Nothing is sent until you use the normal send action.

Mail takes the organizer from the verified sender identity of the draft. **To** and **Cc** recipients become attendees of the invitation. Mail leaves out **Bcc** recipients on purpose, so calendar data never reveals hidden addresses. If Spaces is unavailable or you have **Edit** access to no Space, Mail hides the calendar action. The rest of the composer keeps working.

## Review sending warnings {icon="shield-check"}

Before an immediate, delayed, or scheduled send, Mail checks the exact saved draft for common mistakes. It can ask you to review:

- a missing attachment;
- an unusually large recipient list;
- external recipients;
- Reply all;
- a suspicious link;
- template placeholders such as `{{ sender.email }}` that are no longer part of a signature or snippet and would be sent as literal text.

The dialog explains each warning and lets you return to the draft. Choose **Send anyway** only after you have reviewed the current recipients, links, and attachments.

An approval applies only to that saved version of the draft. If you edit the draft after approval, Mail runs the checks again. Mail records the approved warning types for delivery auditing, but not a second copy of the message content.

## Reuse a message safely {icon="copy"}

Open the actions menu of a message and choose **Use as new message**. Mail creates an independent draft from its recipients, subject, and content. You can choose the sending identity and whether Mail copies the attachments.

Mail never changes the original message and conversation, and nothing is sent immediately. Review the identity, recipients, content, and attachments, then send through the normal delivery flow. If the same create request is repeated, Mail returns the same draft and creates no duplicate.

## Send now, undo, or schedule delivery {icon="send"}

Choose the main action button to queue delivery now. **Undo send window** in **Settings → Writing** can delay immediate delivery by 0 to 60 seconds. With a value above zero, Mail waits that many seconds and offers undo through **Scheduled**.

To schedule delivery:

:::steps
1. Open the split action menu and choose **Send later**.
2. In **Schedule delivery**, choose a time at least one minute in the future.
3. Check the mailbox time zone and the exact delivery time in the dialog.
:::

Choose **Save as draft** in the same menu to keep meaningful changes and return to the mailbox. Mail creates no empty draft when the composer still has only its untouched starting content.

Scheduled messages appear under **Scheduled** with recipients, content preview, creator, delivery time, and retry state. Until delivery starts, **Cancel** lets you:

- keep the item scheduled,
- return it to a shared draft, or
- discard it.

After successful delivery, the message becomes normal sent mail. Its date is the time it went out, not the time you scheduled it.

Scheduled delivery and Undo Send require an active mailbox transport. When someone pauses the mailbox, queued delivery stops until someone with **Manage** access resumes it.

A message waits and shows **Waiting for sign-in** when it is due and one of these applies:

- the mailbox needs a new sign-in;
- someone replaced its password, and the mailbox or the sending identity is not verified with the new password yet.

Mail tells you once. It sends the message as soon as the account is reconnected, still dated when it goes out. If nobody reconnects the account within six days after the due time, the message shows **Couldn’t send** and returns to Drafts. Mail then tells you again.

## Recover from a send problem {icon="alert-circle"}

Choose the delivery status below an outgoing message. It shows what happened and the safest next step.

If Mail cannot reach the mail server before it hands the message over, nothing was sent. Mail keeps the message and tries again several times over a few minutes. The delivery status shows the next attempt. The same happens when the mailbox is reconnecting at that moment, or when Mail restarted before it handed the message over. If the problem lasts, the message shows **Couldn’t send**. A message whose mailbox needs a new sign-in waits longer, as described above.

- **Couldn’t send:** Mail knows that the message was not sent. Choose **Review and resend** to reopen the kept draft before you try again. Errors with recipients, size, or delivery options use a more specific review label.
- **Partially sent:** The receiving server accepted some recipients but not others. Mail stores the message in the Sent folder like other sent mail. If that does not work immediately, Mail tries again over the next few minutes. Choose **Review remaining recipients** to create an independent draft with only the addresses that the server did not accept.
- **Delivery status unclear:** The connection ended before Mail could prove the result. Mail looks a few more times for the provider's copy in the Sent folder. When that copy appears, even later, Mail marks the message as sent.
- **Sent, but not saved:** Delivery succeeded, but Mail could not store its copy in the Sent folder.

:::warning Avoid duplicate messages
**Review everyone again...** after **Partially sent** also includes the original recipients and can create duplicate messages. For **Delivery status unclear**, choose **Check again** first. Create a resend draft only when you have considered that the original message can already have arrived. Do not resend a message that shows **Sent, but not saved**.
:::

A recovery draft never sends immediately. Review its sender, recipients, content, and attachments in the composer. Then use the normal send action.

## Choose priority and receipt requests {icon="mail-cog"}

Open **Message options**, then **Delivery options**. There you change the defaults of the selected identity for this draft:

- **Priority** adds standard headers for high or low importance. The mail client of the recipient decides whether and how to show them.
- **Request a delivery receipt** asks the SMTP server for a delivery status report. You can choose it only when the selected sending server announces support.
- **Request a read receipt** asks the recipient's mail client to report a disposition. Recipients and organizations can ignore or refuse the request.

Mail records received reports in the conversation activity. A delivery report says what a mail server reported. A read report says what a mail client reported. Neither proves that a person read, understood, or acted on the message.

## Add an event from Cloud search {icon="calendar-event"}

While you edit a draft, choose **Add a calendar invitation to this draft** in Cloud search. Mail saves the draft and opens the same event selector as the composer button. Your recipients, text, and attachments stay in this draft. If saving fails or someone else holds the editing lease, resolve that first. Sending stays a separate step.
