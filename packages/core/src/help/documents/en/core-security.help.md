---
id: core-security
title: Sign-in & security
icon: ti ti-shield-lock
description: Sign in, recover access, pair a sign-in app, and protect passkeys, API keys, and sessions.
order: 112
---

Your sign-in methods depend on your account provider and the platform settings. Use the method that Cloud offers for your account. Do not create a duplicate account.

## Sign in and recover access {icon="shield-lock"}

Cloud has three account types. Your organization can give **Login** another name.

:::reference
- **Guest:** Starts with an email link.
- **Login:** Starts with the app when app sign-in is configured. The email link stays available as an alternative.
- **FreeIPA:** Starts with your password.
:::

When app sign-in is configured, **Guest** and **FreeIPA** can also sign in with the app. After a FreeIPA sign-in with the app, this browser opens FreeIPA with the app next time. Local accounts do not use passwords.

An existing passkey keeps working while your account type is allowed. If your account type is hidden, use your invitation link or your direct sign-in link. A hidden account type is not the same as disabled access. If your access is disabled, ask your administrator.

- Use the normal sign-in form for the provider of your account.
- Use a passkey when you already registered one and your browser or device supports it.
- Request password recovery only for an account with a recoverable password.
- Use the link from the most recent recovery message. Older or used links can stop working.
- If the expected sign-in method is missing, ask an administrator to check your account provider.

## Pair a sign-in app {icon="device-mobile"}

Your administrator must enable and configure app sign-in first. If **Sign-in** shows **Enabled — setup required**, the administrator still has to finish the app configuration. Use your existing sign-in method until then.

:::warning Keep the pairing link to yourself
The link expires after five minutes. Do not share it outside this setup.
:::

:::steps
1. Open **Profile settings → Sign-in → Pair a device**.
2. Scan the QR code, or copy the pairing link into the app.
3. Return to Cloud and compare the six-digit codes.
4. Only if the codes match, choose **The codes match — pair device**.
5. Keep the app open until it confirms the pairing.
:::

## Sign in with the app {icon="device-mobile"}

:::steps
1. Select your account type.
2. If the page shows **Use the app instead**, choose it.
3. Enter your email or username.
4. Choose **Sign in with app**.
5. Open the paired app.
6. Approve only the request that you started, and only with the matching code.
:::

When Cloud supplies browser details, the app shows them above the code:

- Browser, system, and start time in your phone's time zone.
- **Approximately {city}, {country}** and **Network: …**, only when Cloud's location database knows the address. The network names the operator.
- **Same internet address as this phone**, only when true. Its absence says nothing.
- **Known browser · since …** or **Cloud does not know this browser yet**. Neither appears during the first 14 days after the update. Known means “signed in here before”, not “safe”.
- A known browser in a new country gets a calm note about country history. A new browser can get **Did you start this sign-in?**. This warning requires no sign-in from that country in the last 90 days and existing sign-in countries for your account. A younger history uses its start date. **Deny** is then the main button, with **Approve anyway** available.

Only passkeys are phishing-resistant. A phishing page can relay the app's code. A nearby proxy can match place and network.

Without the app, local accounts can still use an email link, and FreeIPA accounts can use their password. Existing passkeys stay available.

After sign-in, Cloud asks you to accept its terms and acknowledge the privacy policy if you have not done so yet. Confirm to continue, or cancel to sign out.

If the result of a sign-in is unclear, reload the page to check your session, or start a new request.

## New sign-in notice {icon="bell"}

After a successful sign-in, Cloud sends **New sign-in from a new browser** once for each new browser. This starts 14 days after the upgrade. It does not apply to the mobile app.

The notice shows the browser and time. The email also shows the sign-in method and the approximate place, when available.

If this was not you, check your paired devices under **Profile settings → Sign-in**. Then contact your administrator.

By default, Cloud sends the notice by email. Without an email address, it sends a browser notification. To turn it off, open **Profile settings → Notifications** and clear every channel under **New sign-in from a new browser**.

## Check and revoke paired devices {icon="device-mobile"}

**Paired devices** shows the name of each device, when it was paired and last used, and whether an administrator helped with the pairing. Rename a device, or revoke a device that you no longer control. A revoked device cannot approve new sign-ins, but existing sessions stay signed in. These controls stay available when app sign-in is disabled.

If you lost your device and cannot sign in, ask an administrator to revoke it.

:::warning A password reset also revokes your paired devices
When you reset your password with **Reset password** on the sign-in page, Cloud revokes all your paired devices. Any other sign-out from all sessions of your account does the same. Pair your devices again afterwards.
:::

Pairing, renaming, and revoking can ask you to confirm your identity. Sign in with the same account, without signing out first. Pairing then opens again automatically.

## Protect your account {icon="shield-lock"}

:::warning Never share recovery links or API keys
Anyone with a valid recovery link or an active API key can possibly act with its access. Do not paste them into support messages, screenshots, or documentation.
:::

- Register passkeys only on devices that you control. Give them recognizable names, and remove passkeys for devices that you no longer have.
- Check your recent account activity for unexpected changes or unknown credential use.
- Treat API keys like passwords. Give each integration its own key with an expiry date, and revoke the key when you retire the integration.
- Check the browser and the account before you approve a sensitive action.
