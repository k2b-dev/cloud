---
id: mail-admin
title: Set up and manage a mailbox
icon: ti ti-settings
description: Manage transport, identities, folders, access, automation, and mailbox lifecycle.
order: 50
---

Mailbox administrators manage the provider connection and the Cloud policies around it. Open **Settings** from the mailbox navigation.

## Know which settings are personal {icon="settings"}

Settings are grouped by intent:

- **Reading** is available to every mailbox reader and controls whether this browser shows safe HTML, plain text, or adapts to the current theme.
- **Organization** is available to readers for private saved views. Writers can also create shared views and mailbox tags.
- **General** is the first administrator category and controls the shared identity and sending safeguards.
- **Writing** is available to writers and administrators. It contains personal writing preferences, templates, signature defaults, and the email-design editor. Mailbox-wide content and design require Admin access.
- **General**, **Accounts & identities**, **Calendar invitations**, **Folders**, **Access**, and **Danger zone** are available only to mailbox administrators.

Under **Settings > Calendar invitations**, choose one writable Space as the suggested destination when you import invitations. Mail stores this mailbox-wide preference and Spaces returns only destinations the current user may write. It does not import mail automatically, and every invitation can target another writable Space. Clearing the selection is safe. If the Space is deleted or access is revoked, Mail treats the default as unset.

Operational status and public attachment links are separate from configuration. Open them from **Mailbox tools** in the mailbox navigation.

## Monitor and pause transport {icon="route"}

**Mailbox tools > Mailbox health** shows transport health, the connected account, folder discovery, synchronization, and search-index state.

- **Sync now** starts a mailbox synchronization.
- **Rediscover** refreshes folders and remote namespace information.
- **Verify connection** completes a pending provider connection.
- **Pause mailbox** stops incoming synchronization, queued provider changes, scheduled delivery, and automatic replies.
- **Resume mailbox** allows those background operations to continue again.

Pausing is an operational stop, not a visibility control. Existing mirrored mail and collaboration data remain readable according to mailbox permissions.

### Repair projections and failed work

Mailbox administrators can use **Mailbox tools > Mailbox health > Advanced diagnostics and repairs** for asynchronous repairs. Hydration retry, search rebuild, thread-projection repair, folder rebuild, rediscovery, and synchronization are durable commands: leaving the dialog does not stop them, and Mail rechecks current Admin permission before execution.

The action buttons reflect current eligibility. A disabled action includes the reason, such as paused synchronization, an inactive folder, or equivalent work already pending. Search rebuild replaces only derived search chunks. Thread repair creates links for orphaned messages and refreshes summaries; it does not discard manual thread overrides, comments, references, assignments, or conversation state.

Commands with an ambiguous provider outcome offer **Reconcile effect** only. Reconciliation inspects provider state before deciding the result. Mail does not offer a blind retry after a provider effect may have started. **Retry work** and **Cancel work** are limited to provider-read maintenance commands whose provider effect did not start.

Cloud administrators can review the same redacted aggregate under **Administration > Mail**. It contains counts, states, timestamps, capability availability, IDs, and error codes, but no subjects, addresses, bodies, attachment names, provider endpoints, credentials, or raw provider errors.

## Manage the provider connection {icon="user-cog"}

**Settings > Accounts & identities > Connected account** contains the current incoming- and outgoing-mail credential. Mail verifies both protocols before storing a new or replacement credential.

Use **Find settings** as the normal starting point. Open **Manual server settings** only when discovery is unavailable or incorrect. When the deployment has a matching Google or Microsoft OAuth client, continue in the provider's browser authorization screen. Access and refresh tokens are encrypted and never displayed. Use **Reconnect** after consent is revoked; use **Replace** for manual passwords, app passwords, or tokens.

Mail reports IMAP and SMTP verification independently. An IMAP failure blocks synchronization and an SMTP failure blocks sending; correct the reported transport before retrying.

Removing the connection disconnects transport. It does not delete provider mail or the retained Cloud mailbox data.

## Manage sending identities {icon="send"}

**Settings > Accounts & identities > Sending identities** controls the sending contexts available to collaborators. Use separate identities when the same address needs different defaults for roles such as private mail, university work, or a business.

The **Identity label** is visible only inside the mailbox. Recipients see the **Display name** and **From address**. Each identity can also define Reply-to, default Cc and Bcc recipients, message format, priority, receipt requests, a default signature, a contact card, Sent and Drafts folders, and whether it is the default.

**Advanced delivery** contains provider-specific settings that most people should leave unchanged. The optional **Return-path address** receives technical delivery failures and bounce reports. Leave it empty unless your mail provider explicitly requires a separate address. A contact card is attached as a `.vcf` file to messages sent with the identity.

Default Cc and Bcc recipients are added when a person starts a new message, reply, or forward with that identity. Duplicates and addresses already present in To, Cc, or Bcc are removed. These defaults are not added to automatic replies or workflow messages, and the writer can remove them before sending. A mailbox signature is inserted into new messages, replies, and forwards; changing the identity later does not rewrite an edited draft. A personal signature override takes precedence.

