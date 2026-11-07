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

## Change your password {icon="shield-lock"}

For a FreeIPA account, open **Sign-in** in your account, choose **Change password**, and enter your current password. Cloud then signs you out everywhere else: in other browsers, in the Cloud app, in the command line, and in connected apps. Run `cld login` again to reconnect the command line.

This browser stays signed in. Your paired sign-in devices stay paired. API keys and passkeys keep working.

Setting a new password on the sign-in page, for example with a reset link or after an expired password, also signs you out everywhere else. If Cloud cannot sign out your other sign-ins, it says so. After an expired password, choose **Try again** before you continue. After a reset link, request a new reset link.

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
5. If you already have a paired device on this Cloud, open the app on it and approve the pairing.
6. Keep the new app open until it confirms the pairing.
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

- Browser, system, and start time in your device's time zone.
- **Approximately {city}, {country}** and **Network: …**, only when Cloud's location database knows the address. The network names the operator.
- **Same internet address as this device**, only when true. Its absence says nothing.
- **Known browser · since …** or **Cloud does not know this browser yet**. Neither appears during the first 14 days after the update. Known means “signed in here before”, not “safe”.
- A known browser in a new country gets a calm note about country history. A new browser can get **Did you start this sign-in?**. This warning requires no sign-in from that country in the last 90 days and existing sign-in countries for your account. A younger history uses its start date. **Deny** is then the main button, with **Approve anyway** available.

Only passkeys are phishing-resistant. A phishing page can relay the app's code. A nearby proxy can match place and network.

Without the app, local accounts can still use an email link, and FreeIPA accounts can use their password. Existing passkeys stay available.

After sign-in, Cloud asks you to accept its terms and acknowledge the privacy policy if you have not done so yet. Confirm to continue, or cancel to sign out.

If the result of a sign-in is unclear, reload the page to check your session, or start a new request.

## New sign-in notice {icon="bell"}

After a successful sign-in, Cloud sends **New sign-in from a new browser** once for each new browser. This starts 14 days after the upgrade. It does not apply to the Cloud app.

The notice shows the browser and time. The email also shows the sign-in method and the approximate place, when available.

If this was not you, check your paired devices under **Profile settings → Sign-in**. Then contact your administrator.

By default, Cloud sends the notice by email. Without an email address, it sends a browser notification. To turn it off, open **Profile settings → Notifications** and clear every channel under **New sign-in from a new browser**.

## Check and revoke paired devices {icon="device-mobile"}

**Paired devices** shows the name of each device, when it was paired and last used, and whether an administrator helped with the pairing. Rename a device, or revoke a device that you no longer control. Removing a device needs approval in the app on a paired device. The device that you remove can approve this, but it cannot deny it. The device stays active until approval. You can also end the sign-ins it approved; this is selected by default. Your requesting session, other devices’ sign-ins, and sessions with no device link stay signed in. Sessions issued before this update have no device link. A revoked device cannot approve new sign-ins. While app sign-in is disabled, you can still rename devices; an administrator revokes them.

If you cannot use any paired device, ask an administrator to revoke the old device and help pair a replacement. Ask an administrator as well when a device you do not recognize denies your removal requests. Administrator-assisted pairing and removal do not need approval on a paired device.

:::warning A password reset also revokes your paired devices
When you reset your password with **Reset password** on the sign-in page, Cloud revokes all your paired devices. Any other sign-out from all sessions of your account does the same. Pair your devices again afterwards. Changing your password under **Sign-in** keeps your paired devices.
:::

Pairing, renaming, and revoking can ask you to confirm your identity. Sign in with the same account, without signing out first. Pairing then opens again automatically.

## Confirm new access {icon="shield-lock"}

Create personal API keys under **Developer → API keys** and passkeys under
**Sign-in → Passkeys** in a browser. Your browser sign-in must be from the last
ten minutes. If Cloud asks you to confirm your identity, sign in again with the
same account, without signing out first. The dialog then opens again.

When you connect the command line using the browser flow of `cld login`, Cloud
always asks for consent. Other apps requesting lasting access need the
same recent confirmation. A **New access** notice names the command line or
app and the time. If this was not you, contact your administrator.

## Protect your account {icon="shield-lock"}

:::warning Never share recovery links or API keys
Anyone with a valid recovery link or an active API key can possibly act with its access. Do not paste them into support messages, screenshots, or documentation.
:::

- Register passkeys only on devices that you control. Give them recognizable names, and remove passkeys for devices that you no longer have.
- Check your recent account activity for unexpected changes or unknown credential use.
- Treat API keys like passwords. Give each integration its own key with an expiry date, and revoke the key when you retire the integration.
- Check the browser and the account before you approve a sensitive action.
