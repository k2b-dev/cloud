---
id: mail-admin
title: Set up and manage a mailbox
icon: ti ti-settings
description: Manage transport, identities, folders, access, automation, and mailbox lifecycle.
order: 50
---

With **Manage** access to a mailbox, you control the provider connection and the Cloud rules around it. Open **Settings** from the mailbox navigation.

## Know which settings are personal {icon="settings"}

Settings are grouped by purpose:

- **Reading** is available to every mailbox reader. It sets whether this browser shows safe HTML or plain text, or adapts to the current theme.
- **Organization** is available with **View** access for private saved views. With **Edit** access, you can also create shared views and mailbox tags.
- **Writing** is available with **Edit** or **Manage** access. It contains personal writing preferences, templates, signature defaults, and the email design editor. Content and design for the whole mailbox require **Manage** access.
- **General** is the first category that requires **Manage** access. It sets the shared identity and the sending safeguards.
- **General**, **Accounts & identities**, **Calendar invitations**, **Folders**, **Access**, and **Danger zone** require **Manage** access.

In **Settings → Calendar invitations**, choose one Space where you have **Edit** access as the suggested destination for imported invitations. Mail stores this preference for the whole mailbox. Spaces offers each person only destinations where they have **Edit** access.

The setting does not import invitations automatically. Each invitation can go to another Space where you have **Edit** access. You can safely clear the selection. If someone deletes the Space or your access ends, Mail treats the default as not set.

Operational status and public attachment links are separate from the settings. Open them from **Mailbox tools** in the mailbox navigation.

## Monitor and pause transport {icon="route"}

**Mailbox tools → Mailbox health** shows the transport health, the connected account, folder discovery, synchronization, and the state of the search index.

- **Sync now** queues a mailbox synchronization. **Last successful sync** shows when the last one finished. **Sync now** is unavailable while the mailbox is paused, or while its account must first be connected, reconnected, or verified.
- **Rediscover folders** refreshes folders and the remote namespace information.
- **Verify connection** completes a pending provider connection.
- **Pause mailbox** stops incoming synchronization, queued provider changes, scheduled delivery, and automatic replies.
- **Resume mailbox** lets these background operations continue.

Pausing stops operations. It does not hide anything. Existing mirrored mail and collaboration data stay readable for everyone with access to the mailbox.

### Repair projections and failed work

With **Manage** access, you can start background repairs in **Mailbox tools → Mailbox health → Advanced diagnostics and repairs**. Hydration retry, search rebuild, thread repair, folder rebuild, rediscovery, and synchronization are durable commands. Closing the dialog does not stop them. Before a command runs, Mail checks again that you still have **Manage** access.

The action buttons show what you can do now. A turned-off action names the reason, such as paused synchronization, an inactive folder, or the same work already pending.

- **Rebuild search** replaces only the derived search chunks.
- **Repair thread projection** links orphaned messages and refreshes summaries. It removes copies of Mail's own drafts that an earlier synchronization imported as messages. It keeps manual thread overrides, comments, references, assignments, and conversation state.

When the result of a command at the provider is unclear, Mail offers only **Reconcile effect**. Reconciliation checks the state at the provider before it decides the result. Mail offers no blind retry after a provider effect might have started, because a blind retry could run the action twice. **Retry work** and **Cancel work** are available only for maintenance commands that read from the provider and whose provider effect did not start.

Cloud administrators can review the same redacted summary in **Admin → Mail**. It contains counts, states, timestamps, available capabilities, IDs, and error codes. It contains no subjects, addresses, bodies, attachment names, provider endpoints, credentials, or raw provider errors.

## Manage the provider connection {icon="user-cog"}

**Settings → Accounts & identities → Connected account** contains the current credential for incoming and outgoing mail. Mail verifies both protocols before it stores a new or replacement credential.

:::steps
1. Choose **Find settings** first.
2. If discovery is unavailable or wrong, enter the **Server settings** yourself.
3. Enter a password or app password that the provider accepts.
:::

