---
id: mail-troubleshooting
title: Troubleshoot Mail
icon: ti ti-lifebuoy
description: Diagnose missing mail, paused transport, sending failures, draft conflicts, and search gaps.
order: 80
---

Start with the visible symptom, then use **Mailbox tools > Mailbox health** when transport, folders, or search may be involved.

## The mailbox is missing from the overview {icon="lifebuoy"}

:::steps
1. Clear **Search mailboxes**.
2. Confirm that a mailbox administrator has granted you access.
3. If the mailbox was deleted, an administrator can restore it under **Recently deleted**.
:::

Access is checked when the page loads and during live updates. If access was revoked, reloads and live views fail closed instead of keeping stale mailbox data available.

## New mail or older history is missing {icon="lifebuoy"}

:::steps
1. Check the health warning above the conversation list.
2. Open **Mailbox tools > Mailbox health**.
3. If the mailbox is paused, select **Resume mailbox**.
4. Select **Sync now**.
5. If folders are missing or changed, select **Rediscover** for the active binding.
:::

Initial synchronization loads history progressively. A message can appear before its complete body or attachment bytes finish synchronizing; the reader shows **Body is still synchronizing** until hydration completes.

For provider-shared folders, first confirm that the connected IMAP account still has the required subscription and rights. Mail can rediscover only folders the provider exposes to that account.

## A folder is missing from the sidebar {icon="folder"}

Mailbox administrators should open **Settings > Folders** and distinguish these cases:

- **Sidebar is off:** turn it on to restore the folder to Cloud navigation. This does not change the provider.
- **Not subscribed:** subscribe if this provider or another mail client uses IMAP subscriptions to control its visible folder list.
- **Unavailable:** the connected account no longer exposes the folder. Check the provider account, namespace, and permissions, then run **Rediscover**.
- **Needs review:** discovery found conflicting provider state. Review **Status > Folder discovery** before changing mail.

A hidden parent also hides its nested children from the sidebar so the hierarchy remains understandable. Their mail and individual visibility settings are retained.

## Sending says "Mailbox transport is paused" {icon="send"}

An administrator paused the mailbox or restored it into its required paused state. Open **Mailbox tools > Mailbox health**, verify the provider connection and health, then select **Resume mailbox**.

While paused, incoming synchronization, queued provider changes, scheduled delivery, and automatic replies do not run.

## A message cannot be sent {icon="point"}

Check these conditions:

- You have Write or Admin permission.
- **From** uses a verified sender.
- **Mailbox tools > Mailbox health** shows a usable connection.
- The draft has recipients and either body content or an attachment.
- Every attachment upload completed successfully and no file exceeds 100 MiB.
- Any sending warnings for the current saved revision were reviewed. Editing recipients, links, text, or attachments after approval requires a new review.
- The complete encoded message fits the current outgoing limit published by the provider.
- The provider credential has not expired or been revoked.

An attachment can fit Mail's 100 MiB per-file limit while the complete encoded
message still exceeds a smaller provider limit. Remove one or more attachments,
or create a public download link and send that link instead. A mailbox
administrator can inspect and refresh the observed values under **Mailbox tools
> Mailbox health > Provider limits**.

If the provider credential changed, use **Settings > Accounts & identities > Connected account > Replace**. The existing secret cannot be displayed or partially edited.

## Automatic replies say that no identity is available {icon="send"}

Open **Settings > Accounts & identities > Sending identities** and check both conditions on one identity:

:::steps
1. The identity status is **verified**.
2. **Automatic replies** is enabled.
:::

Then return to **Automations > Automatic replies**. Existing automatic replies can remain visible while no eligible identity exists, but creating or re-enabling one requires an eligible identity.

## A scheduled message did not send {icon="send"}

Open **Scheduled** and inspect the item:

- A retry label means delivery failed and Mail has retained the item for another attempt.
- A paused mailbox prevents the attempt from running.
- **Cancel** can return the item to a shared draft or discard it before delivery begins.

The scheduled time must be at least one minute in the future. Times are displayed in the configured Cloud time zone shown by the scheduling dialog.

## A draft is read-only or changed elsewhere {icon="pencil"}

A shared draft allows one active editor. The collaboration dialog distinguishes your own other tab from another identifiable collaborator when that information is available.

- Select **View read-only** to continue without interrupting the other editor.
- Select **Edit in this tab** or **Take over** only when you intend to make the other editing session read-only.
- For a connection warning, retry after the connection recovers; Mail does not treat it as another editor or open the takeover dialog.
- If Mail reports recovery copies, inspect them before discarding or overwriting content.
- If the browser reloads after unsaved typing, accept the restored browser recovery when it matches your work.

Starting another reply does not hide existing work. The **Continue a draft?** dialog shows the author, update time, and content preview so you can resume the correct draft or deliberately create another.

## Search returns no expected result {icon="search"}

:::steps
1. Clear the current search and confirm the conversation appears in an unfiltered folder or work view.
2. Open **Search filters** and check whether **Any condition** or **All conditions** matches your intent.
3. Remove stale fields such as Folder, Local tag, or Provider keyword.
4. If the message body is still synchronizing, retry after hydration completes.
5. If the missing words are inside a newly received attachment, wait for background extraction to finish and retry.
6. Ask an administrator to check **Status > Search index** if broad search fails across the mailbox.
:::

Local tags and internal comments exist only in Cloud. Provider folders and keywords depend on the synchronized remote state.

Attachment extraction never blocks receiving, reading, or sending a message. Mail automatically retries interrupted extraction work and regularly recovers attachments that were committed before a worker could be queued. Encrypted, scanned, unsupported, malformed, or oversized attachments are terminal outcomes: the original file remains available, but its contents are not searchable.

If **Status > Repair and projection coverage** shows a gap, an administrator can queue **Hydrate missing bodies**, **Rebuild search**, or **Repair thread projection**. Wait for the durable command to finish before repeating it. Search and thread repairs rebuild derived data and preserve mailbox content and collaboration state.

## A command needs attention {icon="lifebuoy"}

Open **Mailbox tools > Mailbox health > Advanced diagnostics and repairs** and find the redacted command entry by ID and error code.

- **Reconcile effect** is safe for an ambiguous provider outcome because it reads provider state before changing the command result.
- **Retry work** is shown only for failed provider-read maintenance where no provider effect started.
- **Cancel work** is shown only while eligible maintenance is queued or has failed.

Do not repeat a move, delete, flag change, folder operation, or send when Mail reports an ambiguous outcome. If reconciliation cannot prove the remote result, the command remains **needs attention** for manual provider inspection.

## A provider folder action fails {icon="lifebuoy"}

Folder creation, rename, deletion, subscription, and Archive, Trash, Junk, Sent, and Drafts mappings depend on current provider state. An administrator should:

:::steps
1. run **Rediscover** under **Mailbox tools > Mailbox health**,
2. confirm the folder is active and that the provider grants the required operation,
3. update the corresponding mapping or subscription when necessary, and
4. retry the action once.
:::

Shared and other-user folders may be readable while folder creation, rename, or deletion remains unavailable. Cloud does not grant or edit those upstream rights. Repeatedly clicking a queued action can make the result harder to interpret; wait for the live update or inspect the provider before retrying.

## The mailbox was restored but still does not sync {icon="point"}

This is expected. Restore intentionally leaves the mailbox paused so an administrator can verify credentials, connection health, and folder discovery before background work resumes. Complete those checks under **Mailbox tools > Mailbox health**, then select **Resume mailbox**.