Under **Settings > General**, administrators can list trusted internal email domains and choose when Mail warns about a large recipient set. External-recipient warnings appear only when at least one internal domain is configured. These settings guide the final send review; they do not block legitimate delivery or change recipients automatically.

Priority and receipt requests are suggestions to other mail systems:

- **High** or **Low priority** adds standard importance headers. A recipient's client decides how to display them.
- **Delivery receipt** asks the sending server for a delivery-status report. It is available only when the selected SMTP transport advertises DSN support.
- **Read receipt** asks the recipient's mail client for a disposition notification. The recipient or their organization can ignore or refuse it.

Received reports appear in conversation activity as reported outcomes. They are useful operational evidence, not proof that a person read or acted on a message.

An identity normally uses the mailbox SMTP server. Configure **Custom SMTP server** only when the From address must use a different authenticated submission server. The custom credential is encrypted and write-only. Mail verifies the server before saving it and keeps scheduled sends pinned to the verified transport revision; changing or removing that transport cannot silently reroute an already queued message.

Two identities may deliberately share the same From address. Mail keeps their labels, recipient defaults, signatures, Reply-to values, delivery options, transports, folder mappings, and verification states separate. When a reply matches exactly one identity, Mail selects it automatically. If several matching identities are equally valid, the writer must choose one explicitly.

Verify every identity by choosing the connected account and a recipient for a real verification message. **Ready to send** means that the provider accepted this test with the identity's exact From address and advanced delivery settings. IMAP folder access alone does not prove that the provider permits those sending settings.

The **Allow automatic replies** option is separate from verification. Automatic replies can use only a ready identity with this option enabled. Enabling it does not itself send anything; an enabled automatic reply or workflow is still required.

## Manage provider folders {icon="user-cog"}

**Folders** shows the hierarchy discovered from the connected mail provider. From here, a mailbox administrator can:

- create a top-level folder in the personal mailbox namespace;
- create a subfolder where the provider grants that right;
- rename or delete an eligible provider folder;
- subscribe or unsubscribe on the provider; and
- show or hide a folder in the Cloud Mail sidebar.

These controls affect different things:

- **Show in Mail** and **Hide from Mail** are only Cloud navigation preferences. Hiding a folder does not unsubscribe it, delete it, change provider permissions, or remove already synchronized mail.
- **Subscribe on the mail provider** changes the IMAP subscription. Other mail clients may use that subscription to decide which folders they show.
- **Provider access** is controlled by the provider. Cloud displays shared and other-user folders only when the connected account can see them, and enables destructive actions only when current provider rights allow them.
- **Synchronization** follows the configured mailbox scope and provider state. It is not enabled or disabled by the sidebar switch.

Deleting a folder removes it at the provider and is therefore offered only for an empty folder without subfolders. Inbox and other protected folders cannot be deleted. A folder operation is durable: leaving the settings page does not cancel it, and Mail rediscovers provider state before confirming the result.

Use a folder's actions menu to choose **Show in Mail** or **Hide from Mail**. The status beside the folder shows **Visible**, **Hidden**, **Unavailable**, or **Needs review**. This menu placement prevents accidental visibility changes while managing provider folders.

**Special folder mappings** appears above the folder hierarchy and selects the active, selectable folders used for Sent, Drafts, Archive, Trash, and Junk operations. Inbox is discovered from the provider. An incorrect or missing mapping can prevent the corresponding conversation action or sent/draft projection from completing.

If the IMAP account exposes shared or other-user folders, **Rediscover** can make them appear in the same hierarchy. They are provider state of this connected account, not separate Cloud resources. Cloud does not provide folder-level sharing, edit upstream ACLs, combine similarly named folders from several accounts, or use another person's credential if this connection loses access.

Provider-side namespace, subscription, or permission changes can make a folder unavailable or ambiguous. Review **Mailbox tools > Mailbox health**, correct the provider state when necessary, then run **Rediscover**.

When an unavailable folder is permanently gone, choose **Remove from Mail** from its actions menu. Confirming removes the unavailable folder and unavailable subfolders from Cloud Mail's folder list. It does not delete anything at the provider and does not remove mirrored messages or history. If the provider exposes the folder again, the next rediscovery restores it automatically.

Agents can change provider subscriptions with `cld mail folder subscribe` and `cld mail folder unsubscribe`. Both commands create the same durable, observable provider command as the web app.

## Configure access {icon="shield-lock"}

**Access** uses the standard Cloud permission editor. Grant the narrowest permission that supports the person's job:

- Read for reading, search, comments, and personal reminders.
- Write for sending, provider mail operations, and collaboration changes.
- Admin for transport, sharing, policies, workflows, and mailbox lifecycle.

**Who can manage automatic replies?** is a mailbox policy above the permission list:

- **Writers and administrators** lets writers create and change guided out-of-office replies and acknowledgements.
- **Administrators only** is the secure default for new and existing mailboxes.

This policy does not let writers configure identities, reference-number settings, or YAML workflows. Those remain mailbox-admin operations.

Credentials remain hidden even from administrators. Sharing a mailbox grants Cloud access to the mailbox; it does not reveal the provider password or token.