Mail encrypts the credentials and cannot show them after saving. To replace them, use **Edit account**. Mail offers no browser authorization for Google or Microsoft.

Mail reports the IMAP and SMTP checks separately. An IMAP failure blocks synchronization, and an SMTP failure blocks sending. Fix the reported transport before you try again.

When you connect an account with **Use this address for sending**, Mail first connects receiving and then sets up the default sender. If only the sender step fails, the connected account shows **Receiving is connected; sending is not set up yet** with the reason. Receiving keeps working. Choose **Set up sending** to try again on the existing connection. You do not need to reconnect the account or enter the password again.

If Mail reports **Synchronization is running**, synchronization or another provider operation uses the account at that moment. Wait a moment and try again. The connection dialog keeps your entries.

When you remove the connection, the transport stops. Provider mail and the kept Cloud mailbox data stay.

## Manage sending identities {icon="send"}

**Settings → Accounts & identities → Sending identities** controls the sending contexts that collaborators can use. Use separate identities when the same address needs different defaults for roles such as private mail, university work, or a business.

The **Identity label** is visible only inside the mailbox. Recipients see the **Display name** and the **From address**. Each identity can also set:

- Reply-to, default Cc, and default Bcc recipients;
- message format, priority, and receipt requests;
- a default signature and a contact card;
- the Sent and Drafts folders;
- whether it is the default identity.

**Advanced delivery** contains provider-specific settings. In most cases, leave them unchanged. The optional **Return-path address** receives technical delivery failures and bounce reports. Leave it empty unless your mail provider explicitly requires a separate address. Mail attaches the contact card as a `.vcf` file to messages sent with the identity.

After a send, Mail places the message in the identity's Sent folder as soon as it stores or finds the copy there. It does not wait for the next synchronization.

- **Gmail:** Gmail stores every message sent through its own SMTP server in Sent Mail. Mail looks for the Gmail copy for a few minutes and adds its own copy only if it still finds none.
- **Other providers:** Mail adds one copy, unless **Provider saves sent mail automatically** is on. Then Mail looks for the provider copy only right after the send. A copy that the provider lists later appears with the next synchronization of the folder.

:::warning Turn on Provider saves sent mail automatically only when it is true
If the provider does not store sent messages, no copy exists.
:::

Mail adds the default Cc and Bcc recipients when a person starts a new message, reply, or forward with that identity. Mail removes duplicates and addresses that are already in To, Cc, or Bcc. Automatic replies and workflow messages do not get these defaults, and the writer can remove them before sending.

Mail inserts a mailbox signature into new messages, replies, and forwards. Changing the identity later does not change an edited draft. A personal signature override comes first.

In **Settings → General**, you can list trusted internal email domains and choose when Mail warns about many recipients. Mail warns about external recipients only when at least one internal domain is set. These settings guide the final send review. They do not block legitimate delivery and do not change recipients automatically.

Priority and receipt requests are suggestions to other mail systems:

- **Priority** set to **High** or **Low** adds standard importance headers. The client of the recipient decides how to show them.
- **Request delivery receipts** asks the sending server for a delivery status report. It is available only when the selected SMTP transport announces DSN support.
- **Request read receipts** asks the recipient's mail client for a disposition notification. The recipient or their organization can ignore or refuse it.

Received reports appear in the conversation activity as reported results. They are useful operational evidence, not proof that a person read or acted on a message.

An identity normally uses the mailbox's SMTP server. Set up a custom SMTP server only when the From address must use a different authenticated submission server. Mail encrypts the custom credential, and nobody can read it back. Mail verifies the server before saving it. Scheduled sends stay tied to the verified transport version, so a change or removal of that transport cannot silently reroute an already queued message.

Two identities can share the same From address on purpose. Mail keeps their labels, recipient defaults, signatures, Reply-to values, delivery options, transports, folder mappings, and verification states separate. When a reply matches exactly one identity, Mail selects it automatically. If several matching identities are equally valid, the writer must choose one.

