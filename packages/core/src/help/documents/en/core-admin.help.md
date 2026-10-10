---
id: core-admin
title: Administration
icon: ti ti-settings
description: Use the administration overview, publish announcements, change Core settings, and rotate app credentials.
order: 120
---

The Core administration pages configure platform services. They also link to the administration pages that each app registers.

The account settings link to the matching English guide with **Documentation**. The guide opens in a new tab. In **Settings → General**, **Documentation website** selects the public documentation, your own mirror, or your local Fibel server. This setting changes only the documentation links. It does not configure app sign-in, and the built-in Help stays independent of it.

## Find the administration pages {icon="user-cog"}

:::reference
- **Overview:** Lists the registered apps with administration pages. It also counts the registered apps, the administration pages that you can open, and the navigation entries that people see.
- **App credentials:** Create a named credential that one app uses for background calls to other apps. User mandates still limit the actions that the credential can take.
- **Announcements:** Create and edit announcements or banners. An entry is active, scheduled, or expired, depending on its publish time and expiry time.
- **Settings:** Edit the settings by group. Each field shows its current value. It also shows the source of the value where the settings service provides it.
:::

## Control account types and sign-in {icon="settings"}

In **Accounts & sign-in → Sign-in**, you configure the account types **Guest**, **Login**, and **FreeIPA** separately. **Login** is the passwordless local account. Rename it with **Login account label**, for example to Company account.

:::reference
- **Guest accounts allowed**, **Login accounts allowed**, **FreeIPA accounts allowed:** Control access.
- **Show Guest in login**, **Show Login in login**, **Show FreeIPA in login:** Control only the general sign-in page. A hidden, allowed account can still use direct links.
:::

If only one account type is visible, the sign-in page opens its form without a selector. Guest self-registration is a separate decision.

:::warning Keep a way in before you disable your own account type
Keep another allowed administrator or your emergency token available.
:::

Disabling an account type denies later requests from existing sessions, user OAuth tokens, personal API keys, and user-bound background work. It does not delete accounts or stop FreeIPA sync. Allowing the type again makes credentials work again if they are otherwise valid. Emergency recovery explicitly allows all local **Login** accounts again. It does not change which types the sign-in page shows.

## Find the other settings groups {icon="settings"}

:::reference
- **Settings → General:** Branding, public links, and global schedules.
- **Accounts & sign-in → Registration & requests:** Guest self-registration, FreeIPA access requests, account defaults, expiry, and reminders. On a new installation, requests are off until you turn them on. An upgrade keeps the earlier behavior. When you turn off new requests, pending requests stay available for processing.
- **Follow-up notices:** In **Registration & requests**, set an optional Liquid-Markdown notice for successful user or group changes. Use `action` to choose the instructions for each change, and check the preview with sample data. Empty output adds no notice. The notice is an instruction for the administrator or group manager who made the change, not a notification to the user. Cloud has no built-in NFS instructions.
- **Accounts & sign-in → Operations:** Open filtered lifecycle logs, FreeIPA sync logs, or scheduled jobs. Maintenance repairs account expiry dates, not Linux identities, and can restore access for expired accounts. A toast confirms that the job is queued. Check its logs to see when it finishes. Single records and request processing stay in Accounts.
- **Accounts & sign-in → Linux identities:** Reserve an ID range and set defaults for home and shell. While assignment is on, new local full accounts and promoted guests get Linux attributes automatically. Turning it on does not change older full accounts; use **Backfill existing accounts** for them. Turning assignment off hides the backfill table and keeps existing identities in Accounts. Linux identities do not enable computer sign-in or sudo.
- **Accounts & sign-in → FreeIPA:** FreeIPA connection settings, sync rules, and group mapping.
- **AI:** Configure model profiles and provider credentials, and check background work. Use **Skills** or **Projects** to restore access when nobody has **Manage** access to a shared resource any more. These recovery pages can give access or permanently delete resources that are no longer needed. An app does not install a deleted app Skill again until you choose **Restore**.
- **Settings → Outgoing mail** and **Settings → PDF rendering:** SMTP delivery, sender credentials, the Gotenberg connection and its credentials, and render limits.
- **Settings → Email templates**, **Settings → Security**, and **Settings → Legal:** Transactional email templates, rate limits, defaults for access protection, Terms of Service, Privacy Policy, and Imprint.
:::

## Sign in as the first administrator {icon="key"}

On a fresh installation, the operator sets a temporary `ADMIN_LOGIN_TOKEN` for Core only.

:::steps
1. Open `/auth/login?method=admin`.
2. Enter the token.
3. Review and accept the legal documents that Cloud shows. This completes the first sign-in.
4. Configure the normal administrator sign-in.
5. Check that the normal administrator sign-in works.
6. Ask the operator to remove the token and restart Core.
:::

Configure FreeIPA and its administrator group mapping in the settings. Cloud has no environment bootstrap for FreeIPA.

## Rotate an app credential {icon="key"}

**App credentials** lists the existing credentials in a table.

:::steps
1. In **App credentials**, choose **Create credential**.
2. In the dialog, select the **Application**.
3. Enter the **Name** and, if needed, the expiry time.
4. Choose **Create credential** in the dialog.
5. Copy the token. Cloud shows it only once; afterwards only its metadata and **Revoke** stay available.
6. Give the token only to the owning app, as `CLOUD_APP_CREDENTIAL`, through the secret store of the deployment.
7. Set Core's private address in `CLOUD_CORE_INTERNAL_ORIGIN`. Background calls need it.
8. Apply the change and check the background work of the app.
9. Choose **Revoke** for the old credential and confirm in the dialog.
:::

Revoking stops new calls with that credential.