## Share attachments with public links {icon="link"}

Mailbox **Admin** access is required to create, list, or revoke a public attachment link. Open a received message or draft and use the link action beside an attachment. Files larger than 100 MiB cannot be shared this way.

The public URL is disclosed only once, immediately after creation. Copy it before closing the result: Mail stores a hash of its secret token and cannot show the same URL again. **Mailbox tools > Shared links** lists every link in pages, including older active links, and lets an administrator revoke access without deleting the original message or draft attachment.

A link can have an optional password, expiry time, and maximum number of download sessions. Passwords are case-sensitive and can contain spaces. Range requests used to resume one granted download do not consume extra download counts. Revoked, expired, exhausted, invalid, and incorrectly passworded links fail without revealing attachment metadata.

The CLI provides the same mailbox-admin operations through `cld mail attachment link create`, `list`, and `revoke`. Supply a password through `--password-file` or `--password-stdin`; it is never accepted as a visible command-line value.

## Review Mail storage {icon="database"}

Cloud **Admin** access, which is separate from mailbox Admin access, is required for **Administration > Mail**. The page lists every active mailbox with redacted health, synchronization, storage, access-count, and attention data. It never exposes message or attachment content.

Open **Security** from this page to review reported suspicious messages and maintain exact organization-wide protection rules. See **Recognize and report suspicious mail** for the user-facing behavior and safe rule guidance.

Use **Permissions** on a mailbox to recover an orphaned mailbox or correct an accidental grant. This is an explicit, audited access change; Cloud administrators do not implicitly receive mailbox-content access. Add a replacement administrator before removing the last existing administrator.

The CLI exposes the same recovery surface:

- `cld mail admin mailbox list` discovers mailboxes, including those the current administrator cannot open.
- `cld mail admin mailbox get <mailbox>` shows one redacted operations record.
- `cld mail admin mailbox access list|grant|set|revoke <mailbox>` manages direct user, group, or service-account grants.
- `cld mail admin storage show|reconcile` reads or refreshes storage observability.

**Reconcile storage** queues a background reconciliation. The page and `cld mail admin storage show` continue to show the last completed snapshot until that job finishes; queuing the job does not synchronously update the numbers. These values are observability data, not storage quotas, and do not provide content drilldown.

## Configure signatures and email design {icon="pencil"}

Under **Settings > Writing**, create private or mailbox signatures and snippets. Assign the mailbox default signature under **Accounts & identities > Sending identities**. A collaborator's personal default under **Writing** takes precedence.

Markdown messages always receive the built-in readable email design. **Email design** adds validated mailbox CSS overrides for company branding; it does not replace the safe base design. Use the composer Preview to verify the rendered result before relying on a CSS change.

## Configure automatic responses and references {icon="settings"}

Open **Mailbox tools > Automations**:

:::steps
1. **Overview** shows what is active and opens the exact setup task.
2. **Automatic replies** offers Out of office, Office-hours acknowledgement, Reference acknowledgement, and Custom presets. Writers can use this section when the Access policy permits it.
3. **Incoming mail** provides guided matching and a mixed Mail/AI step flow.
4. **Activity** shows mailbox-scoped workflow runs and incoming-automation backfills.
5. **Workflows** contains versioned YAML definitions, reference-number configuration, and explicit activation controls.
:::

Incoming mail, Activity, and Workflows require mailbox-admin access. Automatic-reply timing is stored directly in the guided reply or in the immutable YAML workflow version; there is no separate schedule resource to keep in sync.

An automatic reply has an enabled state, verified automation sender, subject, body, Markdown or plain-text format, repeat interval per recipient, time zone, active dates, weekly windows, exceptions, and behavior outside the active window:

- **Do not reply** ignores messages outside the schedule.
- **Reply at the next active time** defers the response until the schedule becomes active.

Preview the exact response before enabling it. Pausing the mailbox stops automatic replies.

For setup steps, schedule consequences, reference patterns, and repeat protection, see [Automate responses and mailbox work](/app/mail/help/mail-automation).

## Manage workflows {icon="route"}

Open **Automations > Workflows** for the YAML editor. Saving creates a new immutable version; it does not activate that version automatically. Review the YAML, validation diagnostics, and effect budgets before explicitly activating a version. Inspect mailbox executions separately under **Automations > Activity**.

Use the dedicated automatic-reply UI for normal out-of-office or acknowledgement needs. Use workflows when the mailbox needs deterministic conditions and actions beyond that editor.

See [Mail workflow YAML reference](/app/mail/help/mail-workflows) for all supported inputs, triggers, actions, conditions, expressions, defaults, and validated examples.

## Delete and restore a mailbox {icon="point"}

**Danger zone > Move to recently deleted** moves the mailbox into a recoverable deleted state. Provider mail and retained Cloud data are not purged.

Deleted mailboxes appear under **Recently deleted** on the Mail overview for administrators who can restore them. A restored mailbox starts paused. Verify the connection, folder discovery, and health under **Mailbox tools > Mailbox health** before selecting **Resume mailbox**.