Verify every identity: choose the connected account and a recipient for a real verification message. When the identity is ready to send, the provider accepted this test with the exact From address and the advanced delivery settings of the identity. IMAP folder access alone does not prove that the provider allows these sending settings.

**Allow automatic replies** is separate from verification. Automatic replies can use only an identity that is ready to send and has this option turned on. Turning it on sends nothing by itself. An automatic reply or workflow that is turned on is still required.

## Manage provider folders {icon="user-cog"}

**Folders** shows the hierarchy that Mail found at the connected mail provider. With **Manage** access, you can:

- create a top-level folder in the personal mailbox namespace;
- create a subfolder where the provider allows it;
- rename or delete a provider folder where this is allowed;
- subscribe or unsubscribe at the provider; and
- choose where the mail of each folder appears in Cloud Mail.

These controls affect different things:

- **Where mail appears** is a Cloud setting for everyone in the mailbox. **Everywhere** shows the folder in the sidebar and its mail in All mail and the work views. **Only in the folder** keeps the folder in the sidebar. Conversations whose mail is only there leave All mail, the work views, and their counts. **Assigned to me** and **Send problems** still show them. **Hidden** also removes the folder from the sidebar. Search and saved views still find every conversation. None of these choices unsubscribes or deletes the folder, changes provider access, or removes synchronized mail.
- **Subscribe on provider** changes the IMAP subscription. Other mail clients can use that subscription to decide which folders they show.
- **Provider access** is controlled by the provider. Cloud shows shared folders and folders of other users only when the connected account can see them. It allows destructive actions only when the current access at the provider allows them.
- Synchronization follows the configured mailbox scope and the provider state. **Where mail appears** does not change it.

:::warning Deleting a folder removes it at the provider
Mail offers deletion only for an empty folder without subfolders. You cannot delete Inbox and other protected folders.
:::

A folder operation is durable. Leaving the settings page does not cancel it. Mail checks the provider state again before it confirms the result.

**Folders** shows the hierarchy as a compact tree:

- Folder groups, such as `[Gmail]` at Gmail, appear as group rows with their folders below.
- The chevron next to a folder collapses its subfolders.
- A folder whose name appears more than once shows its path.
- Choose a folder to open its menu. The menu explains the three choices and holds the actions of the folder, such as **New subfolder**, **Rename**, the provider subscription, **Remove from Mail**, and **Delete folder**.
- A row names its choice only when it is not **Everywhere**. **Unavailable** and **Needs review** mark provider problems.

A subfolder follows its parent when the choice of the parent is stricter. It can keep more mail inside, never less. Its row then shows "inherited from" and the name of the parent. Its menu names the parent that sets the looser choices. When you choose the choice of the parent again, the subfolder follows the parent again.

Sent, Drafts, Trash, Junk, and provider collections such as All Mail, Important, and Starred at Gmail never decide where mail appears. Mail therefore does not offer **Only in the folder** for them, and **Only in the folder** on a parent does not change them. Only **Hidden**, set on them or on their parent, removes them from the sidebar.

**Special folder mappings** appears below the folder hierarchy. It selects the active, selectable folders that Mail uses for Sent, Drafts, Archive, Trash, and Junk. Mail finds the Inbox at the provider. A wrong or missing mapping can stop the matching conversation action or the Sent or Drafts view from completing.

If the IMAP account shows shared folders or folders of other users, **Rediscover folders** can add them to the same hierarchy. They are provider state of this connected account, not separate Cloud resources. Cloud does not:

- share single folders;
- edit access lists at the provider;
- combine folders with similar names from several accounts;
- use the credential of another person if this connection loses access.

Changes at the provider to namespaces, subscriptions, or access can make a folder unavailable or unclear. Check **Mailbox tools → Mailbox health**, fix the provider state if needed, then run **Rediscover folders**.

When an unavailable folder is gone for good, choose **Remove from Mail** in its menu. After you confirm, Mail removes the unavailable folder and its unavailable subfolders from its folder list. Nothing is deleted at the provider, and mirrored messages and history stay. If the provider shows the folder again, the next rediscovery restores it automatically.

