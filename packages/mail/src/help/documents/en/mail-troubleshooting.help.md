---
id: mail-troubleshooting
title: Troubleshoot Mail
icon: ti ti-lifebuoy
description: Diagnose missing mail, paused transport, sending failures, draft conflicts, and search gaps.
order: 80
---

Start with the symptom that you see. When transport, folders, or search can be involved, use **Mailbox tools → Mailbox health**.

## The mailbox is missing from the overview {icon="lifebuoy"}

:::steps
1. Clear **Search mailboxes**.
2. Check that someone with **Manage** access to the mailbox gave you access.
3. If someone deleted the mailbox, a person with **Manage** access can restore it under **Recently deleted**.
:::

Mail checks access when the page loads and during live updates. If your access ended, reloads and live views fail and do not keep showing old mailbox data.

## New mail or older history is missing {icon="lifebuoy"}

:::steps
1. Check the health warning above the conversation list.
2. Open **Mailbox tools → Mailbox health**.
3. If the mailbox is paused, choose **Resume mailbox**.
4. Choose **Sync now**.
5. If folders are missing or changed, choose **Rediscover folders**.
:::

The first synchronization loads history step by step. A message can appear before its complete body or attachment bytes have synchronized. The reader then shows **Body is still synchronizing**. As soon as synchronization completes, it shows the body, without a page reload.

If Mail restarts while it downloads a body, the reader can show **The message body could not be synchronized** for that message for a while. Mail downloads it again after the other missing bodies of the mailbox. During a large first synchronization, this can take hours. If the conversation list shows **Updates paused**, choose **Refresh message** to load the current state.

Sometimes the mail provider cannot be reached or refuses sign-ins for a while, for example during maintenance or because too many connections are open. Mail keeps trying and continues on its own when the provider answers again. You need a new password or credential only when the provider rejects the current one.

Mail cannot store a sender or recipient entry as an address when it has fewer than 3 or more than 320 characters. An example is a text fragment in a damaged message. Mail still imports the message and leaves out only that entry. The original header stays under **Headers** in the conversation details.

For folders that the provider shares, first check that the connected IMAP account still has the required subscription and access at the provider. Mail can find only folders that the provider shows to that account.

## A change from another mail app does not show yet {icon="lifebuoy"}

Mail checks every synchronized folder about once a minute. The Inbox usually updates immediately. A message that you delete or move in another mail app or on your phone leaves its old folder at the next check, in every folder. Read and flag changes from other apps arrive the same way.

- **Providers that do not report changes:** This applies to the newest few thousand messages of a folder. Changes to older messages in a larger folder arrive in turns and can take longer.
- **More than 500 folders:** When an installation synchronizes more than 500 folders, Mail still checks every Inbox each minute and the other folders in turns. Those can take a few minutes.

To check a mailbox immediately, open **Mailbox tools → Mailbox health** and choose **Sync now**.

## A folder is missing from the sidebar {icon="folder"}

With **Manage** access, open **Settings → Folders** and tell these cases apart:

- **Hidden:** Choose **Everywhere** or **Only in the folder** under **Where mail appears** to show the folder in the Cloud navigation again. This does not change the provider.
- **Not subscribed:** Subscribe if this provider or another mail client uses IMAP subscriptions to decide which folders it shows.
- **Unavailable:** The connected account no longer shows the folder. Check the provider account, the namespace, and the access at the provider, then run **Rediscover folders**.
- **Needs review:** Discovery found conflicting state at the provider. Check **Folder discovery** in **Mailbox tools → Mailbox health** before you change mail.

A hidden parent also hides its nested subfolders from the sidebar, so the hierarchy stays understandable. Their mail and their own visibility settings stay.

## Sending says "Mailbox transport is paused" {icon="send"}

Someone with **Manage** access paused the mailbox, or restored it, and a restored mailbox always starts paused.

:::steps
1. Open **Mailbox tools → Mailbox health**.
2. Check the provider connection and the health.
3. Choose **Resume mailbox**.
:::

While the mailbox is paused, incoming synchronization, queued provider changes, scheduled delivery, and automatic replies do not run.

## A message cannot be sent {icon="point"}

Check these conditions:

- You have **Edit** or **Manage** access.
- **From** uses a verified sender.
- **Mailbox tools → Mailbox health** shows a working connection.
- The draft has recipients and either body content or an attachment.
- Every attachment upload completed successfully, and no file is larger than 100 MiB.
- You reviewed all sending warnings for the current saved version. If you change recipients, links, text, or attachments after approval, you must review again.
- The complete encoded message fits the current outgoing limit that the provider publishes.
- The provider credential has not expired and was not revoked.

An attachment can fit the 100 MiB limit per file of Mail while the complete encoded message still exceeds a smaller provider limit. Remove one or more attachments, or create a public download link and send that link instead. With **Manage** access, you can check and refresh the observed values in **Mailbox tools → Mailbox health → Provider limits**.

If the provider credential changed, use **Settings → Accounts & identities → Connected account → Edit account**. Mail cannot show the existing secret, and you cannot edit only part of it.

## Automatic replies say that no identity is available {icon="send"}

Open **Settings → Accounts & identities → Sending identities**. Check that one identity meets both conditions:

:::steps
1. The identity status is **Ready**.
2. **Automatic replies** is turned on.
:::

Then return to **Automations → Automatic replies**. Existing automatic replies can stay visible while no suitable identity exists. To create an automatic reply or turn one on again, you need a suitable identity.

## A scheduled message did not send {icon="send"}

Open **Scheduled** and check the item:

- **Retry label:** Delivery failed, and Mail kept the item for another attempt.
- **Waiting for sign-in:** The account of the mailbox needs to be reconnected. The message goes out when that happens. After six days without a reconnect, it returns to Drafts.
- **Paused mailbox:** The attempt does not run.
- **Cancel:** Before delivery starts, you can return the item to a shared draft or discard it.

The scheduled time must be at least one minute in the future. The scheduling dialog shows times in the configured Cloud time zone.

## A draft is read-only or changed elsewhere {icon="pencil"}

A shared draft allows one active editor. When the information is available, the collaboration dialog tells your own other tab apart from another collaborator.

- Choose **View read-only** to continue without interrupting the other editor.
- Choose **Edit in this tab** or **Take over** only when you want the other editing session to become read-only.
- For a connection warning, try again after the connection works again. Mail does not treat it as another editor and does not open the takeover dialog.
- If Mail reports recovery copies, check them before you discard or overwrite content.
- If the browser reloads after unsaved typing, accept the restored browser recovery when it matches your work.

Starting another reply does not hide existing work. The **Continue a draft?** dialog shows the author, the update time, and a content preview. You can continue the right draft or create another one on purpose.

## A sent message is missing from Sent {icon="send"}

Mail places a sent message in the Sent folder of the identity once it finds the copy there. The placement in All Mail at Gmail follows with the next synchronization of that folder.

- If the message shows **Sent, but not saved**, Mail could not store or find the copy. Check the Sent folder mapping of the identity and the access to that folder at the provider. Do not resend the message.
- A conversation can show an extra copy of a draft next to the sent message. An earlier version imported the Gmail draft copy from All Mail. With **Manage** access, you can remove such copies with **Repair thread projection**.

To check one folder from a terminal, `cld mail ls "Mailbox:Sent Mail"` also accepts the last name of a folder or its role, such as `sent`. This helps when the provider nests the folder, for example under `[Gmail]`.

## Search returns no expected result {icon="search"}

:::steps
1. Clear the current search. Check that the conversation appears in an unfiltered folder or work view.
2. Open **Search filters**. Check whether **Any condition** or **All conditions** matches what you want.
3. Remove outdated fields such as Folder, Local tag, or Provider keyword.
4. If the message body is still synchronizing, try again after loading completes.
5. If the missing words are in a newly received attachment, wait for background extraction to finish. Then try again.
6. **Best match** ranks the newest 1,000 matching messages of a mailbox. For a very common word, add a more specific word.
7. To reach older messages, you can also choose **Newest first**.
8. If broad search fails across the mailbox, ask someone with **Manage** access to check the search state. It is in **Mailbox tools → Mailbox health**.
:::

Local tags and internal comments exist only in Cloud. Provider folders and keywords depend on the synchronized remote state.

Attachment extraction never blocks receiving, reading, or sending a message. Mail automatically retries interrupted extraction work. It also regularly recovers attachments that were saved before a worker could pick them up. Encrypted, scanned, unsupported, damaged, or oversized attachments are final results: the original file stays available, but its content is not searchable.

**Mailbox tools → Mailbox health** shows **Repair and projection coverage**. If it shows a gap, someone with **Manage** access can queue **Hydrate missing bodies**, **Rebuild search**, or **Repair thread projection**. Wait for the durable command to finish before you repeat it. Search and thread repairs rebuild derived data and keep the mailbox content and the collaboration state.

## A command needs attention {icon="lifebuoy"}

Open **Mailbox tools → Mailbox health → Advanced diagnostics and repairs**. Find the redacted command entry by its ID and error code.

- **Reconcile effect** is safe for an unclear provider result, because it reads the provider state before it changes the command result.
- **Retry work** appears only for failed maintenance that reads from the provider and where no provider effect started.
- **Cancel work** appears only while suitable maintenance is queued or has failed.

A move, delete, flag change, or folder operation that could not reach the mail server before it started needs no attention. Mail tries it again several times over a few minutes. If the server stays unreachable, the action fails without changing anything on the server, and you can repeat it later.

:::warning Do not repeat an action with an unclear result
When Mail reports an unclear result, do not repeat a move, delete, flag change, folder operation, or send. If reconciliation cannot prove the remote result, the command stays in "needs attention" until someone checks the provider by hand.
:::

## A provider folder action fails {icon="lifebuoy"}

Creating, renaming, deleting, and subscribing folders depend on the current provider state. So do the mappings for Archive, Trash, Junk, Sent, and Drafts. With **Manage** access:

:::steps
1. Run **Rediscover folders** in **Mailbox tools → Mailbox health**.
2. Check that the folder is active and that the provider allows the required operation.
3. Update the matching mapping or subscription if needed.
4. Try the action once more.
:::

Mail refuses to move or delete messages at a provider that offers neither the MOVE extension nor UIDPLUS, because Mail could not prove the remote result. The command fails immediately and leaves no copy behind. Draft synchronization to the provider needs UIDPLUS and the right to delete in the Drafts folder. Otherwise, drafts stay in Cloud, and **Mailbox health** reports this once.

Shared folders and folders of other users can be readable while creating, renaming, or deleting folders stays unavailable. Cloud does not give or edit that access at the provider. Choosing a queued action again and again can make the result harder to understand. Wait for the live update or check the provider before you try again.

## The mailbox was restored but still does not sync {icon="point"}

This is expected. A restore leaves the mailbox paused on purpose. Someone with **Manage** access can then check credentials, connection health, and folder discovery before background work continues. Complete those checks in **Mailbox tools → Mailbox health**, then choose **Resume mailbox**.
