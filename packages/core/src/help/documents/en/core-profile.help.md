---
id: core-profile
title: Profile
icon: ti ti-user-circle
description: Review your account, groups, and activity, request FreeIPA access, and use API keys and passkeys.
updated: 2026-11-26
order: 110
---

Your account area combines local Cloud data, optional FreeIPA data, and the actions that you can take for yourself.

## Review your account {icon="paperclip"}

:::reference
- **Profile:** The first row shows how long your account is valid, your passkeys, groups, and API keys. **Profile and contact details** shows email, phone, and address; **Account facts** shows the account type, extra roles, SSH keys, and password expiry when available.
- **Groups and access:** Shows the groups you manage and the groups you are a member of. **Show inherited** adds the memberships that come through the group hierarchy.
- **Groups and access → FreeIPA account:** A local account can request FreeIPA access when account requests, the FreeIPA connection, and FreeIPA accounts are all enabled. You can still withdraw a pending request after new requests are turned off.
- **Activity → Open approvals:** Shows your waiting Action requests across apps. You can approve or reject them here. Each request links to the chat that waits for it.
- **Activity → Sign-ins and changes:** Shows security-relevant account activity for the last 7, 30, or 90 days. **Activity → Deliveries** shows where your notifications went.
:::

## Protect sign-in and automation {icon="shield-lock"}

:::reference
- **Security & devices → API keys:** Personal keys for automation. A key with **Full access** has the same access as your account. When your administrator offers the OpenAI-compatible API, you can choose **AI models only** instead: such a key can only call the AI models you may use in Assistant, for example from a dictation app. Cloud shows the full key only once, right after you create it.
- **Security & devices → Passkeys:** WebAuthn passkeys for passkey sign-in to your account. After you remove a passkey, nobody can sign in with it.
:::

Create API keys and passkeys under **Security & devices** in the
browser. Your browser sign-in must be from the last ten minutes. If Cloud asks
you to confirm your identity, sign in again with the same account. The dialog
then opens again. The Cloud app, command-line sign-in, and existing API keys cannot
create personal API keys or passkeys.

## Choose your appearance {icon="palette"}

The profile menu shows your current appearance as one entry. Choose it to
switch to the next: **Automatic**, **Light**, **Dark**, then **Automatic**
again. The menu stays open. Automatic is the default. It follows your
device's light or dark setting.

## Hide your content with the privacy screen {icon="eye-off"}

The privacy screen hides your content when someone looks over your shoulder.
It locks nothing. It hides the whole screen, the app bar included.

:::reference
- **Now:** In the profile menu, choose **Privacy screen**, or press **Ctrl+.**
  (**⌘+.** on a Mac). The shortcut also works while a dialog is open.
- **Automatically:** When you do not use Cloud for two minutes, Cloud hides
  your content. Under **Profile → At your screen**, choose another
  time or **Off** for **Hide automatically**. The setting applies on every
  computer where you sign in.
- **Countdown:** Ten seconds before, a symbol with a ring that empties shows
  above your profile. Any key or mouse movement stops the privacy screen.
- **Continue working:** Press a key or choose any place on the page. The page
  does not get this input. A mouse movement only lights up the hint.
:::

The privacy screen applies to all Cloud tabs of this browser. A running
dictation and the progress of an upload stay visible. Cloud does not hide
notifications of the operating system. Phones and tablets without a mouse or
touchpad have no privacy screen.