Agents can change provider subscriptions with `cld mail folder subscribe` and `cld mail folder unsubscribe`. Both commands create the same durable, observable provider command as the web app.

## Configure access {icon="shield-lock"}

**Access** uses the standard Cloud access editor. Give the narrowest access that the person needs for their work:

- **View** for reading, search, comments, and personal reminders.
- **Edit** for sending, provider mail operations, and collaboration changes.
- **Manage** for transport, sharing, rules, workflows, and the mailbox lifecycle.
- **View assigned only** or **Edit assigned only** for people and groups who work only on the conversations assigned to them. [Work together in a mailbox](/app/mail/help/mail-collaboration) explains what they can do.

**Automatic reply management access** is a mailbox setting above the access list:

- **Writers and administrators** lets people with **Edit** access create and change guided out-of-office replies and acknowledgements.
- **Administrators only** is the safe default for new and existing mailboxes.

This setting does not let people with **Edit** access change identities, reference number settings, or YAML workflows. These stay operations that require **Manage** access.

Credentials stay hidden, also for people with **Manage** access. Sharing a mailbox gives Cloud access to the mailbox. It does not reveal the provider password or token.

## Share attachments with public links {icon="link"}

You need **Manage** access to the mailbox to create, list, or revoke a public attachment link. Open a received message or draft and use the link action next to an attachment. You cannot share files larger than 100 MiB this way.

:::warning Copy the URL before you close the result
The public URL is disclosed only once, immediately after creation. Mail stores only a hash of its secret token and cannot show the same URL again.
:::

**Mailbox tools → Shared links** lists every link page by page, including older active links. There you can revoke access without deleting the original message or draft attachment.

A link can have an optional password, expiry time, and maximum number of download sessions. Passwords are case-sensitive and can contain spaces. Range requests that resume one allowed download do not count as extra downloads. Revoked, expired, used-up, and invalid links fail without revealing attachment metadata. So does a link opened with a wrong password.

The CLI offers the same operations through `cld mail attachment link create`, `list`, and `revoke`. Give a password through `--password-file` or `--password-stdin`. The CLI never accepts it as a visible command-line value.

## Review Mail storage {icon="database"}

Only Cloud administrators can open **Admin → Mail**. **Manage** access to a mailbox is not enough. The page lists every active mailbox with redacted data on health, synchronization, storage, the number of access entries, and attention. It never shows message or attachment content.

Open **Security** from this page to review reported suspicious messages and keep exact organization-wide protection rules. For what users see and safe rules, see [Recognize and report suspicious mail](/app/mail/help/mail-security).

Use **Manage permissions** on a mailbox to recover a mailbox without a manager or to correct an accidental access entry. This is an explicit, audited access change. Cloud administrators do not get access to mailbox content implicitly. Add a replacement manager before you remove the last person with **Manage** access.

The CLI offers the same recovery tools:

- `cld mail admin mailbox list` finds mailboxes, including mailboxes that the current administrator cannot open.
- `cld mail admin mailbox get <mailbox>` shows one redacted operations record.
- `cld mail admin mailbox access list|grant|set|revoke <mailbox>` changes direct access for users, groups, or service accounts.
- `cld mail admin storage show|reconcile` reads or refreshes the storage data.

**Refresh storage snapshot** queues a background reconciliation. The page and `cld mail admin storage show` continue to show the last completed snapshot until that job finishes. Queuing the job does not update the numbers immediately. These values are observability data, not storage quotas, and they offer no drilldown into content.

## Choose the contact directory {icon="address-book"}

Mail uses the built-in Contacts app for recipient suggestions, contacts in **Conversation details**, **New contact**, and contacts attached to **Write with AI**. You do not need to set anything up for this.

To use another app, such as a customer management app, you need to be a Cloud administrator:

:::steps
1. Open **Admin → Mail**. **Contact directory** shows the current app and whether it uses the Contacts defaults or a custom mapping.
2. Choose **Configure** to open the editor.
3. Choose the app.
4. For each function, choose one of its capabilities.
5. Choose **Save**.
:::

Each list offers only capabilities that match the contract for contact directories. When the app provides the defaults, Mail fills them in.

- **Suggest recipients** and **Match participants** are required.
- **Read a contact** is optional. Without it, **Compose email** from a contact in another app reports that the contact is unavailable.
- **List writable books** and **Create a contact** are optional and belong together. Without them, Mail hides **New contact**.

**Save** checks every choice against the app's current capabilities and names each field that Mail cannot use. Mail always calls the app with each person's own access, so people see only the contacts that they can read there. If the app stops or later changes in an incompatible way, the affected features become unavailable, as when Contacts is unavailable. **Use Contacts defaults** restores the built-in mapping.

`cld mail admin contact-directory show|candidates|set|reset` does the same from a terminal and uses the same check. Mail does not save an incompatible mapping, and the command lists the same problems.

## Configure signatures and email design {icon="pencil"}

In **Settings → Writing**, create private or mailbox signatures and snippets. Set the mailbox default signature in **Accounts & identities → Sending identities**. A personal default of a collaborator in **Writing** comes first.

Markdown messages always get the built-in readable email design. **Email design** adds checked mailbox CSS for company branding. It does not replace the safe base design. Check the result in the **Preview** of the composer before you rely on a CSS change.

## Configure automatic responses and references {icon="settings"}

Open **Mailbox tools → Automations**:

:::steps
1. **Overview** shows what is active and opens the exact setup task.
2. **Automatic replies** offers the presets **Out of office**, **Office-hours acknowledgement**, **Reference acknowledgement**, and **Custom automatic reply**. People with **Edit** access can use this section when the access setting allows it.
3. **Incoming mail** offers guided matching and a step flow that mixes Mail and AI steps.
4. **Activity** shows workflow runs and incoming automation backfills of this mailbox.
5. **Workflows** contains versioned YAML definitions, the reference number setup, and explicit activation controls.
:::

**Incoming mail**, **Activity**, and **Workflows** require **Manage** access. Mail stores the timing of an automatic reply directly in the guided reply or in the unchangeable YAML workflow version. There is no separate schedule resource to keep in sync.

An automatic reply has these settings:

- on or off, and a verified automation sender;
- subject, body, and Markdown or plain-text format;
- the repeat interval per recipient;
- time zone, active dates, weekly windows, and exceptions;
- the behavior outside the active window.

For the behavior outside the active window, choose:

- **Do not reply** ignores messages outside the schedule.
- **Reply at the next active time** delays the response until the schedule is active.

Preview the exact response before you turn it on. Pausing the mailbox stops automatic replies.

For setup steps, schedule effects, reference patterns, and repeat protection, see [Automate responses and mailbox work](/app/mail/help/mail-automation).

## Manage workflows {icon="route"}

Open **Automations → Workflows** for the YAML editor. Saving creates a new unchangeable version. It does not activate that version automatically.

:::steps
1. Review the YAML, the validation diagnostics, and the **Effect budget**.
2. Activate the version explicitly.
3. Check mailbox runs separately in **Automations → Activity**.
:::

For normal out-of-office or acknowledgement needs, use the automatic reply interface. Use workflows when the mailbox needs fixed conditions and actions beyond that editor.

See [Mail workflow YAML reference](/app/mail/help/mail-workflows) for all supported inputs, triggers, actions, conditions, expressions, defaults, and checked examples.

## Delete and restore a mailbox {icon="point"}

**Danger zone → Move to recently deleted** moves the mailbox into a deleted state that you can recover. Mail does not purge provider mail and kept Cloud data.

Deleted mailboxes appear under **Recently deleted** on the Mail overview for people who can restore them. A restored mailbox starts paused. In **Mailbox tools → Mailbox health**, verify the connection, folder discovery, and health. Then choose **Resume mailbox**.
